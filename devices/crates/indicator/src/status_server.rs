use std::fs::File;
use std::io::{self, Write};
use std::net::SocketAddr;
use std::path::{Component, Path};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use sanctum_device_contract::{DeviceState, Screen, Status};
use serde::Serialize;
use tiny_http::{Header, Method, Request, Response, Server};

use crate::pattern::{recording, state_name};

const VIEWER_TIMEOUT: Duration = Duration::from_secs(2);
const RECORDING_INTERVAL: Duration = Duration::from_millis(40);
const NO_VIEWER: &str = "No kiosk viewer received an event for two seconds";

#[derive(Default)]
struct Viewers {
    closed: bool,
    sequence: u64,
    latest: Option<Arc<Frame>>,
    last_delivery: Option<(u64, Instant)>,
    clients: [Option<u64>; 4],
}

type Stream = (Mutex<Viewers>, Condvar);

struct Frame {
    sequence: u64,
    published: Instant,
    bytes: Vec<u8>,
    confirm_start: bool,
}

pub(crate) struct Kiosk {
    server: Arc<Server>,
    stream: Arc<Stream>,
    last_state: Option<DeviceState>,
    next_event: Instant,
    recording_since: Option<Instant>,
}

impl Kiosk {
    pub(crate) fn open(root: &Path, address: SocketAddr) -> io::Result<Self> {
        if !address.ip().is_loopback() {
            return Err(crate::invalid("The kiosk needs a loopback address"));
        }
        let root = root.canonicalize()?;
        if !root.join("index.html").is_file() {
            return Err(crate::invalid("The kiosk directory needs index.html"));
        }
        let server = Arc::new(Server::http(address).map_err(io::Error::other)?);
        let host = server.server_addr().to_string();
        let stream = Arc::new(Stream::default());
        let run_server = Arc::clone(&server);
        let run_stream = Arc::clone(&stream);
        thread::Builder::new()
            .name("sanctum-kiosk".into())
            .spawn(move || {
                while let Ok(request) = run_server.recv() {
                    respond(request, &root, &host, &run_stream);
                }
            })?;
        Ok(Self {
            server,
            stream,
            last_state: None,
            next_event: Instant::now(),
            recording_since: None,
        })
    }
}

impl Drop for Kiosk {
    fn drop(&mut self) {
        self.stream.0.lock().unwrap().closed = true;
        self.stream.1.notify_all();
        self.server.unblock();
    }
}

impl Screen for Kiosk {
    fn show(&mut self, status: &Status) -> io::Result<()> {
        let now = Instant::now();
        let active = recording(status.state);
        let changed = self.last_state != Some(status.state);
        let started = active && self.recording_since.is_none();
        if !active {
            self.recording_since = None;
        }
        let (lock, wake) = &*self.stream;
        let mut viewers = lock.lock().unwrap();
        if let Some(since) = self.recording_since {
            let last = viewers
                .last_delivery
                .map_or(since, |(_, time)| since.max(time));
            if now.saturating_duration_since(last) >= VIEWER_TIMEOUT {
                return Err(io::Error::new(io::ErrorKind::TimedOut, NO_VIEWER));
            }
        }
        if !changed && now < self.next_event {
            return Ok(());
        }
        let interval = if active {
            RECORDING_INTERVAL
        } else {
            Duration::from_secs(1)
        };
        self.next_event = if changed || now >= self.next_event + interval {
            now + interval
        } else {
            self.next_event + interval
        };
        self.last_state = Some(status.state);
        viewers.sequence += 1;
        let sequence = viewers.sequence;
        viewers.latest = Some(Arc::new(Frame {
            sequence,
            published: now,
            bytes: encode_event(status)?,
            confirm_start: started,
        }));
        wake.notify_all();
        if started {
            self.recording_since = Some(now);
            // A viewer must confirm both writes before recording starts.
            let (mut guard, _) = wake
                .wait_timeout_while(viewers, VIEWER_TIMEOUT, |viewers| {
                    !viewers.clients.iter().flatten().any(|id| *id >= sequence)
                })
                .unwrap();
            if !guard.clients.iter().flatten().any(|id| *id >= sequence) {
                guard.latest = None;
                self.recording_since = None;
                self.last_state = None;
                return Err(io::Error::new(io::ErrorKind::TimedOut, NO_VIEWER));
            }
        }
        Ok(())
    }
}

fn encode_event(status: &Status) -> io::Result<Vec<u8>> {
    #[derive(Serialize)]
    struct Owner<'a> {
        approved_by_name: &'a str,
        workspace_name: &'a str,
    }
    #[derive(Serialize)]
    struct Event<'a> {
        state: &'static str,
        level: f32,
        bands: &'a [f32; 8],
        code: Option<&'a str>,
        verification_uri: Option<&'a str>,
        name: &'a str,
        cause: Option<&'a str>,
        saved_through: Option<&'a str>,
        owner: Option<Owner<'a>>,
    }
    let mut bytes = Vec::with_capacity(384);
    bytes.extend_from_slice(b"data: ");
    serde_json::to_writer(
        &mut bytes,
        &Event {
            state: state_name(status.state),
            level: status.level,
            bands: &status.bands,
            code: status.code.as_deref(),
            verification_uri: status.verification_uri.as_deref(),
            name: &status.name,
            cause: status.cause.as_deref(),
            saved_through: status.saved_through.as_deref(),
            owner: status.owner.as_ref().map(|owner| Owner {
                approved_by_name: &owner.approved_by_name,
                workspace_name: &owner.workspace_name,
            }),
        },
    )?;
    bytes.extend_from_slice(b"\n\n");
    Ok(bytes)
}

fn matches_host(value: Option<&str>, address: &str) -> bool {
    value.is_some_and(|value| value == address || address.strip_suffix(":80") == Some(value))
}

fn respond(request: Request, root: &Path, host: &str, stream: &Arc<Stream>) {
    let header = |name: &'static str| {
        request
            .headers()
            .iter()
            .find(|h| h.field.equiv(name))
            .map(|h| h.value.as_str())
    };
    if !matches_host(header("Host"), host)
        || header("Sec-Fetch-Site").is_some_and(|site| !matches!(site, "none" | "same-origin"))
        || header("Origin")
            .is_some_and(|origin| !matches_host(origin.strip_prefix("http://"), host))
    {
        let _ = request.respond(Response::empty(403));
        return;
    }
    let path = request.url().split('?').next().unwrap_or_default();
    if request.method() == &Method::Get && path == "/events" {
        if let Some(viewer) = Viewer::open(Arc::clone(stream)) {
            let _ = thread::Builder::new()
                .name("sanctum-kiosk-viewer".into())
                .spawn(move || {
                    let _ = viewer.send_events(request.into_writer());
                });
        } else {
            let _ = request.respond(Response::empty(503));
        }
        return;
    }
    if matches!(request.method(), Method::Get | Method::Head)
        && let Some((file, mime)) = asset(root, path)
    {
        let _ = request.respond(
            Response::from_file(file)
                .with_header(header_value("Content-Type", mime))
                .with_header(header_value("X-Content-Type-Options", "nosniff")),
        );
    } else {
        let _ = request.respond(Response::empty(404));
    }
}

fn header_value(name: &str, value: &str) -> Header {
    Header::from_bytes(name, value).unwrap()
}

fn asset(root: &Path, url: &str) -> Option<(File, &'static str)> {
    let path = url.strip_prefix('/')?;
    let path = if path.is_empty() { "index.html" } else { path };
    if path.contains(['%', '\\'])
        || !Path::new(path)
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
    {
        return None;
    }
    let path = root.join(path).canonicalize().ok()?;
    if !path.starts_with(root) || !path.is_file() {
        return None;
    }
    let mime = match path.extension().and_then(|ext| ext.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("woff2") => "font/woff2",
        _ => "application/octet-stream",
    };
    Some((File::open(path).ok()?, mime))
}

struct Viewer {
    stream: Arc<Stream>,
    slot: usize,
}

impl Viewer {
    fn open(stream: Arc<Stream>) -> Option<Self> {
        let mut viewers = stream.0.lock().unwrap();
        let slot = viewers.clients.iter().position(Option::is_none)?;
        viewers.clients[slot] = Some(0);
        drop(viewers);
        Some(Self { stream, slot })
    }

    fn send_events(&self, mut writer: impl Write) -> io::Result<()> {
        writer.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-store\r\nConnection: close\r\nX-Content-Type-Options: nosniff\r\n\r\n")?;
        writer.flush()?;
        let (lock, wake) = &*self.stream;
        let mut sequence = 0;
        loop {
            let viewers = wake
                .wait_while(lock.lock().unwrap(), |viewers| {
                    !viewers.closed
                        && viewers
                            .latest
                            .as_ref()
                            .is_none_or(|f| f.sequence == sequence)
                })
                .unwrap();
            if viewers.closed {
                return Ok(());
            }
            let frame = Arc::clone(viewers.latest.as_ref().unwrap());
            drop(viewers);
            writer.write_all(&frame.bytes)?;
            writer.flush()?;
            if frame.confirm_start {
                // A TCP connection can accept one write after the peer has closed it.
                thread::sleep(RECORDING_INTERVAL);
                writer.write_all(b": ready\n\n")?;
                writer.flush()?;
            }
            sequence = frame.sequence;
            let mut viewers = lock.lock().unwrap();
            viewers.clients[self.slot] = Some(sequence);
            if viewers
                .last_delivery
                .is_none_or(|(last, _)| last < sequence)
            {
                viewers.last_delivery = Some((sequence, frame.published));
            }
            wake.notify_all();
        }
    }
}

impl Drop for Viewer {
    fn drop(&mut self) {
        self.stream.0.lock().unwrap().clients[self.slot] = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Indicator, test_support::*};
    use sanctum_device_contract::{DeviceState::*, Indicate, Owner};
    use serde_json::{Value, json};
    use std::fs;
    use std::io::{BufRead, BufReader, Read};
    use std::net::{Shutdown, TcpStream};

    fn kiosk(root: &Scratch) -> Kiosk {
        fs::write(root.0.join("index.html"), "Kiosk fixture").unwrap();
        Kiosk::open(&root.0, "127.0.0.1:0".parse().unwrap()).unwrap()
    }

    fn request(host: &str, path: &str, host_header: &str) -> BufReader<TcpStream> {
        let mut client = TcpStream::connect(host).unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        write!(
            client,
            "GET {path} HTTP/1.1\r\nHost: {host_header}\r\nConnection: close\r\n\r\n"
        )
        .unwrap();
        BufReader::new(client)
    }

    fn line(client: &mut BufReader<TcpStream>) -> String {
        let mut line = String::new();
        assert_ne!(client.read_line(&mut line).unwrap(), 0);
        line
    }

    fn event(client: &mut BufReader<TcpStream>) -> Value {
        loop {
            if let Some(data) = line(client).strip_prefix("data: ") {
                return serde_json::from_str(data).unwrap();
            }
        }
    }

    #[test]
    fn serves_the_page_and_confines_asset_paths_and_hosts() {
        let root = Scratch::new();
        let kiosk = kiosk(&root);
        assert!(Kiosk::open(&root.0, "0.0.0.0:0".parse().unwrap()).is_err());
        let host = kiosk.server.server_addr().to_string();
        let mut response = String::new();
        request(&host, "/", &host)
            .read_to_string(&mut response)
            .unwrap();
        assert!(response.starts_with("HTTP/1.1 200"));
        assert!(response.ends_with("Kiosk fixture"));
        assert!(line(&mut request(&host, "/events", "untrusted.test")).contains(" 403 "));
        for path in ["/../index.html", "/%2e%2e/index.html", "//etc/passwd"] {
            assert!(line(&mut request(&host, path, &host)).contains(" 404 "));
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/dev/null", root.0.join("outside")).unwrap();
            assert!(line(&mut request(&host, "/outside", &host)).contains(" 404 "));
        }
    }

    #[test]
    fn matches_the_browser_host_on_the_default_http_port() {
        assert!(matches_host(Some("127.0.0.1"), "127.0.0.1:80"));
        assert!(matches_host(Some("127.0.0.1:80"), "127.0.0.1:80"));
        assert!(!matches_host(Some("127.0.0.1"), "127.0.0.1:7171"));
        assert!(!matches_host(Some("untrusted.test"), "127.0.0.1:80"));
        assert!(!matches_host(None, "127.0.0.1:80"));
    }

    #[test]
    fn a_viewer_lost_after_the_first_write_cannot_confirm_recording() {
        struct Disconnected(usize);
        impl Write for Disconnected {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                self.0 += 1;
                if self.0 > 2 {
                    return Err(io::ErrorKind::BrokenPipe.into());
                }
                Ok(bytes.len())
            }

            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }

        let root = Scratch::new();
        let mut kiosk = kiosk(&root);
        let viewer = Viewer::open(Arc::clone(&kiosk.stream)).unwrap();
        let worker = thread::spawn(move || viewer.send_events(Disconnected(0)));
        let result = kiosk.show(&status(Listening));
        drop(kiosk);
        assert_eq!(
            worker.join().unwrap().unwrap_err().kind(),
            io::ErrorKind::BrokenPipe
        );
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::TimedOut);
    }

    #[test]
    fn streams_wire_events_and_faults_when_the_viewer_leaves() {
        let root = Scratch::new();
        let kiosk = kiosk(&root);
        let host = kiosk.server.server_addr().to_string();
        let indicator = Indicator::new(None, Some(Box::new(kiosk)), None);
        let mut pairing = status(Unpaired);
        pairing.code = Some("0000-0000".into());
        pairing.verification_uri = Some("https://device.test/pair".into());
        indicator.show(pairing).unwrap();
        let mut viewer = request(&host, "/events", &host);
        assert!(line(&mut viewer).contains(" 200 "));
        assert_eq!(
            // Compare the entire wire object, including nullable fields and all eight bands.
            event(&mut viewer),
            json!({
                "state": "unpaired", "level": 0.0, "bands": vec![0.0; 8], "code": "0000-0000",
                "verification_uri": "https://device.test/pair", "name": "Test listener", "cause": null,
                "saved_through": null, "owner": null,
            })
        );
        let mut listening = status(Listening);
        listening.owner = Some(Owner {
            approved_by_name: "Sam".into(),
            workspace_name: "Studio".into(),
        });
        indicator.show(listening).unwrap();
        let data = event(&mut viewer);
        assert_eq!(data["state"], "listening");
        assert_eq!(
            data["owner"],
            json!({"approved_by_name": "Sam", "workspace_name": "Studio"})
        );
        let disconnected = Instant::now();
        viewer.get_ref().shutdown(Shutdown::Both).unwrap();
        drop(viewer);
        eventually(|| indicator.fault().is_some());
        assert!(disconnected.elapsed() >= Duration::from_millis(1850));
        assert_eq!(indicator.fault().unwrap().kind(), io::ErrorKind::TimedOut);
    }

    #[test]
    fn will_not_acknowledge_the_first_recording_frame_without_a_viewer() {
        let root = Scratch::new();
        let indicator = Indicator::new(None, Some(Box::new(kiosk(&root))), None);
        assert_eq!(
            indicator.show(status(Listening)).unwrap_err().kind(),
            io::ErrorKind::TimedOut
        );
    }
}
