//! `pcm_ingest`: the `decodePcmFrame` validation of packages/contracts/src/media.ts plus dispatch
//! into a bounded 256-frame live queue drained every 32 frames, over the `pcm16-frames-v1` fixture.

use crate::measure::{RecordInput, js_round, sample, seeded_random, sha256_hex, to_record};
use serde_json::{Value, json};

const VERSION: u8 = 1;
const KIND_PCM16: u8 = 1;
const HEADER_BYTES: usize = 24;
const MAX_FRAME_BYTES: usize = HEADER_BYTES + 9_600 * 2;
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;
const QUEUE_CAPACITY: usize = 256;

#[derive(Debug, PartialEq)]
pub struct Frame<'a> {
    pub track: u16,
    pub sequence: u32,
    pub sample_start: u64,
    pub sample_count: u32,
    /// Little-endian PCM16 payload, borrowed like the TypeScript aligned `Int16Array` view.
    pub samples: &'a [u8],
}

fn u32_at(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap())
}

/// Validates one untrusted frame; errors use the TypeScript `FrameError` names.
pub fn decode(bytes: &[u8]) -> Result<Frame<'_>, &'static str> {
    if bytes.len() < HEADER_BYTES {
        return Err("too_short");
    }
    if bytes.len() > MAX_FRAME_BYTES {
        return Err("too_long");
    }
    if bytes[0] != VERSION {
        return Err("unsupported_version");
    }
    if bytes[1] != KIND_PCM16 {
        return Err("unsupported_kind");
    }
    if u32_at(bytes, 20) != 0 {
        return Err("reserved_not_zero");
    }
    let sample_count = u32_at(bytes, 16);
    if sample_count == 0 {
        return Err("empty_frame");
    }
    let sample_start = u64::from_le_bytes(bytes[8..16].try_into().unwrap());
    if sample_start > MAX_SAFE_INTEGER {
        return Err("unsafe_sample_start");
    }
    if bytes.len() != HEADER_BYTES + sample_count as usize * 2 {
        return Err("length_mismatch");
    }
    let track = u16::from_le_bytes([bytes[2], bytes[3]]);
    Ok(Frame {
        track,
        sequence: u32_at(bytes, 4),
        sample_start,
        sample_count,
        samples: &bytes[HEADER_BYTES..],
    })
}

fn encode(sequence: u32, per_frame: usize, samples: &[i16]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(HEADER_BYTES + samples.len() * 2);
    bytes.extend_from_slice(&[VERSION, KIND_PCM16, 0, 0]);
    bytes.extend_from_slice(&sequence.to_le_bytes());
    bytes.extend_from_slice(&(u64::from(sequence) * per_frame as u64).to_le_bytes());
    bytes.extend_from_slice(&(samples.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&[0; 4]);
    samples.iter().for_each(|sample| bytes.extend_from_slice(&sample.to_le_bytes()));
    bytes
}

/// `pcm16-frames-v1`: 64 seeded noise frames, the same bytes `pcmIngest` encodes.
fn fixture(seed: u32, per_frame: usize) -> Vec<Vec<u8>> {
    let mut next = seeded_random(seed);
    (0..64)
        .map(|sequence| {
            let samples: Vec<i16> = (0..per_frame).map(|_| js_round(next() * 32_000.0) as i16).collect();
            encode(sequence, per_frame, &samples)
        })
        .collect()
}

pub fn run(job: &Value) -> Vec<Value> {
    let frames = job["frames"].as_u64().unwrap() as usize;
    let per_frame = job["samples_per_frame"].as_u64().unwrap() as usize;
    let encoded = fixture(job["seed"].as_u64().unwrap() as u32, per_frame);
    let mut queue: Vec<&[u8]> = Vec::with_capacity(QUEUE_CAPACITY);
    let (mut errors, mut dropped) = (0, 0);
    let run = sample(frames, job["rate"].as_f64().unwrap_or(0.0), |i| {
        match decode(&encoded[i % encoded.len()]) {
            Err(_) => errors += 1,
            Ok(frame) if queue.len() >= QUEUE_CAPACITY => dropped += frame.sample_count as usize,
            Ok(frame) => queue.push(frame.samples),
        }
        if i % 32 == 31 {
            std::hint::black_box(&queue);
            queue.clear();
        }
    });
    let parts: Vec<&[u8]> = encoded.iter().map(Vec::as_slice).collect();
    let parameters = json!({ "frames": frames, "samples_per_frame": per_frame, "queue_capacity_frames": QUEUE_CAPACITY, "scope": "frame validation and bounded dispatch; socket, auth and ASR excluded" });
    let input = RecordInput {
        workload_id: "pcm_ingest",
        phase: "steady",
        fixture_sha256: sha256_hex(&parts),
        concurrency: job["concurrency"].as_f64().unwrap_or(1.0),
        errors,
        checked: frames,
        dropped_samples: dropped,
        parameters,
    };
    vec![to_record(job, &run, input)]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_accepts_the_fixture_and_rejects_malformed_frames() {
        let frame = &fixture(1, 960)[3];
        let decoded = decode(frame).unwrap();
        assert_eq!(
            (decoded.sequence, decoded.sample_start, decoded.sample_count, decoded.samples.len()),
            (3, 2880, 960, 1920)
        );
        assert_eq!(decode(&frame[..20]), Err("too_short"));
        assert_eq!(decode(&frame[..frame.len() - 2]), Err("length_mismatch"));
        let mut reserved = frame.clone();
        reserved[20] = 1;
        assert_eq!(decode(&reserved), Err("reserved_not_zero"));
        let mut empty = frame[..HEADER_BYTES].to_vec();
        empty[16..20].copy_from_slice(&0u32.to_le_bytes());
        assert_eq!(decode(&empty), Err("empty_frame"));
    }
}
