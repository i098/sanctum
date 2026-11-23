use super::*;
use crate::{Input, wire::wav_header};
use sanctum_device_contract::{Capabilities, LightKind};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{Mutex, atomic::AtomicUsize},
};
use tungstenite::{
    Message, accept_hdr,
    handshake::server::{Request, Response},
};

const ID: &str = "0b8f5c1e-3a52-4c1b-9d0e-5f7a2b6c8d90";
const OTHER: &str = "6c1d4e2f-8a3b-4c5d-9e6f-7a8b9c0d1e2f";
const TOKEN: &str = "fixture-token";
const CAPS: Capabilities = Capabilities {
    screen: true,
    light: LightKind::None,
};

struct Scratch(PathBuf);
impl Scratch {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("sanctum-listener-{}", Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[derive(Default)]
struct Indicator {
    states: Mutex<Vec<Status>>,
    fault: AtomicBool,
    no_indicator: bool,
    on_show: Option<Box<dyn Fn(State) + Send + Sync>>,
}
impl Indicate for Indicator {
    fn show(&self, status: Status) -> io::Result<()> {
        if let Some(action) = &self.on_show {
            action(status.state);
        }
        self.states.lock().unwrap().push(status);
        Ok(())
    }
    fn level(&self, _: f32, _: [f32; 8]) {}
    fn fault(&self) -> Option<io::Error> {
        self.fault
            .load(Relaxed)
            .then(|| io::Error::other("Test light failed."))
    }
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            screen: !self.no_indicator,
            ..CAPS
        }
    }
}

fn fixture(dir: &Path, samples: u32) -> Vec<u8> {
    let mut wav = wav_header(samples).to_vec();
    for i in 0..samples {
        wav.extend_from_slice(&((i % 101) as i16 * 257 - 12_000).to_le_bytes());
    }
    fs::write(dir.join("fixture.wav"), &wav).unwrap();
    wav
}

#[derive(Clone, Copy, PartialEq)]
enum Case {
    Resume,
    NeverAccepted,
    EpochClosed,
    Revoke,
    RevokeBeforeCapture,
    LeaseLost,
    Normal,
}

struct Server {
    url: String,
    stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
    log: Arc<Log>,
}

#[derive(Default)]
struct Log {
    sockets: AtomicUsize,
    pulses: AtomicUsize,
    starts: Mutex<Vec<Value>>,
    frames: Mutex<Vec<(usize, u64)>>,
    uploads: Mutex<Vec<(Value, Vec<u8>)>>,
}

impl Server {
    fn new(case: Case) -> Self {
        let listen = TcpListener::bind("127.0.0.1:0").unwrap();
        listen.set_nonblocking(true).unwrap();
        let url = format!("http://{}", listen.local_addr().unwrap());
        let pairing_address = format!("{url}/pair");
        let stop = Arc::new(AtomicBool::new(false));
        let shutdown = stop.clone();
        let log = Arc::new(Log::default());
        let worker_log = log.clone();
        let worker = thread::spawn(move || {
            thread::scope(|scope| {
                while !shutdown.load(Relaxed) {
                    match listen.accept() {
                        Ok((tcp, _)) => {
                            let log = &worker_log;
                            let pair = &pairing_address;
                            scope.spawn(move || serve(tcp, pair, log, case));
                        }
                        Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(2))
                        }
                        Err(e) => panic!("{e}"),
                    }
                }
            })
        });
        Self {
            url,
            stop,
            worker: Some(worker),
            log,
        }
    }

    fn config(&self, dir: &Path) -> Config {
        Config {
            server: self.url.clone(),
            state_dir: dir.into(),
            name: "Fixture listener".into(),
            input: Input::File(dir.join("fixture.wav")),
            max_buffer_mb: 8,
            speaker: false,
        }
    }

    fn credential(&self, dir: &Path) {
        Credential {
            server: self.url.clone(),
            access_token: TOKEN.into(),
            device_id: OTHER.parse().unwrap(),
            listener_id: Some(ID.parse().unwrap()),
            approved_by_name: "Fixture owner".into(),
            workspace_name: "Fixture workspace".into(),
        }
        .save(dir)
        .unwrap();
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Relaxed);
        let result = self.worker.take().unwrap().join();
        if !thread::panicking() {
            result.unwrap();
        }
    }
}

fn serve(tcp: TcpStream, pair: &str, log: &Log, case: Case) {
    tcp.set_read_timeout(Some(Duration::from_secs(4))).unwrap();
    let mut prefix = [0; 4];
    loop {
        match tcp.peek(&mut prefix).unwrap() {
            0 => return,
            4 => break,
            _ => thread::sleep(TICK),
        }
    }
    if &prefix == b"GET " {
        serve_socket(tcp, log, case);
    } else {
        serve_http(tcp, pair, log, case);
    }
}

fn serve_socket(tcp: TcpStream, log: &Log, case: Case) {
    let mut socket = accept_hdr(tcp, |request: &Request, response: Response| {
        assert_eq!(request.headers()["authorization"], "Bearer fixture-token");
        assert!(!request.headers().contains_key("origin"));
        Ok(response)
    })
    .unwrap();
    let start: Value = serde_json::from_str(socket.read().unwrap().to_text().unwrap()).unwrap();
    assert_eq!(start["listener_id"], ID);
    assert_eq!(
        start["capabilities"],
        json!({"mic": true, "screen": true, "light": "none", "speaker": false})
    );
    assert!(
        start["clock"]["captured_at"]
            .as_str()
            .unwrap()
            .split('.')
            .nth(1)
            .is_none_or(|fraction| fraction.len() <= 7)
    );
    log.starts.lock().unwrap().push(start.clone());
    let index = log.sockets.fetch_add(1, Relaxed);
    let archive = start["archive_only"] == true;
    if !archive && case == Case::NeverAccepted {
        return;
    }
    if case == Case::EpochClosed && index == 0 {
        socket
            .send(Message::Text(
                json!({"_tag":"rejected","reason":"epoch_closed","message":"closed"})
                    .to_string()
                    .into(),
            ))
            .unwrap();
        return;
    }
    let watermark = if case == Case::Resume && index == 1 {
        48_000
    } else {
        0
    };
    socket.send(Message::Text(json!({"_tag":"accepted","epoch_id":start["epoch_id"],"resume_from_sample":watermark,"max_frame_bytes":19_224}).to_string().into())).unwrap();
    if archive {
        return;
    }
    receive_audio(&mut socket, log, case, index);
}

fn receive_audio(
    socket: &mut tungstenite::WebSocket<TcpStream>,
    log: &Log,
    case: Case,
    index: usize,
) {
    let mut count = 0;
    while let Ok(message) = socket.read() {
        match message {
            Message::Binary(frame) => {
                assert_eq!(&frame[..2], &[1, 1]);
                let sample = u64::from_le_bytes(frame[8..16].try_into().unwrap());
                log.frames.lock().unwrap().push((index, sample));
                count += 1;
                if case == Case::Resume && index == 0 {
                    return;
                }
                if case == Case::Resume && index == 1 && (count == 1 || count == 10) {
                    let tag = if count == 1 { "degraded" } else { "recovered" };
                    if socket
                        .send(Message::Text(json!({"_tag":tag}).to_string().into()))
                        .is_err()
                    {
                        break;
                    }
                }
            }
            Message::Text(text) => {
                assert_eq!(
                    serde_json::from_str::<Value>(&text).unwrap()["_tag"],
                    "stop"
                );
                break;
            }
            _ => {}
        }
    }
}

fn serve_http(tcp: TcpStream, pair: &str, log: &Log, case: Case) {
    let mut reader = BufReader::new(tcp);
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    let path = line.split_whitespace().nth(1).unwrap().to_owned();
    let (mut length, mut manifest, mut auth) = (0, None, None);
    loop {
        line.clear();
        reader.read_line(&mut line).unwrap();
        if line == "\r\n" {
            break;
        }
        let (header, value) = line.split_once(':').unwrap();
        match header.to_ascii_lowercase().as_str() {
            "content-length" => length = value.trim().parse().unwrap(),
            "x-sanctum-manifest" => manifest = Some(serde_json::from_str::<Value>(value).unwrap()),
            "authorization" => auth = Some(value.trim().to_owned()),
            _ => {}
        }
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body).unwrap();
    if path.starts_with("/api/v1/listeners") {
        assert_eq!(auth.as_deref(), Some("Bearer fixture-token"));
    }
    let (status, reply) = match path.as_str() {
        "/api/v1/device/authorize" => (
            200,
            json!({"device_code":"fixture-device","user_code":"1234-5678","verification_uri":pair,"expires_in":600,"interval":5}),
        ),
        "/api/v1/device/token" => {
            assert_eq!(
                serde_json::from_slice::<Value>(&body).unwrap()["device_code"],
                "fixture-device"
            );
            (
                200,
                json!({"access_token":TOKEN,"token_type":"Bearer","device_id":OTHER,"approved_by_name":"Fixture owner","workspace_name":"Fixture workspace"}),
            )
        }
        "/api/v1/listeners" => (201, json!({"id":ID})),
        _ if path.ends_with("/heartbeat") => heartbeat_reply(log, case, &body),
        _ => {
            let manifest = manifest.unwrap();
            let epoch = &manifest["epoch_id"];
            assert!(
                log.starts
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|start| &start["epoch_id"] == epoch
                        && (case != Case::NeverAccepted || start["archive_only"] == true))
            );
            let hash = format!("{:x}", Sha256::digest(&body));
            assert_eq!(manifest["sha256"], hash);
            let reply = json!({"chunk_id":manifest["chunk_id"],"sha256":hash,"byte_length":body.len(),"committed_at":"2026-09-26T17:08:22Z"});
            log.uploads.lock().unwrap().push((manifest, body));
            (200, reply)
        }
    };
    let mut tcp = reader.into_inner();
    let reply = reply.to_string();
    write!(tcp, "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}", reply.len()).unwrap();
}

fn heartbeat_reply(log: &Log, case: Case, body: &[u8]) -> (u32, Value) {
    let count = log.pulses.fetch_add(1, Relaxed);
    let request: Value = serde_json::from_slice(body).unwrap();
    if count == 0 {
        assert_eq!(request["lease_generation"], 0);
    }
    if (case == Case::Revoke && count == 1) || case == Case::RevokeBeforeCapture {
        return (401, json!({}));
    }
    let generation = if case == Case::LeaseLost && count >= 2 {
        2
    } else {
        1
    };
    (
        200,
        json!({"lease_generation": generation, "owner": case != Case::LeaseLost || count != 1}),
    )
}

fn states(indicator: &Indicator) -> Vec<State> {
    indicator
        .states
        .lock()
        .unwrap()
        .iter()
        .map(|s| s.state)
        .collect()
}

fn execute(
    server: &Server,
    dir: &Path,
    indicator: Arc<Indicator>,
    signals: &Signals,
) -> Result<(), RunError> {
    run(
        server.config(dir),
        Api::new(&server.url).unwrap(),
        DeviceCapabilities::new(CAPS, false),
        indicator,
        signals,
    )
}

#[test]
fn pairs_reconnects_at_the_watermark_and_archives_the_gap() {
    let server = Server::new(Case::Resume);
    let dir = Scratch::new();
    let wav = fixture(&dir.0, 80_000);
    let indicator = Arc::new(Indicator::default());
    crate::run(server.config(&dir.0), indicator.clone()).unwrap();
    let stored = fs::metadata(dir.0.join("credential.json")).unwrap();
    assert_eq!(stored.permissions().mode() & 0o777, 0o600);
    let indications = indicator.states.lock().unwrap();
    assert_eq!(indications[0].code.as_deref(), Some("1234-5678"));
    assert!(indications[1].code.is_none());
    assert!(indications[1].verification_uri.is_none());
    assert_eq!(
        indications[1].owner.as_ref().unwrap().approved_by_name,
        "Fixture owner"
    );
    let steps: Vec<_> = indications.iter().map(|s| s.state).collect();
    assert!(steps.starts_with(&[State::Unpaired, State::Starting]));
    assert!(
        steps
            .windows(3)
            .any(|s| s == [State::Listening, State::Reconnecting, State::Listening])
    );
    assert!(
        steps
            .windows(2)
            .any(|s| s == [State::Degraded, State::Listening])
    );
    assert_eq!(steps.last(), Some(&State::Stopped));
    let starts = server.log.starts.lock().unwrap();
    assert_eq!(starts.len(), 2);
    assert_eq!(starts[0], starts[1]);
    let frames = server.log.frames.lock().unwrap();
    assert!(
        frames
            .iter()
            .any(|&(socket, sample)| socket == 1 && sample == 48_000)
    );
    assert!(
        frames
            .iter()
            .filter(|(socket, _)| *socket == 1)
            .all(|&(_, sample)| sample >= 48_000)
    );
    let uploads = server.log.uploads.lock().unwrap();
    assert_eq!(uploads.len(), 1);
    assert_eq!(uploads[0].1, wav);
}

#[test]
fn unaccepted_epoch_registers_before_upload_and_closed_epoch_changes_id() {
    for case in [Case::NeverAccepted, Case::EpochClosed] {
        let server = Server::new(case);
        let dir = Scratch::new();
        server.credential(&dir.0);
        let wav = fixture(&dir.0, 4_800);
        let indicator = Arc::new(Indicator::default());
        execute(&server, &dir.0, indicator.clone(), &Signals::default()).unwrap();
        let starts = server.log.starts.lock().unwrap();
        if case == Case::NeverAccepted {
            let archive = starts
                .iter()
                .find(|start| start["archive_only"] == true)
                .unwrap();
            assert_eq!(starts[0]["epoch_id"], archive["epoch_id"]);
            assert_eq!(archive["sample_end"], 4_800);
        } else {
            let live: Vec<_> = starts
                .iter()
                .filter(|start| start["archive_only"].is_null())
                .collect();
            assert_ne!(live[0]["epoch_id"], live[1]["epoch_id"]);
            assert!(
                states(&indicator)
                    .windows(3)
                    .any(|s| s == [State::Stopped, State::Starting, State::Listening])
            );
        }
        let bytes: Vec<u8> = server
            .log
            .uploads
            .lock()
            .unwrap()
            .iter()
            .flat_map(|(_, wav)| wav[44..].iter().copied())
            .collect();
        assert_eq!(bytes, wav[44..]);
    }
}

#[test]
fn refuses_capture_without_visible_indicator() {
    let dir = Scratch::new();
    let config = Config {
        server: "invalid server".into(),
        state_dir: dir.0.join("missing"),
        name: "Test".into(),
        input: Input::Cmd("false".into()),
        max_buffer_mb: 1,
        speaker: false,
    };
    let result = crate::run(
        config,
        Arc::new(Indicator {
            no_indicator: true,
            ..Indicator::default()
        }),
    );
    assert!(matches!(result, Err(RunError::NoIndicator)));
    assert!(!dir.0.join("missing").exists());
}

fn signals_with_heartbeat(ms: u64) -> Signals {
    Signals {
        stop: Default::default(),
        pause: Default::default(),
        ids: Vec::new(),
        heartbeat: Some(Duration::from_millis(ms)),
    }
}

#[test]
fn revocation_and_indicator_fault_close_the_process_before_display_changes() {
    for case in [Case::Revoke, Case::Normal] {
        let server = Server::new(case);
        let dir = Scratch::new();
        server.credential(&dir.0);
        let marker = dir.0.join("opened");
        let mut config = server.config(&dir.0);
        config.input = Input::Cmd(format!("echo $$ > '{}'; sleep 30", marker.display()));
        let signals = signals_with_heartbeat(350);
        let stopped = signals.stop.clone();
        let target = if case == Case::Revoke {
            State::Unpaired
        } else {
            State::Error
        };
        let indicator = Arc::new(Indicator {
            on_show: Some(Box::new(move |state| {
                if state == State::Listening {
                    assert!(!marker.exists());
                }
                if state == target {
                    let pid = fs::read_to_string(&marker).unwrap().trim().parse().unwrap();
                    // SAFETY: signal 0 only checks whether the test process exists.
                    assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
                    stopped.store(true, Relaxed);
                }
            })),
            ..Indicator::default()
        });
        let watching = indicator.clone();
        let process_marker = dir.0.join("opened");
        let watchdog = signals.stop.clone();
        let control = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(3);
            while !process_marker.exists() && Instant::now() < deadline {
                thread::sleep(TICK);
            }
            if case == Case::Normal {
                watching.fault.store(true, Relaxed);
            }
            while !watchdog.load(Relaxed) && Instant::now() < deadline {
                thread::sleep(TICK);
            }
            watchdog.store(true, Relaxed);
        });
        run(
            config,
            Api::new(&server.url).unwrap(),
            DeviceCapabilities::new(CAPS, false),
            indicator.clone(),
            &signals,
        )
        .unwrap();
        control.join().unwrap();
        assert!(states(&indicator).contains(&target));
        assert_eq!(dir.0.join("credential.json").exists(), case != Case::Revoke);
    }
}

#[test]
fn pause_resumes_and_lost_lease_stops_before_reclaim() {
    let server = Server::new(Case::LeaseLost);
    let dir = Scratch::new();
    server.credential(&dir.0);
    fixture(&dir.0, 16_000);
    let signals = signals_with_heartbeat(300);
    let pause = signals.pause.clone();
    let seen = AtomicUsize::new(0);
    let indicator = Arc::new(Indicator {
        on_show: Some(Box::new(move |state| {
            if state == State::Listening && seen.fetch_add(1, Relaxed) == 0 {
                pause.store(true, Relaxed);
            }
            if state == State::Paused {
                pause.store(true, Relaxed);
            }
        })),
        ..Indicator::default()
    });
    execute(&server, &dir.0, indicator.clone(), &signals).unwrap();
    let steps = states(&indicator);
    assert!(
        steps
            .windows(3)
            .any(|s| s == [State::Paused, State::Starting, State::Listening])
    );
    assert!(
        steps
            .windows(3)
            .any(|s| s == [State::Stopped, State::Starting, State::Listening])
    );
    assert!(
        server
            .log
            .starts
            .lock()
            .unwrap()
            .iter()
            .any(|start| start["lease_generation"] == 2)
    );
}

#[test]
fn input_error_retries_after_the_missing_file_appears() {
    let server = Server::new(Case::Normal);
    let dir = Scratch::new();
    server.credential(&dir.0);
    let base = dir.0.clone();
    let indicator = Arc::new(Indicator {
        on_show: Some(Box::new(move |state| {
            if state == State::Error {
                let mut wav = fixture(&base, 640);
                wav.splice(12..12, *b"JUNK\x01\0\0\0!\0");
                let size = (wav.len() - 8) as u32;
                wav[4..8].copy_from_slice(&size.to_le_bytes());
                fs::write(base.join("fixture.wav"), wav).unwrap();
            }
        })),
        ..Indicator::default()
    });
    execute(&server, &dir.0, indicator.clone(), &Signals::default()).unwrap();
    let steps = states(&indicator);
    assert!(
        steps
            .windows(3)
            .any(|s| s == [State::Error, State::Starting, State::Listening])
    );
    let uploaded = &server.log.uploads.lock().unwrap()[0].1;
    let original = fs::read(dir.0.join("fixture.wav")).unwrap();
    assert_eq!(uploaded[44..], original[54..]);
}

#[test]
fn revocation_before_capture_removes_credential_without_opening_input() {
    let server = Server::new(Case::RevokeBeforeCapture);
    let dir = Scratch::new();
    server.credential(&dir.0);
    let signals = Signals::default();
    let stop = signals.stop.clone();
    let indicator = Arc::new(Indicator {
        on_show: Some(Box::new(move |state| {
            if state == State::Unpaired {
                stop.store(true, Relaxed);
            }
        })),
        ..Indicator::default()
    });
    execute(&server, &dir.0, indicator.clone(), &signals).unwrap();
    assert!(states(&indicator).starts_with(&[State::Starting, State::Unpaired]));
    assert!(server.log.starts.lock().unwrap().is_empty());
    assert!(!dir.0.join("credential.json").exists());
}

#[test]
fn full_buffer_stops_capture_while_disconnected() {
    let server = Server::new(Case::NeverAccepted);
    let dir = Scratch::new();
    server.credential(&dir.0);
    let config = Config {
        max_buffer_mb: 1,
        ..server.config(&dir.0)
    };
    fixture(&dir.0, 31 * 16_000);
    let signals = Signals::default();
    let stop = signals.stop.clone();
    let indicator = Arc::new(Indicator {
        on_show: Some(Box::new(move |state| {
            if state == State::Error {
                stop.store(true, Relaxed);
            }
        })),
        ..Indicator::default()
    });
    run(
        config,
        Api::new(&server.url).unwrap(),
        DeviceCapabilities::new(CAPS, false),
        indicator.clone(),
        &signals,
    )
    .unwrap();
    let statuses = indicator.states.lock().unwrap();
    let error = statuses
        .windows(2)
        .find(|pair| pair[0].state == State::Reconnecting && pair[1].state == State::Error)
        .unwrap();
    assert!(
        error[1]
            .cause
            .as_deref()
            .unwrap()
            .contains("recording buffer is full")
    );
}
