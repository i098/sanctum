use crate::{
    Input,
    wire::{FRAME_BYTES, RATE},
};
use sanctum_device_contract::Indicate;
use std::{
    fs::{File, OpenOptions},
    io::{self, Read, Seek, SeekFrom},
    os::{
        fd::AsRawFd,
        unix::{fs::OpenOptionsExt, process::CommandExt},
    },
    process::{Child, ChildStdout, Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering::Relaxed},
        mpsc::{self, Receiver, TrySendError},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

pub(crate) struct Pcm {
    pub bytes: [u8; FRAME_BYTES],
    pub len: usize,
}

pub(crate) enum End {
    Eof,
    Stopped,
    Fault,
    Input,
    Backlog,
}

pub(crate) struct Audio {
    pub frames: Receiver<Pcm>,
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<End>>,
}

impl Audio {
    pub fn open(input: &Input, skipped: u64, indicator: Arc<dyn Indicate>) -> io::Result<Self> {
        let mut source = Source::open(input, skipped)?;
        let (tx, frames) = mpsc::sync_channel(250);
        let stop = Arc::new(AtomicBool::new(false));
        let cancel = stop.clone();
        let worker = thread::Builder::new()
            .name("listener-mic".into())
            .spawn(move || capture(&mut source, &cancel, &*indicator, &tx))?;
        Ok(Self {
            frames,
            stop,
            worker: Some(worker),
        })
    }

    pub fn close(&mut self) -> End {
        self.stop.store(true, Relaxed);
        self.worker
            .take()
            .map_or(End::Stopped, |worker| worker.join().unwrap_or(End::Input))
    }
}

impl Drop for Audio {
    fn drop(&mut self) {
        self.close();
    }
}

fn capture(
    source: &mut Source,
    cancel: &AtomicBool,
    indicator: &dyn Indicate,
    tx: &mpsc::SyncSender<Pcm>,
) -> End {
    let paced = matches!(source, Source::File { .. });
    let mut next = Instant::now();
    loop {
        if cancel.load(Relaxed) {
            return End::Stopped;
        }
        if indicator.fault().is_some() {
            return End::Fault;
        }
        if paced && let Some(left) = next.checked_duration_since(Instant::now()) {
            thread::sleep(left.min(Duration::from_millis(10)));
            continue;
        }
        let (pcm, eof) = match read_frame(source, cancel, indicator) {
            Ok(result) => result,
            Err(end) => return end,
        };
        if pcm.len != 0 {
            meter(indicator, &pcm.bytes[..pcm.len]);
            match tx.try_send(pcm) {
                Ok(()) => {}
                Err(TrySendError::Full(_)) => return End::Backlog,
                Err(TrySendError::Disconnected(_)) => return End::Stopped,
            }
            next += Duration::from_millis(20);
        }
        if eof {
            return if paced { End::Eof } else { End::Input };
        }
    }
}

fn read_frame(
    source: &mut Source,
    cancel: &AtomicBool,
    indicator: &dyn Indicate,
) -> Result<(Pcm, bool), End> {
    let mut pcm = Pcm {
        bytes: [0; FRAME_BYTES],
        len: 0,
    };
    while pcm.len < FRAME_BYTES {
        if cancel.load(Relaxed) {
            return Err(End::Stopped);
        }
        if indicator.fault().is_some() {
            return Err(End::Fault);
        }
        match source.read(&mut pcm.bytes[pcm.len..]) {
            Ok(0) if pcm.len.is_multiple_of(2) => return Ok((pcm, true)),
            Ok(0) => return Err(End::Input),
            Ok(n) => pcm.len += n,
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(5))
            }
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(_) => return Err(End::Input),
        }
    }
    Ok((pcm, false))
}

fn meter(indicator: &dyn Indicate, bytes: &[u8]) {
    let mut bands = [0.0_f32; 8];
    let samples = bytes.len() / 2;
    for (i, pair) in bytes.chunks_exact(2).enumerate() {
        let band = &mut bands[i * 8 / samples];
        *band = band.max(f32::from(i16::from_le_bytes([pair[0], pair[1]])).abs() / 32768.0);
    }
    indicator.level(bands.into_iter().fold(0.0, f32::max), bands);
}

enum Source {
    File { file: File, remaining: u64 },
    Process { child: Child, stdout: ChildStdout },
}

impl Source {
    fn open(input: &Input, skipped: u64) -> io::Result<Self> {
        let mut command = match input {
            Input::File(path) => {
                let mut file = OpenOptions::new()
                    .read(true)
                    .custom_flags(libc::O_NONBLOCK)
                    .open(path)?;
                let (offset, bytes) = wav_input(&mut file)?;
                if skipped > bytes / 2 {
                    return Err(invalid_wav());
                }
                file.seek(SeekFrom::Start(offset + skipped * 2))?;
                return Ok(Self::File {
                    file,
                    remaining: bytes - skipped * 2,
                });
            }
            Input::Alsa(device) => {
                let mut command = Command::new("arecord");
                command.args([
                    "-q", "-t", "raw", "-f", "S16_LE", "-r", "16000", "-c", "1", "-D", device,
                ]);
                command
            }
            Input::Cmd(script) => {
                let mut command = Command::new("sh");
                command.args(["-c", script]);
                command
            }
        };
        let mut child = command
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;
        let stdout = child.stdout.take().expect("stdout is piped");
        let source = Self::Process { child, stdout };
        let Self::Process { stdout, .. } = &source else {
            unreachable!()
        };
        // SAFETY: the pipe owns a valid descriptor for both calls.
        let result = unsafe {
            let fd = stdout.as_raw_fd();
            let flags = libc::fcntl(fd, libc::F_GETFL);
            if flags < 0 {
                flags
            } else {
                libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK)
            }
        };
        if result < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(source)
    }

    fn read(&mut self, target: &mut [u8]) -> io::Result<usize> {
        match self {
            Self::File { file, remaining } => {
                let limit = target.len().min(*remaining as usize);
                let n = file.read(&mut target[..limit])?;
                if n == 0 && limit != 0 {
                    return Err(io::ErrorKind::UnexpectedEof.into());
                }
                *remaining -= n as u64;
                Ok(n)
            }
            Self::Process { stdout, .. } => stdout.read(target),
        }
    }
}

fn invalid_wav() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "Use a 16 kHz mono PCM16 WAV file.",
    )
}

fn wav_input(file: &mut File) -> io::Result<(u64, u64)> {
    let meta = file.metadata()?;
    if !meta.is_file() {
        return Err(invalid_wav());
    }
    let mut main = [0; 12];
    file.read_exact(&mut main)?;
    let end = 8 + u64::from(u32::from_le_bytes(main[4..8].try_into().unwrap()));
    if &main[..4] != b"RIFF" || &main[8..] != b"WAVE" || end > meta.len() {
        return Err(invalid_wav());
    }
    let mut cursor = 12;
    let mut format = false;
    while cursor + 8 <= end {
        let mut header = [0; 8];
        file.read_exact(&mut header)?;
        let start = cursor + 8;
        let length = u64::from(u32::from_le_bytes(header[4..].try_into().unwrap()));
        cursor = start + length + (length % 2);
        if cursor > end {
            return Err(invalid_wav());
        }
        match &header[..4] {
            b"fmt " if length >= 16 => {
                let mut pcm = [0; 16];
                file.read_exact(&mut pcm)?;
                if pcm != *b"\x01\0\x01\0\x80\x3e\0\0\0\x7d\0\0\x02\0\x10\0" {
                    return Err(invalid_wav());
                }
                format = true;
            }
            b"data" if format && length.is_multiple_of(2) => return Ok((start, length)),
            _ => {}
        }
        file.seek(SeekFrom::Start(cursor))?;
    }
    Err(invalid_wav())
}

impl Drop for Source {
    fn drop(&mut self) {
        if let Source::Process { child, .. } = self {
            // SAFETY: the child is the leader of its own process group and has not been reaped.
            unsafe { libc::kill(-(child.id() as libc::pid_t), libc::SIGKILL) };
            let _ = child.wait();
        }
    }
}

const _: () = assert!(FRAME_BYTES == RATE as usize * 2 / 50);
