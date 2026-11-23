use std::fs::File;
use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use sanctum_device_contract::{
    Capabilities, DeviceState, Indicate, Light, LightKind, Lit, Screen, Status,
};
use serde::Serialize;

use crate::pattern::{pattern, recording, state_name, unit};

const TICK: Duration = Duration::from_millis(20);
const PERIOD: Duration = Duration::from_secs(1);
const DARK: Lit = Lit {
    on: false,
    brightness: 0,
    rgb: [0; 3],
};
type Levels = (f32, [f32; 8]);

#[derive(Default)]
struct Shared {
    levels: Mutex<Option<Levels>>,
    update: Mutex<Option<Status>>,
    fault: Mutex<Option<io::Error>>,
}

impl Shared {
    fn fault(&self) -> Option<io::Error> {
        self.fault
            .lock()
            .unwrap()
            .as_ref()
            .map(|err| io::Error::new(err.kind(), err.to_string()))
    }
}

type Change = (Status, Sender<io::Result<()>>);

pub struct Indicator {
    capabilities: Capabilities,
    changes: Option<Sender<Change>>,
    last_state: Mutex<Option<DeviceState>>,
    shared: Arc<Shared>,
    thread: Option<JoinHandle<()>>,
}

impl Indicator {
    pub fn new(
        light: Option<(Box<dyn Light>, LightKind)>,
        screen: Option<Box<dyn Screen>>,
        log: Option<PathBuf>,
    ) -> Self {
        let capabilities = Capabilities {
            screen: screen.is_some(),
            light: light.as_ref().map_or(LightKind::None, |(_, kind)| *kind),
        };
        let shared = Arc::new(Shared::default());
        let (changes, receiver) = mpsc::channel();
        let worker_shared = Arc::clone(&shared);
        let thread = thread::Builder::new()
            .name("sanctum-indicator".into())
            .spawn(move || {
                let log = match log.map(File::create).transpose() {
                    Ok(log) => log,
                    Err(err) => {
                        *worker_shared.fault.lock().unwrap() = Some(err);
                        return;
                    }
                };
                let outputs = Outputs {
                    light: light.map(|(light, _)| light),
                    screen,
                    log,
                    start: Instant::now(),
                    logged: None,
                };
                run(receiver, &worker_shared, outputs);
            });
        let thread = match thread {
            Ok(thread) => Some(thread),
            Err(err) => {
                *shared.fault.lock().unwrap() = Some(err);
                None
            }
        };
        Self {
            capabilities,
            changes: Some(changes),
            last_state: Mutex::new(None),
            shared,
            thread,
        }
    }
}

impl Indicate for Indicator {
    fn show(&self, status: Status) -> io::Result<()> {
        let mut last = self.last_state.lock().unwrap();
        let state = status.state;
        if *last == Some(state) {
            if let Some(err) = self.fault() {
                return Err(err);
            }
            *self.shared.update.lock().unwrap() = Some(status);
            return Ok(());
        }
        *self.shared.update.lock().unwrap() = None;
        let (reply, result) = mpsc::channel();
        let stopped = || {
            self.fault()
                .unwrap_or_else(|| io::Error::other("The indicator worker stopped"))
        };
        self.changes
            .as_ref()
            .expect("The sender stays open until drop")
            .send((status, reply))
            .map_err(|_| stopped())?;
        let result = result.recv().map_err(|_| stopped())?;
        if result.is_ok() {
            *last = Some(state);
        }
        result
    }

    fn level(&self, level: f32, bands: [f32; 8]) {
        if let Ok(mut levels) = self.shared.levels.try_lock() {
            *levels = Some((level, bands));
        }
    }

    fn fault(&self) -> Option<io::Error> {
        self.shared.fault().or_else(|| {
            self.thread
                .as_ref()
                .is_some_and(|worker| worker.is_finished())
                .then(|| io::Error::other("The indicator worker stopped"))
        })
    }

    fn capabilities(&self) -> Capabilities {
        self.capabilities
    }
}

impl Drop for Indicator {
    fn drop(&mut self) {
        drop(self.changes.take());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn change_delay(previous: DeviceState, next: DeviceState, elapsed: Duration) -> Duration {
    if recording(previous) && recording(next) && previous != next {
        until_boundary(elapsed, PERIOD)
    } else {
        Duration::ZERO
    }
}

fn until_boundary(elapsed: Duration, period: Duration) -> Duration {
    period - Duration::from_nanos((elapsed.as_nanos() % period.as_nanos()) as u64)
}

fn run(receiver: Receiver<Change>, shared: &Shared, mut outputs: Outputs) {
    let mut current: Option<Frame> = None;
    let mut pending = None;
    loop {
        let command = if let Some(frame) = &current {
            let wake = pending
                .as_ref()
                .map_or(frame.tick, |(at, _, _)| frame.tick.min(*at));
            receiver.recv_timeout(wake.saturating_duration_since(Instant::now()))
        } else {
            receiver.recv().map_err(|_| RecvTimeoutError::Disconnected)
        };
        let now = Instant::now();
        match command {
            Err(RecvTimeoutError::Disconnected) => break,
            Ok((status, reply)) => {
                let delay = current.as_ref().map_or(Duration::ZERO, |frame| {
                    change_delay(
                        frame.status.state,
                        status.state,
                        now.duration_since(frame.entered),
                    )
                });
                pending = Some((now + delay, status, reply));
            }
            Err(RecvTimeoutError::Timeout) => {}
        }
        if pending.as_ref().is_some_and(|(at, _, _)| *at <= now) {
            let (at, status, reply) = pending.take().unwrap();
            let result = apply_change(&mut current, status, at, now, shared, &mut outputs);
            let _ = reply.send(result);
        } else if let Some(frame) = current.as_mut().filter(|frame| now >= frame.tick) {
            frame.render(now, shared, &mut outputs);
        }
    }
    if let Some(light) = outputs.light.as_mut() {
        let _ = light.set(DARK);
    }
}

struct Frame {
    status: Status,
    entered: Instant,
    tick: Instant,
}

impl Frame {
    fn render(&mut self, now: Instant, shared: &Shared, outputs: &mut Outputs) {
        if let Some(next) = shared.update.lock().unwrap().take() {
            if self.status.state == DeviceState::Unpaired && self.status.code != next.code {
                self.entered = now;
            }
            self.status = next;
        }
        let elapsed = now.duration_since(self.entered);
        if let Err(err) = outputs.frame(&mut self.status, shared, elapsed, false) {
            shared.fault.lock().unwrap().get_or_insert(err);
        }
        self.tick = now + until_boundary(elapsed, TICK);
    }
}

fn apply_change(
    current: &mut Option<Frame>,
    mut status: Status,
    entered: Instant,
    now: Instant,
    shared: &Shared,
    outputs: &mut Outputs,
) -> io::Result<()> {
    let active = recording(status.state);
    if active && let Some(err) = shared.fault() {
        return Err(err);
    }
    let entering = active
        && current
            .as_ref()
            .is_none_or(|frame| !recording(frame.status.state));
    if !active || entering {
        *shared.levels.lock().unwrap() = None;
    }
    let result = outputs.frame(&mut status, shared, now.duration_since(entered), entering);
    if result.is_ok() || !entering {
        let entered = if entering { Instant::now() } else { entered };
        *current = Some(Frame {
            status,
            entered,
            tick: entered + TICK,
        });
    } else if let Some(light) = outputs.light.as_mut() {
        let _ = light.set(DARK);
    }
    *shared.fault.lock().unwrap() = result.err();
    shared.fault().map_or(Ok(()), Err)
}

struct Outputs {
    light: Option<Box<dyn Light>>,
    screen: Option<Box<dyn Screen>>,
    log: Option<File>,
    start: Instant,
    logged: Option<(DeviceState, bool)>,
}

impl Outputs {
    fn frame(
        &mut self,
        status: &mut Status,
        shared: &Shared,
        elapsed: Duration,
        entering: bool,
    ) -> io::Result<()> {
        if recording(status.state)
            && let Some((level, bands)) = *shared.levels.lock().unwrap()
        {
            status.level = level;
            status.bands = bands;
        }
        status.level = unit(status.level);
        status.bands = status.bands.map(unit);
        let lit = pattern(
            status.state,
            elapsed.as_millis() as u64,
            status.level,
            status.code.as_deref(),
        );
        self.write_outputs(status, lit, entering)?;
        self.log_frame(status.state, lit.on && self.light.is_some())
    }

    fn write_outputs(&mut self, status: &Status, lit: Lit, entering: bool) -> io::Result<()> {
        if entering {
            if let Some(screen) = self.screen.as_mut() {
                // A kiosk can wait for a viewer. Do not hold an idle pulse on while it waits.
                if let Some(light) = self.light.as_mut() {
                    light.set(DARK)?;
                }
                screen.show(status)?;
            }
            if let Some(light) = self.light.as_mut() {
                light.set(lit)?;
            }
        } else {
            let light = self.light.as_mut().map_or(Ok(()), |light| light.set(lit));
            let screen = self
                .screen
                .as_mut()
                .map_or(Ok(()), |screen| screen.show(status));
            light.and(screen)?;
        }
        Ok(())
    }

    fn log_frame(&mut self, state: DeviceState, lit: bool) -> io::Result<()> {
        let key = (state, lit);
        if let Some(log) = self.log.as_mut()
            && self.logged != Some(key)
        {
            #[derive(Serialize)]
            struct Entry {
                t_ms: u128,
                state: &'static str,
                lit: bool,
            }
            serde_json::to_writer(
                &mut *log,
                &Entry {
                    t_ms: self.start.elapsed().as_millis(),
                    state: state_name(state),
                    lit,
                },
            )?;
            log.write_all(b"\n")?;
            self.logged = Some(key);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::*;
    use sanctum_device_contract::DeviceState::*;

    #[test]
    fn show_waits_for_the_first_frame_and_level_does_not_wait_for_a_write() {
        struct ScreenGate(Sender<Status>, Receiver<()>);
        impl Screen for ScreenGate {
            fn show(&mut self, status: &Status) -> io::Result<()> {
                self.0.send(status.clone()).unwrap();
                self.1.recv().map_err(io::Error::other)
            }
        }
        let (frame, frames) = mpsc::channel();
        let (release, gate) = mpsc::channel();
        let indicator = Arc::new(Indicator::new(
            None,
            Some(Box::new(ScreenGate(frame, gate))),
            None,
        ));
        let (reply, result) = mpsc::channel();
        let caller = Arc::clone(&indicator);
        thread::spawn(move || reply.send(caller.show(status(Listening))).unwrap());
        assert_eq!(frames.recv_timeout(PERIOD).unwrap().state, Listening);
        assert_eq!(result.try_recv().unwrap_err(), mpsc::TryRecvError::Empty);
        indicator.level(0.5, [0.25; 8]);
        release.send(()).unwrap();
        result.recv_timeout(PERIOD).unwrap().unwrap();
        assert_eq!(frames.recv_timeout(PERIOD).unwrap().bands, [0.25; 8]);
        // Dropping the sender unblocks subsequent frames while the worker shuts down.
        drop(release);
    }

    #[test]
    fn the_log_records_rendered_states_and_light_edges() {
        struct AlwaysOn;
        impl Light for AlwaysOn {
            fn set(&mut self, _: Lit) -> io::Result<()> {
                Ok(())
            }
        }
        let dir = Scratch::new();
        let log = dir.0.join("events.jsonl");
        let indicator = Indicator::new(
            Some((Box::new(AlwaysOn), LightKind::Mono)),
            None,
            Some(log.clone()),
        );
        indicator.show(status(Listening)).unwrap();
        indicator.show(status(Stopped)).unwrap();
        drop(indicator);
        let text = std::fs::read_to_string(log).unwrap();
        let events: Vec<serde_json::Value> = text
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["state"], "listening");
        assert_eq!(events[0]["lit"], true);
        assert_eq!(events[1]["state"], "stopped");
        assert_eq!(events[1]["lit"], false);
    }

    #[test]
    fn every_ordered_pair_preserves_the_sampled_light_rules() {
        let states = [
            Unpaired,
            Stopped,
            Starting,
            Listening,
            Reconnecting,
            Degraded,
            Paused,
            Error,
        ];
        for before in states {
            for after in states {
                for request in (1000..2000).step_by(20) {
                    check_transition(before, after, request);
                }
            }
        }
    }

    fn check_transition(before: DeviceState, after: DeviceState, request: u64) {
        let boundary = request
            + change_delay(before, after, Duration::from_millis(request)).as_millis() as u64;
        if recording(before) && recording(after) && before != after {
            assert_eq!(boundary, 2000);
        }
        let mut samples = [false; 50];
        let mut lit_count = 0;
        let mut recording_ticks = 0;
        let mut bad_run = 0;
        for (i, time) in (0..boundary + 2000).step_by(20).enumerate() {
            let (state, phase) = if time < boundary || before == after {
                (before, time)
            } else {
                (after, time - boundary)
            };
            let on = pattern(state, phase, 0.0, Some("1234-5678")).on;
            let active = recording(state);
            if time == boundary && recording(before) != active {
                bad_run = 0;
            }
            let slot = i % samples.len();
            lit_count += i32::from(on) - i32::from(samples[slot]);
            samples[slot] = on;
            recording_ticks = if active { recording_ticks + 1 } else { 0 };
            bad_run = if on != active { bad_run + 1 } else { 0 };
            assert!(
                bad_run <= if active { 7 } else { 15 },
                "{before:?} to {after:?} at {time}"
            );
            if recording_ticks >= 50 {
                assert!(lit_count >= 40, "{before:?} to {after:?} at {time}");
            }
        }
    }
}
