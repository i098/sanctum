use std::io;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DeviceState {
    Unpaired,
    Stopped,
    Starting,
    Listening,
    Reconnecting,
    Degraded,
    Paused,
    Error,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Status {
    pub state: DeviceState,
    pub level: f32,
    pub bands: [f32; 8],
    pub code: Option<String>,
    pub verification_uri: Option<String>,
    pub name: String,
    pub cause: Option<String>,
    pub saved_through: Option<String>,
    pub owner: Option<Owner>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Owner {
    pub approved_by_name: String,
    pub workspace_name: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Lit {
    pub on: bool,
    pub brightness: u8,
    pub rgb: [u8; 3],
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Capabilities {
    pub screen: bool,
    pub light: LightKind,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LightKind {
    None,
    Mono,
    Pwm,
    Rgb,
}

pub trait Light: Send {
    fn set(&mut self, lit: Lit) -> io::Result<()>;
}

pub trait Screen: Send {
    fn show(&mut self, status: &Status) -> io::Result<()>;
}

pub trait Indicate: Send + Sync {
    /// Return only after the first frame of the new state is written.
    fn show(&self, status: Status) -> io::Result<()>;
    /// Update live levels without blocking capture.
    fn level(&self, level: f32, bands: [f32; 8]);
    fn fault(&self) -> Option<io::Error>;
    fn capabilities(&self) -> Capabilities;
}
