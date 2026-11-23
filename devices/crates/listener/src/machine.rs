use crate::{
    Config, RunError,
    api::{Api, Error, Heartbeat},
    archive::{Archive, CHUNK_PCM, Upload},
    audio::{Audio, End, Pcm},
    pair::{self, Credential},
    stream::{Event, Live, Stop},
    wire::{DeviceCapabilities, Start},
};
use sanctum_device_contract::{DeviceState as State, Indicate, Status};
use serde_json::json;
use signal_hook::{
    SigId,
    consts::{SIGINT, SIGTERM, SIGUSR1},
    flag, low_level,
};
use std::{
    fs::{DirBuilder, File, OpenOptions},
    io,
    os::{
        fd::AsRawFd,
        unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt},
    },
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering::Relaxed},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};
use uuid::Uuid;

const TICK: Duration = Duration::from_millis(10);
const HEARTBEAT: Duration = Duration::from_secs(15);
const RETRY: Duration = Duration::from_secs(2);
const ERROR_RETRY: Duration = Duration::from_secs(10);

#[derive(Default)]
pub(crate) struct Signals {
    stop: Arc<AtomicBool>,
    pause: Arc<AtomicBool>,
    ids: Vec<SigId>,
    #[cfg(test)]
    heartbeat: Option<Duration>,
}

impl Signals {
    pub fn install() -> io::Result<Self> {
        let mut signals = Self::default();
        for signal in [SIGTERM, SIGINT] {
            signals
                .ids
                .push(flag::register(signal, signals.stop.clone())?);
        }
        signals
            .ids
            .push(flag::register(SIGUSR1, signals.pause.clone())?);
        Ok(signals)
    }

    fn stopped(&self) -> bool {
        self.stop.load(Relaxed)
    }

    fn heartbeat_interval(&self) -> Duration {
        #[cfg(test)]
        if let Some(interval) = self.heartbeat {
            return interval;
        }
        HEARTBEAT
    }

    pub fn wait_until(&self, deadline: Instant) -> bool {
        while !self.stopped() {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return false;
            }
            thread::sleep(remaining.min(TICK));
        }
        true
    }
}

impl Drop for Signals {
    fn drop(&mut self) {
        for id in self.ids.drain(..) {
            low_level::unregister(id);
        }
    }
}

struct Display {
    status: Status,
    indicator: Arc<dyn Indicate>,
}

impl Display {
    fn show(&mut self, state: State, cause: Option<&str>) -> Result<(), RunError> {
        if state != State::Unpaired {
            self.status.code = None;
            self.status.verification_uri = None;
        }
        self.status.state = state;
        self.status.cause = cause.map(str::to_owned);
        self.indicator
            .show(self.status.clone())
            .map_err(RunError::Indicator)
    }
}

pub(crate) fn run(
    config: Config,
    api: Api,
    caps: DeviceCapabilities,
    indicator: Arc<dyn Indicate>,
    signals: &Signals,
) -> Result<(), RunError> {
    let _lock = lock_state(&config)?;
    let mut credential = Credential::load(&config.state_dir, api.origin())?;
    let mut display = Display {
        status: Status {
            state: State::Unpaired,
            name: config.name.clone(),
            level: 0.0,
            bands: [0.0; 8],
            code: None,
            verification_uri: None,
            cause: None,
            saved_through: None,
            owner: None,
        },
        indicator,
    };
    let mut skipped = 0;
    loop {
        if signals.stopped() {
            return Ok(());
        }
        let mut current = match credential.take() {
            Some(current) => current,
            None => match pair::pair(
                &api,
                &config.name,
                caps,
                |code, uri| {
                    display.status.code = Some(code);
                    display.status.verification_uri = Some(uri);
                    display.show(State::Unpaired, None)
                },
                |deadline| signals.wait_until(deadline),
            ) {
                Ok(Some(issued)) => {
                    issued.save(&config.state_dir)?;
                    issued
                }
                Ok(None) => {
                    display.show(State::Stopped, None)?;
                    return Ok(());
                }
                Err(error) => {
                    display.show(State::Error, Some(&error.to_string()))?;
                    return Err(error);
                }
            },
        };
        display.status.code = None;
        display.status.verification_uri = None;
        display.status.owner = Some(current.owner());
        display.status.saved_through = None;
        display.show(State::Starting, None)?;
        if paired(
            &config,
            &api,
            caps,
            &mut current,
            &mut display,
            signals,
            &mut skipped,
        )? {
            return Ok(());
        }
    }
}

fn revoke(config: &Config, display: &mut Display) -> Result<(), RunError> {
    Credential::remove(&config.state_dir)?;
    display.status.owner = None;
    display.status.saved_through = None;
    display.show(State::Unpaired, None)
}

fn lock_state(config: &Config) -> io::Result<File> {
    DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&config.state_dir)?;
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
        .open(&config.state_dir)?;
    if file.metadata()?.permissions().mode() & 0o022 != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "The state directory must not allow writes by other users.",
        ));
    }
    // SAFETY: the open directory descriptor stays valid as long as the lock is held.
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(file)
}

struct Capture {
    audio: Audio,
    live: Live,
    start: Start,
    pcm: Vec<u8>,
    next_sample: u64,
    sequence: u32,
    status: State,
    asr_degraded: bool,
    accepted: bool,
}

impl Capture {
    fn push(&mut self, frame: Pcm, archive: &mut Archive) -> io::Result<()> {
        if self.pcm.len() == CHUNK_PCM {
            self.flush(archive)?;
        }
        self.pcm.extend_from_slice(&frame.bytes[..frame.len]);
        let samples = (frame.len / 2) as u64;
        self.live.push(self.sequence, self.next_sample, frame);
        self.sequence += 1;
        self.next_sample += samples;
        if self.pcm.len() == CHUNK_PCM {
            self.flush(archive)?;
        }
        Ok(())
    }

    fn flush(&mut self, archive: &mut Archive) -> io::Result<()> {
        archive.queue(
            &self.start,
            self.next_sample - (self.pcm.len() / 2) as u64,
            &self.pcm,
        )?;
        self.pcm.clear();
        Ok(())
    }

    fn displayed(&self, archive_behind: bool) -> (State, Option<&'static str>) {
        if self.status == State::Reconnecting {
            (State::Reconnecting, None)
        } else if archive_behind {
            (
                State::Degraded,
                Some("Recording on this device. Upload is behind."),
            )
        } else if self.asr_degraded {
            (
                State::Degraded,
                Some("Live transcription is not available."),
            )
        } else {
            (State::Listening, None)
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Next {
    Close,
    Pause,
    LeaseLost,
    Restart,
    Revoke,
    Error(&'static str),
}

impl Next {
    fn state(self) -> (State, Option<&'static str>) {
        match self {
            Self::Close | Self::LeaseLost | Self::Restart => (State::Stopped, None),
            Self::Pause => (State::Paused, None),
            Self::Revoke => (State::Unpaired, None),
            Self::Error(cause) => (State::Error, Some(cause)),
        }
    }
}

fn stream_event(capture: &mut Capture, event: Event) -> Option<Next> {
    match event {
        Event::Accepted => {
            capture.status = State::Listening;
            capture.asr_degraded = false;
            capture.accepted = true;
        }
        Event::Lost => capture.status = State::Reconnecting,
        Event::Degraded => capture.asr_degraded = true,
        Event::Recovered => capture.asr_degraded = false,
        Event::LeaseLost => return Some(Next::LeaseLost),
        Event::EpochClosed => return Some(Next::Restart),
        Event::Unauthorized => return Some(Next::Revoke),
        Event::Invalid => return Some(Next::Error("The server rejected the audio stream.")),
    }
    None
}

fn paired(
    config: &Config,
    api: &Api,
    caps: DeviceCapabilities,
    credential: &mut Credential,
    display: &mut Display,
    signals: &Signals,
    skipped: &mut u64,
) -> Result<bool, RunError> {
    let listener = loop {
        if signals.stopped() {
            display.show(State::Stopped, None)?;
            return Ok(true);
        }
        if let Some(listener) = credential.listener_id {
            break listener;
        }
        match api.register(&credential.access_token, &config.name, caps) {
            Ok(listener) => {
                credential.listener_id = Some(listener);
                credential.save(&config.state_dir)?;
                break listener;
            }
            Err(Error::Status(401)) => {
                revoke(config, display)?;
                return Ok(false);
            }
            Err(Error::Status(408 | 429)) => {
                signals.wait_until(Instant::now() + RETRY);
            }
            Err(Error::Status(400..=499) | Error::InvalidResponse) => {
                return Err(io::Error::other("The server refused listener registration.").into());
            }
            Err(_) => {
                signals.wait_until(Instant::now() + RETRY);
            }
        }
    };
    let archive = Archive::open(
        &config.state_dir,
        credential.device_id,
        config.max_buffer_mb,
    )?;
    let mut session = Session {
        archive,
        upload: None,
        upload_due: Instant::now(),
        upload_behind: false,
        lease: Lease::new(listener),
        capture: None,
        retry: Instant::now(),
        reason: "start",
        paused: false,
    };
    let device = Device {
        config,
        api,
        caps,
        credential,
        signals,
    };
    loop {
        let (next, saved) = session.poll(&device, display, skipped)?;
        if let Some(next) = next
            && let Some(exit) = session.transition(&device, display, skipped, next)?
        {
            return Ok(exit);
        }
        session.schedule_upload(&device)?;
        if let Some(next) = session.refresh(&device, display, *skipped, saved)?
            && let Some(exit) = session.transition(&device, display, skipped, next)?
        {
            return Ok(exit);
        }
        thread::sleep(TICK);
    }
}

struct Device<'a> {
    config: &'a Config,
    api: &'a Api,
    caps: DeviceCapabilities,
    credential: &'a Credential,
    signals: &'a Signals,
}

struct Session {
    archive: Archive,
    upload: Option<Upload>,
    upload_due: Instant,
    upload_behind: bool,
    lease: Lease,
    capture: Option<Capture>,
    retry: Instant,
    reason: &'static str,
    paused: bool,
}

impl Session {
    fn poll(
        &mut self,
        device: &Device,
        display: &mut Display,
        skipped: &mut u64,
    ) -> Result<(Option<Next>, bool), RunError> {
        let (upload, saved) = self.poll_upload(display);
        let lease = self.lease.poll(self.capture.is_some(), self.paused);
        let live = self.capture.as_mut().and_then(Capture::poll_live);
        if [upload, lease, live].contains(&Some(Next::Revoke)) {
            return Ok((Some(Next::Revoke), saved));
        }
        if device.signals.stopped() {
            return Ok((Some(Next::Close), saved));
        }
        let pause = self.poll_pause(device.signals, display)?;
        let next = live.or(lease).or(pause).or_else(|| {
            self.capture
                .as_mut()
                .and_then(|c| c.poll_audio(&mut self.archive, skipped, &*display.indicator))
        });
        if next.is_none() {
            self.lease.schedule(
                device,
                display.status.state,
                self.capture.as_ref(),
                self.archive.len(),
            )?;
        }
        Ok((next, saved))
    }

    fn poll_pause(
        &mut self,
        signals: &Signals,
        display: &mut Display,
    ) -> Result<Option<Next>, RunError> {
        if !signals.pause.swap(false, Relaxed) {
            return Ok(None);
        }
        self.paused = !self.paused;
        if self.paused {
            return Ok(Some(Next::Pause));
        }
        display.show(State::Starting, None)?;
        self.retry = Instant::now();
        self.reason = "resume";
        Ok(None)
    }

    fn poll_upload(&mut self, display: &mut Display) -> (Option<Next>, bool) {
        if !self.upload.as_ref().is_some_and(Upload::is_finished) {
            return (None, false);
        }
        match self.archive.finish_upload(self.upload.take().unwrap()) {
            Ok(saved) => {
                self.upload_behind = self.archive.len() != 0;
                if let Some(saved) = saved {
                    display.status.saved_through = Some(saved);
                    return (None, true);
                }
                (None, false)
            }
            Err(Error::Status(401)) => (Some(Next::Revoke), false),
            Err(_) => {
                self.upload_behind = true;
                self.upload_due = Instant::now() + RETRY;
                (None, false)
            }
        }
    }

    fn schedule_upload(&mut self, device: &Device) -> io::Result<()> {
        if self.upload.is_none() && Instant::now() >= self.upload_due {
            let epoch = self
                .capture
                .as_ref()
                .map(|c| (c.start.epoch_id, c.accepted));
            self.upload = self
                .archive
                .start_upload(device.api, device.credential, epoch)?;
        }
        Ok(())
    }

    fn transition(
        &mut self,
        device: &Device,
        display: &mut Display,
        skipped: &mut u64,
        next: Next,
    ) -> Result<Option<bool>, RunError> {
        let mut capture = self.capture.take();
        if let Some(capture) = &mut capture {
            capture.audio.close();
            if next == Next::Revoke {
                capture.live.close(Stop::Abort);
            }
        }
        let (state, cause) = next.state();
        let shown = if next == Next::Revoke {
            revoke(device.config, display)
        } else {
            display.show(state, cause)
        };
        if let Some(capture) = capture {
            capture.finish(next, &mut self.archive, skipped)?;
        }
        if state != State::Error {
            shown?;
        }
        self.after_transition(device, display, next)
    }

    fn after_transition(
        &mut self,
        device: &Device,
        display: &mut Display,
        next: Next,
    ) -> Result<Option<bool>, RunError> {
        match next {
            Next::Revoke => return Ok(Some(false)),
            Next::Close => {
                let authorized = self.flush_uploads(device)?;
                if !authorized {
                    revoke(device.config, display)?;
                }
                return Ok(Some(authorized));
            }
            Next::Pause => return Ok(None),
            Next::LeaseLost => {
                self.lease.retry();
                self.retry = self.lease.due;
            }
            Next::Restart => self.retry = Instant::now(),
            Next::Error(_) => self.retry = Instant::now() + ERROR_RETRY,
        }
        self.reason = "stream_restart";
        Ok(None)
    }

    fn flush_uploads(&mut self, device: &Device) -> io::Result<bool> {
        loop {
            let job = match self.upload.take() {
                Some(job) => Some(job),
                None => self
                    .archive
                    .start_upload(device.api, device.credential, None)?,
            };
            let Some(job) = job else {
                return Ok(true);
            };
            match self.archive.finish_upload(job) {
                Ok(_) => {}
                Err(Error::Status(401)) => return Ok(false),
                Err(_) => return Ok(true),
            }
        }
    }

    fn refresh(
        &mut self,
        device: &Device,
        display: &mut Display,
        skipped: u64,
        saved: bool,
    ) -> Result<Option<Next>, RunError> {
        if let Some(capture) = &self.capture {
            let (state, cause) = capture.displayed(self.upload_behind);
            if (saved || display.status.state != state || display.status.cause.as_deref() != cause)
                && display.show(state, cause).is_err()
            {
                return Ok(Some(Next::Error("The recording indicator failed.")));
            }
        } else if self.lease.owned && !self.paused && Instant::now() >= self.retry {
            return self.start_capture(device, display, skipped);
        }
        Ok(None)
    }

    fn start_capture(
        &mut self,
        device: &Device,
        display: &mut Display,
        skipped: u64,
    ) -> Result<Option<Next>, RunError> {
        if !self.archive.has_space() {
            return Ok(Some(Next::Error("The recording buffer is full.")));
        }
        if (display.status.state != State::Starting && display.show(State::Starting, None).is_err())
            || display.show(State::Listening, None).is_err()
            || display.indicator.fault().is_some()
        {
            return Ok(Some(Next::Error("The recording indicator failed.")));
        }
        if device.signals.stopped() {
            return Ok(Some(Next::Close));
        }
        let start = Start::new(
            self.lease.listener,
            self.lease.generation,
            device.caps,
            self.reason,
        );
        let Ok(audio) = Audio::open(&device.config.input, skipped, display.indicator.clone())
        else {
            return Ok(Some(Next::Error("Cannot open the audio input.")));
        };
        let live = Live::open(device.api, &device.credential.access_token, start.clone())?;
        self.capture = Some(Capture {
            audio,
            live,
            start,
            pcm: Vec::with_capacity(CHUNK_PCM),
            next_sample: 0,
            sequence: 0,
            status: State::Listening,
            asr_degraded: false,
            accepted: false,
        });
        Ok(None)
    }
}

struct Lease {
    listener: Uuid,
    generation: u64,
    owned: bool,
    due: Instant,
    heartbeat: Option<thread::JoinHandle<Result<Heartbeat, Error>>>,
}

impl Lease {
    fn new(listener: Uuid) -> Self {
        Self {
            listener,
            generation: 0,
            owned: false,
            due: Instant::now(),
            heartbeat: None,
        }
    }

    fn retry(&mut self) {
        self.owned = false;
        self.due = Instant::now() + RETRY;
    }

    fn poll(&mut self, active: bool, paused: bool) -> Option<Next> {
        if !self
            .heartbeat
            .as_ref()
            .is_some_and(thread::JoinHandle::is_finished)
        {
            return None;
        }
        match self
            .heartbeat
            .take()
            .unwrap()
            .join()
            .unwrap_or(Err(Error::Transport))
        {
            Ok(receipt) => {
                let changed = self.generation != receipt.lease_generation;
                self.generation = receipt.lease_generation;
                self.owned = receipt.owner;
                ((!receipt.owner && !paused) || (active && changed)).then_some(Next::LeaseLost)
            }
            Err(Error::Status(401)) => Some(Next::Revoke),
            Err(_) => {
                if !active {
                    self.retry();
                }
                None
            }
        }
    }

    fn schedule(
        &mut self,
        device: &Device,
        state: State,
        capture: Option<&Capture>,
        chunks: usize,
    ) -> io::Result<()> {
        let now = Instant::now();
        if self.heartbeat.is_some() || now < self.due {
            return Ok(());
        }
        self.due = now + device.signals.heartbeat_interval();
        let request = json!({
            "lease_generation": self.generation,
            "state": heartbeat_state(state),
            "epoch_id": capture.map(|c| c.start.epoch_id),
            "buffered_chunks": chunks,
            "storage_bytes_free": null,
        });
        let (api, token, listener) = (
            device.api.clone(),
            device.credential.access_token.clone(),
            self.listener,
        );
        self.heartbeat = Some(
            thread::Builder::new()
                .name("listener-lease".into())
                .spawn(move || api.heartbeat(&token, listener, request))?,
        );
        Ok(())
    }
}

fn heartbeat_state(state: State) -> &'static str {
    match state {
        State::Unpaired | State::Error | State::Stopped => "stopped",
        State::Starting => "starting",
        State::Listening => "listening",
        State::Paused => "paused",
        State::Reconnecting => "reconnecting",
        State::Degraded => "degraded",
    }
}

impl Capture {
    fn poll_live(&mut self) -> Option<Next> {
        while let Ok(event) = self.live.events.try_recv() {
            if let Some(next) = stream_event(self, event) {
                return Some(next);
            }
        }
        None
    }

    fn poll_audio(
        &mut self,
        archive: &mut Archive,
        skipped: &mut u64,
        indicator: &dyn Indicate,
    ) -> Option<Next> {
        if indicator.fault().is_some() {
            return Some(Next::Error("The recording indicator failed."));
        }
        loop {
            match self.audio.frames.try_recv() {
                Ok(frame) => {
                    *skipped += (frame.len / 2) as u64;
                    if self.push(frame, archive).is_err() || !archive.has_space() {
                        return Some(Next::Error(
                            "The recording buffer is full or cannot be written.",
                        ));
                    }
                }
                Err(mpsc::TryRecvError::Empty) => return None,
                Err(mpsc::TryRecvError::Disconnected) => {
                    return Some(audio_end(self.audio.close()));
                }
            }
        }
    }

    fn finish(mut self, next: Next, archive: &mut Archive, skipped: &mut u64) -> io::Result<()> {
        if self.accepted {
            archive.mark_accepted(self.start.epoch_id);
        }
        if next != Next::Revoke {
            while let Ok(frame) = self.audio.frames.try_recv() {
                if !archive.has_space() && self.pcm.is_empty() {
                    break;
                }
                *skipped += (frame.len / 2) as u64;
                self.push(frame, archive)?;
            }
        }
        self.flush(archive)?;
        self.live.close(match next {
            Next::Close => Stop::Close,
            Next::Pause => Stop::Pause,
            _ => Stop::Interrupted,
        });
        Ok(())
    }
}

fn audio_end(end: End) -> Next {
    match end {
        End::Eof => Next::Close,
        End::Fault => Next::Error("The recording indicator failed."),
        End::Backlog => Next::Error("The device cannot keep up with the audio input."),
        _ => Next::Error("The audio input stopped unexpectedly."),
    }
}

#[cfg(test)]
mod tests;
