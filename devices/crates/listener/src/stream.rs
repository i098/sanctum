use crate::{
    api::{Api, Error},
    wire::{Start, frame},
};
use serde::Deserialize;
use serde_json::json;
use std::{
    io,
    net::{TcpStream, ToSocketAddrs},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering::Relaxed},
        mpsc::{self, Receiver, SyncSender},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use tungstenite::{
    Message, WebSocket, client::IntoClientRequest, http::header::AUTHORIZATION,
    protocol::WebSocketConfig, stream::MaybeTlsStream,
};
use uuid::Uuid;

const CONNECT: Duration = Duration::from_secs(2);
const TICK: Duration = Duration::from_millis(15);
const RETRY: Duration = Duration::from_secs(2);

type Socket = WebSocket<MaybeTlsStream<TcpStream>>;

#[derive(Debug, PartialEq)]
pub(crate) enum Event {
    Accepted,
    Lost,
    Degraded,
    Recovered,
    LeaseLost,
    EpochClosed,
    Unauthorized,
    Invalid,
}

#[derive(Clone, Copy, PartialEq)]
pub(crate) enum Stop {
    Close,
    Pause,
    Interrupted,
    Abort,
}

#[derive(Deserialize)]
#[serde(tag = "_tag", rename_all = "snake_case")]
enum Control {
    Accepted {
        epoch_id: uuid::Uuid,
        resume_from_sample: u64,
        max_frame_bytes: usize,
    },
    Rejected {
        reason: String,
    },
    Degraded,
    Recovered,
    #[serde(other)]
    Other,
}

struct Frame {
    sequence: u32,
    sample_start: u64,
    pcm: crate::audio::Pcm,
}

pub(crate) struct Live {
    frames: SyncSender<Frame>,
    ready: Arc<AtomicBool>,
    pub events: Receiver<Event>,
    stop: Option<mpsc::Sender<Stop>>,
    worker: Option<JoinHandle<()>>,
}

impl Live {
    pub fn open(api: &Api, token: &str, start: Start) -> io::Result<Self> {
        let endpoint = Endpoint::new(api, token, &start);
        let (tx, rx) = mpsc::sync_channel::<Frame>(32);
        let (emit, events) = mpsc::channel();
        let (stop, cancel) = mpsc::channel();
        let ready = Arc::new(AtomicBool::new(false));
        let connected = ready.clone();
        let worker = thread::Builder::new()
            .name("listener-live".into())
            .spawn(move || {
                loop {
                    if cancel.try_recv().is_ok() {
                        break;
                    }
                    while rx.try_recv().is_ok() {}
                    let result = endpoint.start(&start);
                    let event = match result {
                        Ok((mut socket, watermark, maximum)) => {
                            if emit.send(Event::Accepted).is_err() {
                                break;
                            }
                            connected.store(true, Relaxed);
                            let event = live_loop(
                                &mut socket,
                                start.track,
                                watermark,
                                maximum,
                                &rx,
                                &cancel,
                                &emit,
                            );
                            connected.store(false, Relaxed);
                            let Some(event) = event else {
                                break;
                            };
                            event
                        }
                        Err(event) => event,
                    };
                    let retry = event == Event::Lost;
                    if emit.send(event).is_err() || !retry || cancel.recv_timeout(RETRY).is_ok() {
                        break;
                    }
                }
            })?;
        Ok(Self {
            frames: tx,
            ready,
            events,
            stop: Some(stop),
            worker: Some(worker),
        })
    }

    pub fn push(&self, sequence: u32, sample_start: u64, pcm: crate::audio::Pcm) {
        if self.ready.load(Relaxed) {
            let _ = self.frames.try_send(Frame {
                sequence,
                sample_start,
                pcm,
            });
        }
    }

    pub fn close(&mut self, reason: Stop) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(reason);
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

impl Drop for Live {
    fn drop(&mut self) {
        self.close(Stop::Interrupted);
    }
}

fn live_loop(
    socket: &mut Socket,
    track: u16,
    watermark: u64,
    maximum: usize,
    frames: &Receiver<Frame>,
    stop: &Receiver<Stop>,
    events: &mpsc::Sender<Event>,
) -> Option<Event> {
    let mut reply_at = Instant::now();
    let mut ping_at = reply_at + RETRY;
    loop {
        match send_pending(socket, track, watermark, maximum, frames, stop) {
            Ok(Some(reason)) => {
                send_stop(socket, reason);
                return None;
            }
            Ok(None) => {}
            Err(event) => return Some(event),
        }
        let now = Instant::now();
        if now.duration_since(reply_at) >= Duration::from_secs(5) {
            return Some(Event::Lost);
        }
        if now >= ping_at {
            if socket.send(Message::Ping(Default::default())).is_err() {
                return Some(Event::Lost);
            }
            ping_at = now + RETRY;
        }
        match read(socket) {
            Ok(Some(control)) => {
                reply_at = Instant::now();
                match control {
                    Control::Recovered => events.send(Event::Recovered).ok()?,
                    Control::Degraded => events.send(Event::Degraded).ok()?,
                    Control::Rejected { reason } => return Some(reject(&reason)),
                    _ => {}
                }
            }
            Ok(None) => {}
            Err(event) => return Some(event),
        }
    }
}

fn send_pending(
    socket: &mut Socket,
    track: u16,
    watermark: u64,
    maximum: usize,
    frames: &Receiver<Frame>,
    stop: &Receiver<Stop>,
) -> Result<Option<Stop>, Event> {
    let mut stopping = stop.try_recv().ok();
    for item in frames.try_iter().take(32) {
        stopping = stopping.or_else(|| stop.try_recv().ok());
        if stopping == Some(Stop::Abort) {
            break;
        }
        write_frame(socket, track, watermark, maximum, item).map_err(|_| Event::Lost)?;
    }
    Ok(stopping)
}

fn send_stop(socket: &mut Socket, reason: Stop) {
    let reason = match reason {
        Stop::Close => "close",
        Stop::Pause => "pause",
        Stop::Interrupted => "interrupted",
        Stop::Abort => return,
    };
    let _ = socket.send(Message::Text(
        json!({"_tag": "stop", "reason": reason}).to_string().into(),
    ));
}

fn write_frame(
    socket: &mut Socket,
    track: u16,
    watermark: u64,
    maximum: usize,
    item: Frame,
) -> tungstenite::Result<()> {
    let skip = watermark
        .saturating_sub(item.sample_start)
        .min((item.pcm.len / 2) as u64);
    let pcm = &item.pcm.bytes[skip as usize * 2..item.pcm.len];
    if !pcm.is_empty() && pcm.len() + 24 <= maximum {
        socket.send(Message::Binary(
            frame(track, item.sequence, item.sample_start + skip, pcm).into(),
        ))?;
    }
    Ok(())
}

pub(crate) fn register_archive(api: &Api, token: &str, start: &Start) -> Result<(), Error> {
    Endpoint::new(api, token, start)
        .start(start)
        .map(|_| ())
        .map_err(|event| match event {
            Event::Unauthorized => Error::Status(401),
            Event::LeaseLost | Event::EpochClosed | Event::Invalid => Error::ArchiveRejected,
            _ => Error::Transport,
        })
}

struct Endpoint {
    url: String,
    host: String,
    port: u16,
    token: String,
}

impl Endpoint {
    fn new(api: &Api, token: &str, start: &Start) -> Self {
        let secure = api.uri.scheme_str() == Some("https");
        let scheme = if secure { "wss" } else { "ws" };
        Self {
            url: format!(
                "{scheme}://{}/api/v1/listeners/{}/stream",
                api.uri.authority().unwrap(),
                start.listener_id
            ),
            host: api.uri.host().unwrap().trim_matches(['[', ']']).into(),
            port: api.uri.port_u16().unwrap_or(if secure { 443 } else { 80 }),
            token: token.into(),
        }
    }

    fn start(&self, start: &Start) -> Result<(Socket, u64, usize), Event> {
        let mut socket = self.connect()?;
        socket
            .send(Message::Text(
                serde_json::to_string(start)
                    .map_err(|_| Event::Invalid)?
                    .into(),
            ))
            .map_err(|_| Event::Lost)?;
        accept_start(socket, start.epoch_id)
    }

    fn connect(&self) -> Result<Socket, Event> {
        let mut request = self
            .url
            .as_str()
            .into_client_request()
            .map_err(|_| Event::Invalid)?;
        request.headers_mut().insert(
            AUTHORIZATION,
            format!("Bearer {}", self.token)
                .parse()
                .map_err(|_| Event::Invalid)?,
        );
        let deadline = Instant::now() + CONNECT;
        let addresses = (self.host.as_str(), self.port)
            .to_socket_addrs()
            .map_err(|_| Event::Lost)?;
        let tcp = addresses
            .filter_map(|addr| {
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    return None;
                }
                TcpStream::connect_timeout(&addr, left).ok()
            })
            .next()
            .ok_or(Event::Lost)?;
        tcp.set_read_timeout(Some(CONNECT))
            .map_err(|_| Event::Lost)?;
        tcp.set_write_timeout(Some(Duration::from_millis(250)))
            .map_err(|_| Event::Lost)?;
        tcp.set_nodelay(true).map_err(|_| Event::Lost)?;
        let limits = WebSocketConfig::default()
            .max_message_size(Some(65_536))
            .max_frame_size(Some(65_536));
        let (socket, _) = tungstenite::client_tls_with_config(request, tcp, Some(limits), None)
            .map_err(|error| match error {
                tungstenite::HandshakeError::Failure(tungstenite::Error::Http(response))
                    if response.status() == 401 =>
                {
                    Event::Unauthorized
                }
                _ => Event::Lost,
            })?;
        let tcp = match socket.get_ref() {
            MaybeTlsStream::Plain(tcp) => tcp,
            MaybeTlsStream::Rustls(tls) => &tls.sock,
            _ => return Err(Event::Invalid),
        };
        tcp.set_read_timeout(Some(TICK)).map_err(|_| Event::Lost)?;
        Ok(socket)
    }
}

fn accept_start(mut socket: Socket, expected_epoch: Uuid) -> Result<(Socket, u64, usize), Event> {
    let deadline = Instant::now() + CONNECT;
    while Instant::now() < deadline {
        match read(&mut socket)? {
            Some(Control::Accepted {
                epoch_id,
                resume_from_sample,
                max_frame_bytes,
            }) => {
                if epoch_id != expected_epoch || max_frame_bytes < 664 {
                    return Err(Event::Invalid);
                }
                return Ok((socket, resume_from_sample, max_frame_bytes));
            }
            Some(Control::Rejected { reason }) => return Err(reject(&reason)),
            _ => {}
        }
    }
    Err(Event::Lost)
}

fn reject(reason: &str) -> Event {
    match reason {
        "stale_generation" => Event::LeaseLost,
        "epoch_closed" => Event::EpochClosed,
        "unauthorized" => Event::Unauthorized,
        _ => Event::Invalid,
    }
}

fn read(socket: &mut Socket) -> Result<Option<Control>, Event> {
    match socket.read() {
        Ok(Message::Text(text)) => serde_json::from_str(&text)
            .map(Some)
            .map_err(|_| Event::Invalid),
        Ok(Message::Ping(_)) => socket
            .flush()
            .map(|()| Some(Control::Other))
            .map_err(|_| Event::Lost),
        Ok(Message::Pong(_)) => Ok(Some(Control::Other)),
        Ok(Message::Close(_)) => Err(Event::Lost),
        Ok(_) => Ok(None),
        Err(tungstenite::Error::Io(error))
            if matches!(
                error.kind(),
                io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut | io::ErrorKind::Interrupted
            ) =>
        {
            Ok(None)
        }
        Err(_) => Err(Event::Lost),
    }
}
