use sanctum_device_contract::{Capabilities, LightKind};
use serde::{Deserialize, Serialize};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

pub(crate) const RATE: u32 = 16_000;
pub(crate) const FRAME_BYTES: usize = 640;

#[derive(Clone, Copy, Deserialize, Serialize)]
pub(crate) struct DeviceCapabilities {
    mic: bool,
    screen: bool,
    light: Light,
    speaker: bool,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Light {
    None,
    Mono,
    Pwm,
    Rgb,
}

impl DeviceCapabilities {
    pub fn new(c: Capabilities, speaker: bool) -> Self {
        Self {
            mic: true,
            screen: c.screen,
            light: match c.light {
                LightKind::None => Light::None,
                LightKind::Mono => Light::Mono,
                LightKind::Pwm => Light::Pwm,
                LightKind::Rgb => Light::Rgb,
            },
            speaker,
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
pub struct Start {
    #[serde(rename = "_tag")]
    tag: String,
    protocol_version: u8,
    pub(crate) listener_id: Uuid,
    pub(crate) epoch_id: Uuid,
    pub(crate) track: u16,
    pub(crate) clock: Clock,
    lease_generation: u64,
    start_reason: String,
    capabilities: DeviceCapabilities,
    #[serde(skip_serializing_if = "Option::is_none")]
    archive_only: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sample_end: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    end_reason: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct Clock {
    sample_rate: u32,
    channels: u8,
    encoding: String,
    sample_start: u64,
    #[serde(with = "time::serde::rfc3339")]
    pub captured_at: OffsetDateTime,
    timezone: String,
}

impl Start {
    pub(crate) fn new(
        listener_id: Uuid,
        generation: u64,
        capabilities: DeviceCapabilities,
        reason: &str,
    ) -> Self {
        let now = OffsetDateTime::now_utc();
        let captured_at = now.replace_nanosecond(now.microsecond() * 1000).unwrap();
        Self {
            tag: "start".into(),
            protocol_version: 1,
            listener_id,
            epoch_id: Uuid::new_v4(),
            track: 0,
            clock: Clock {
                sample_rate: RATE,
                channels: 1,
                encoding: "pcm_s16le".into(),
                sample_start: 0,
                captured_at,
                timezone: "UTC".into(),
            },
            lease_generation: generation,
            start_reason: reason.into(),
            capabilities,
            archive_only: None,
            sample_end: None,
            end_reason: None,
        }
    }

    pub(crate) fn archive_only(&self, sample_end: u64) -> Self {
        Self {
            archive_only: Some(true),
            sample_end: Some(sample_end),
            ..self.clone()
        }
    }
}

pub(crate) fn timestamp(time: OffsetDateTime) -> String {
    time.format(&Rfc3339)
        .expect("UTC capture time is representable")
}

pub fn frame(track: u16, sequence: u32, sample_start: u64, pcm: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(24 + pcm.len());
    bytes.extend_from_slice(&[1, 1]);
    bytes.extend_from_slice(&track.to_le_bytes());
    bytes.extend_from_slice(&sequence.to_le_bytes());
    bytes.extend_from_slice(&sample_start.to_le_bytes());
    bytes.extend_from_slice(&((pcm.len() / 2) as u32).to_le_bytes());
    bytes.extend_from_slice(&[0; 4]);
    bytes.extend_from_slice(pcm);
    bytes
}

pub fn wav_header(samples: u32) -> [u8; 44] {
    let bytes = samples * 2;
    let mut header = *b"RIFF\0\0\0\0WAVEfmt \x10\0\0\0\x01\0\x01\0\x80\x3e\0\0\0\x7d\0\0\x02\0\x10\0data\0\0\0\0";
    header[4..8].copy_from_slice(&(36 + bytes).to_le_bytes());
    header[40..44].copy_from_slice(&bytes.to_le_bytes());
    header
}
