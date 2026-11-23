use crate::{
    RunError,
    api::{Api, Error},
    wire::DeviceCapabilities,
};
use sanctum_device_contract::Owner;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    fs::{self, File, OpenOptions},
    io::{BufReader, Write},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::Path,
    time::{Duration, Instant},
};
use uuid::Uuid;

#[derive(Deserialize, Serialize)]
pub(crate) struct Credential {
    pub server: String,
    pub access_token: String,
    pub device_id: Uuid,
    pub listener_id: Option<Uuid>,
    pub approved_by_name: String,
    pub workspace_name: String,
}

impl Credential {
    pub fn load(dir: &Path, server: &str) -> Result<Option<Self>, RunError> {
        let file = match OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(dir.join("credential.json"))
        {
            Ok(file) => file,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(err) => return Err(err.into()),
        };
        let meta = file.metadata()?;
        if !meta.is_file() || meta.permissions().mode() & 0o777 != 0o600 || meta.len() > 32_768 {
            return Err(RunError::Credential);
        }
        let value: Self =
            serde_json::from_reader(BufReader::new(file)).map_err(|_| RunError::Credential)?;
        if value.server != server {
            return Err(RunError::Credential);
        }
        Ok(Some(value))
    }

    pub fn save(&self, dir: &Path) -> Result<(), RunError> {
        let bytes = serde_json::to_vec(self).map_err(|_| RunError::Credential)?;
        write_atomic(dir, &dir.join("credential.json"), &bytes, &[])?;
        Ok(())
    }

    pub fn remove(dir: &Path) -> std::io::Result<()> {
        fs::remove_file(dir.join("credential.json"))?;
        File::open(dir)?.sync_all()
    }

    pub fn owner(&self) -> Owner {
        Owner {
            approved_by_name: self.approved_by_name.clone(),
            workspace_name: self.workspace_name.clone(),
        }
    }
}

pub(crate) fn write_atomic(
    dir: &Path,
    path: &Path,
    first: &[u8],
    second: &[u8],
) -> std::io::Result<()> {
    let staging = dir.join(format!(".{}.tmp", Uuid::new_v4()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&staging)?;
    let result = (|| {
        file.write_all(first)?;
        file.write_all(second)?;
        file.sync_all()?;
        fs::rename(&staging, path)?;
        File::open(dir)?.sync_all()
    })();
    if result.is_err() {
        let _ = fs::remove_file(staging);
    }
    result
}

#[derive(Deserialize)]
struct Authorization {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: u64,
    interval: u64,
}

#[derive(Deserialize)]
struct Token {
    access_token: String,
    token_type: String,
    device_id: Uuid,
    approved_by_name: String,
    workspace_name: String,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Poll {
    Token(Token),
    Failure { error: String },
}

pub(crate) fn pair(
    api: &Api,
    name: &str,
    capabilities: DeviceCapabilities,
    show_code: impl FnOnce(String, String) -> Result<(), RunError>,
    wait_until: impl Fn(Instant) -> bool,
) -> Result<Option<Credential>, RunError> {
    let begun = Instant::now();
    let (200, reply): (u16, Authorization) = api
        .post(
            "/device/authorize",
            None,
            json!({ "name": name, "capabilities": capabilities }),
        )
        .map_err(|_| RunError::Pairing("Cannot request a pairing code."))?
    else {
        return Err(RunError::Pairing("Cannot request a pairing code."));
    };
    let code = reply.user_code.as_bytes();
    if code.len() != 9
        || code[4] != b'-'
        || !code[..4].iter().chain(&code[5..]).all(u8::is_ascii_digit)
    {
        return Err(RunError::Pairing(
            "The server returned an invalid pairing code.",
        ));
    }
    let expires = begun + Duration::from_secs(reply.expires_in.min(600));
    let interval = Duration::from_secs(reply.interval.clamp(5, 600));
    show_code(reply.user_code, reply.verification_uri)?;
    poll_token(api, &reply.device_code, expires, interval, wait_until)
}

fn poll_token(
    api: &Api,
    device_code: &str,
    expires: Instant,
    mut interval: Duration,
    wait_until: impl Fn(Instant) -> bool,
) -> Result<Option<Credential>, RunError> {
    loop {
        let next = (Instant::now() + interval).min(expires + Duration::from_secs(60));
        if wait_until(next) {
            return Ok(None);
        }
        let result: Result<(u16, Poll), _> = api.post("/device/token", None, json!({
            "grant_type": "urn:ietf:params:oauth:grant-type:device_code", "device_code": device_code,
        }));
        match result {
            Ok((200, Poll::Token(token))) if token.token_type == "Bearer" => {
                return Ok(Some(Credential {
                    server: api.origin().into(),
                    access_token: token.access_token,
                    device_id: token.device_id,
                    listener_id: None,
                    approved_by_name: token.approved_by_name,
                    workspace_name: token.workspace_name,
                }));
            }
            Ok((400, Poll::Failure { error })) => match error.as_str() {
                "authorization_pending" => {}
                "slow_down" => {
                    interval = (interval + Duration::from_secs(5)).min(Duration::from_secs(600))
                }
                "access_denied" => return Err(RunError::Pairing("The person denied pairing.")),
                "expired_token" | "invalid_grant" => {
                    return Err(RunError::Pairing("The pairing code is no longer valid."));
                }
                _ => return Err(RunError::Pairing("The server refused pairing.")),
            },
            Err(Error::Transport) | Err(Error::Status(500..=599)) => {
                interval = (interval * 2).min(Duration::from_secs(600))
            }
            _ => {
                return Err(RunError::Pairing(
                    "The server returned an invalid pairing response.",
                ));
            }
        }
        if Instant::now() >= expires {
            return Err(RunError::Pairing("The pairing code expired."));
        }
    }
}
