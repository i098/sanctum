#![cfg(unix)]

mod api;
mod archive;
mod audio;
mod machine;
mod pair;
mod stream;
pub mod wire;

use sanctum_device_contract::{Indicate, LightKind};
use std::{fmt, io, path::PathBuf, sync::Arc};

#[derive(Clone)]
pub enum Input {
    Alsa(String),
    File(PathBuf),
    Cmd(String),
}

pub struct Config {
    pub server: String,
    pub state_dir: PathBuf,
    pub name: String,
    pub input: Input,
    pub max_buffer_mb: u32,
    pub speaker: bool,
}

#[derive(Debug)]
pub enum RunError {
    NoIndicator,
    InvalidServer,
    InvalidConfig,
    Credential,
    Pairing(&'static str),
    Indicator(io::Error),
    Io(io::Error),
}

impl fmt::Display for RunError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NoIndicator => f.write_str("Connect a screen or a light."),
            Self::InvalidServer => f.write_str("Use an HTTPS server origin."),
            Self::InvalidConfig => {
                f.write_str("Use a name of 1 to 200 characters and a nonzero archive limit.")
            }
            Self::Credential => f.write_str("The stored credential is invalid for this server."),
            Self::Pairing(message) => f.write_str(message),
            Self::Indicator(error) => write!(f, "The recording indicator failed: {error}"),
            Self::Io(error) => error.fmt(f),
        }
    }
}

impl std::error::Error for RunError {}

impl From<io::Error> for RunError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

pub fn input_from_arg(arg: &str) -> Result<Input, String> {
    match arg.split_once(':') {
        Some(("alsa", device)) if !device.is_empty() => Ok(Input::Alsa(device.into())),
        Some(("file", path)) if !path.is_empty() => Ok(Input::File(path.into())),
        Some(("cmd", command)) if !command.trim().is_empty() => Ok(Input::Cmd(command.into())),
        _ => Err("Use alsa:<device>, file:<wav>, or cmd:<command>.".into()),
    }
}

/// Run until the input ends or a stop signal arrives.
pub fn run(config: Config, indicator: Arc<dyn Indicate>) -> Result<(), RunError> {
    let caps = indicator.capabilities();
    if !caps.screen && caps.light == LightKind::None {
        return Err(RunError::NoIndicator);
    }
    if config.name.is_empty()
        || config.name.encode_utf16().count() > 200
        || config.max_buffer_mb == 0
    {
        return Err(RunError::InvalidConfig);
    }
    let api = api::Api::new(&config.server)?;
    let signals = machine::Signals::install()?;
    let capabilities = wire::DeviceCapabilities::new(caps, config.speaker);
    machine::run(config, api, capabilities, indicator, &signals)
}
