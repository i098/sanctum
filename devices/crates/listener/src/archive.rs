use crate::{
    api::{Api, Error, Manifest},
    pair::{Credential, write_atomic},
    stream,
    wire::{RATE, Start, timestamp, wav_header},
};
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    fs, io,
    path::{Path, PathBuf},
    thread::{self, JoinHandle},
};
use uuid::Uuid;

pub(crate) const CHUNK_PCM: usize = RATE as usize * 2 * 30;

pub(crate) struct Archive {
    dir: PathBuf,
    pending: VecDeque<PathBuf>,
    used: u64,
    limit: u64,
    registered: Option<Uuid>,
}

impl Archive {
    pub fn open(dir: &Path, device_id: Uuid, max_mb: u32) -> io::Result<Self> {
        let dir = dir.join("chunks").join(device_id.to_string());
        fs::create_dir_all(&dir)?;
        let mut pending = Vec::new();
        let mut used = 0;
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            if entry.path().extension().is_some_and(|ext| ext == "chunk")
                && entry.file_type()?.is_file()
            {
                used += entry.metadata()?.len();
                pending.push(entry.path());
            }
        }
        pending.sort_unstable();
        Ok(Self {
            dir,
            pending: pending.into(),
            used,
            limit: u64::from(max_mb) * 1024 * 1024,
            registered: None,
        })
    }

    pub fn len(&self) -> usize {
        self.pending.len()
    }

    pub fn mark_accepted(&mut self, epoch: Uuid) {
        self.registered = Some(epoch);
    }

    pub fn has_space(&self) -> bool {
        self.used + CHUNK_PCM as u64 + 4096 <= self.limit
    }

    pub fn queue(&mut self, start: &Start, sample_start: u64, pcm: &[u8]) -> io::Result<()> {
        if pcm.is_empty() {
            return Ok(());
        }
        let sample_count = (pcm.len() / 2) as u32;
        let header = wav_header(sample_count);
        let mut hash = Sha256::new();
        hash.update(header);
        hash.update(pcm);
        let captured_at = sample_time(start, sample_start);
        let manifest = Manifest {
            chunk_id: Uuid::new_v4(),
            listener_id: start.listener_id,
            epoch_id: start.epoch_id,
            track: start.track,
            sequence: sample_start / (CHUNK_PCM as u64 / 2),
            sample_start,
            sample_count,
            sample_rate: RATE,
            captured_at: timestamp(captured_at),
            byte_length: header.len() + pcm.len(),
            sha256: format!("{:x}", hash.finalize()),
        };
        let path = self.dir.join(format!(
            "{:032}-{}-{:020}.chunk",
            start.clock.captured_at.unix_timestamp_nanos(),
            start.epoch_id,
            sample_start
        ));
        let mut metadata = serde_json::to_vec(&(start, manifest))?;
        metadata.push(b'\n');
        metadata.extend_from_slice(&header);
        write_atomic(&self.dir, &path, &metadata, pcm)?;
        self.used += (metadata.len() + pcm.len()) as u64;
        self.pending.push_back(path);
        Ok(())
    }

    pub fn start_upload(
        &self,
        api: &Api,
        credential: &Credential,
        active_epoch: Option<(Uuid, bool)>,
    ) -> io::Result<Option<Upload>> {
        let Some(path) = self.pending.front().cloned() else {
            return Ok(None);
        };
        let prefix = chunk_prefix(&path);
        let last = self
            .pending
            .iter()
            .rev()
            .find(|path| chunk_prefix(path) == prefix)
            .unwrap()
            .clone();
        let api = api.clone();
        let token = credential.access_token.clone();
        let registered = self.registered;
        thread::Builder::new()
            .name("listener-archive".into())
            .spawn(move || upload(&api, &token, active_epoch, registered, &path, &last))
            .map(Some)
    }

    pub fn finish_upload(&mut self, job: Upload) -> Result<String, Error> {
        let (bytes, saved, epoch) = job.join().map_err(|_| Error::Transport)??;
        let path = self
            .pending
            .front()
            .expect("An upload has one pending chunk.");
        fs::remove_file(path).map_err(|_| Error::Transport)?;
        self.pending.pop_front();
        self.used -= bytes;
        self.registered = Some(epoch);
        Ok(saved)
    }
}

pub(crate) type Upload = JoinHandle<Result<(u64, String, Uuid), Error>>;

fn chunk_prefix(path: &Path) -> Option<&str> {
    path.file_stem()?
        .to_str()?
        .rsplit_once('-')
        .map(|(prefix, _)| prefix)
}

fn upload(
    api: &Api,
    token: &str,
    active_epoch: Option<(Uuid, bool)>,
    registered: Option<Uuid>,
    path: &Path,
    last: &Path,
) -> Result<(u64, String, Uuid), Error> {
    let (bytes, start, manifest, offset) = read(path)?;
    let epoch = start.epoch_id;
    if registered != Some(epoch) {
        match active_epoch {
            Some((id, false)) if id == epoch => return Err(Error::Transport),
            Some((id, true)) if id == epoch => {}
            _ => {
                let end = if last == path {
                    manifest.sample_start + u64::from(manifest.sample_count)
                } else {
                    let (_, _, chunk, _) = read(last)?;
                    chunk.sample_start + u64::from(chunk.sample_count)
                };
                stream::register_archive(api, token, &start.archive_only(end))?;
            }
        }
    }
    let receipt = api.upload(token, &manifest, &bytes[offset..])?;
    if receipt.chunk_id != manifest.chunk_id
        || receipt.sha256 != manifest.sha256
        || receipt.byte_length != manifest.byte_length
        || receipt.committed_at.offset() != time::UtcOffset::UTC
    {
        return Err(Error::InvalidResponse);
    }
    let end = manifest.sample_start + u64::from(manifest.sample_count);
    Ok((
        bytes.len() as u64,
        timestamp(sample_time(&start, end)),
        epoch,
    ))
}

fn sample_time(start: &Start, sample: u64) -> time::OffsetDateTime {
    start.clock.captured_at
        + time::Duration::microseconds((sample * 1_000_000 / u64::from(RATE)) as i64)
}

fn read(path: &Path) -> Result<(Vec<u8>, Start, Manifest, usize), Error> {
    if fs::metadata(path).map_err(|_| Error::Transport)?.len() > CHUNK_PCM as u64 + 4096 {
        return Err(Error::InvalidResponse);
    }
    let bytes = fs::read(path).map_err(|_| Error::Transport)?;
    let split = bytes
        .iter()
        .position(|&byte| byte == b'\n')
        .ok_or(Error::InvalidResponse)?;
    let (start, manifest): (Start, Manifest) =
        serde_json::from_slice(&bytes[..split]).map_err(|_| Error::InvalidResponse)?;
    if manifest.byte_length != bytes.len() - split - 1 {
        return Err(Error::InvalidResponse);
    }
    Ok((bytes, start, manifest, split + 1))
}
