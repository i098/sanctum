use crate::wire::DeviceCapabilities;
use serde::{Serialize, de::DeserializeOwned};
use serde_json::json;
use std::time::Duration;
use tungstenite::http::Uri;
use uuid::Uuid;

#[derive(Debug)]
pub(crate) enum Error {
    Status(u16),
    Transport,
    InvalidResponse,
}

#[derive(Clone)]
pub(crate) struct Api {
    origin: String,
    pub uri: Uri,
    agent: ureq::Agent,
}

impl Api {
    pub fn new(server: &str) -> Result<Self, crate::RunError> {
        let origin = server.trim_end_matches('/');
        let uri = origin
            .parse::<Uri>()
            .map_err(|_| crate::RunError::InvalidServer)?;
        let host = uri.host().ok_or(crate::RunError::InvalidServer)?;
        let loopback = matches!(host, "127.0.0.1" | "[::1]");
        if !matches!(uri.scheme_str(), Some("https"))
            && !(loopback && uri.scheme_str() == Some("http"))
            || uri.path() != "/"
            || uri.query().is_some()
            || uri.authority().unwrap().as_str().contains('@')
        {
            return Err(crate::RunError::InvalidServer);
        }
        let agent = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(3)))
            .max_redirects(0)
            .http_status_as_error(false)
            .build()
            .into();
        Ok(Self {
            origin: origin.into(),
            uri,
            agent,
        })
    }

    pub fn origin(&self) -> &str {
        &self.origin
    }

    pub fn post<T: DeserializeOwned>(
        &self,
        path: &str,
        token: Option<&str>,
        body: impl Serialize,
    ) -> Result<(u16, T), Error> {
        let mut request = self.agent.post(format!("{}/api/v1{path}", self.origin));
        if let Some(token) = token {
            request = request.header("Authorization", format!("Bearer {token}"));
        }
        let mut response = request.send_json(body).map_err(|_| Error::Transport)?;
        let status = response.status();
        if !status.is_success() && !(status.as_u16() == 400 && path == "/device/token") {
            return Err(Error::Status(status.as_u16()));
        }
        Ok((
            status.as_u16(),
            response
                .body_mut()
                .with_config()
                .limit(32_768)
                .read_json()
                .map_err(|_| Error::InvalidResponse)?,
        ))
    }

    pub fn register(
        &self,
        token: &str,
        name: &str,
        caps: DeviceCapabilities,
    ) -> Result<Uuid, Error> {
        #[derive(serde::Deserialize)]
        struct Registered {
            id: Uuid,
        }
        let (_, reply): (_, Registered) = self.post(
            "/listeners",
            Some(token),
            json!({
                "name": name, "mode": "room", "capabilities": {"device": caps}
            }),
        )?;
        Ok(reply.id)
    }

    pub fn heartbeat(
        &self,
        token: &str,
        listener: Uuid,
        body: impl Serialize,
    ) -> Result<Heartbeat, Error> {
        self.post(
            &format!("/listeners/{listener}/heartbeat"),
            Some(token),
            body,
        )
        .map(|(_, reply)| reply)
    }

    pub fn upload(&self, token: &str, m: &Manifest, wav: &[u8]) -> Result<Receipt, Error> {
        let mut reply = self
            .agent
            .put(format!(
                "{}/api/v1/listeners/{}/chunks/{}",
                self.origin, m.listener_id, m.chunk_id
            ))
            .header("Authorization", format!("Bearer {token}"))
            .header("Content-Type", "audio/wav")
            .header(
                "x-sanctum-manifest",
                serde_json::to_string(m).map_err(|_| Error::InvalidResponse)?,
            )
            .send(wav)
            .map_err(|_| Error::Transport)?;
        if !reply.status().is_success() {
            return Err(Error::Status(reply.status().as_u16()));
        }
        reply
            .body_mut()
            .with_config()
            .limit(32_768)
            .read_json()
            .map_err(|_| Error::InvalidResponse)
    }
}

#[derive(serde::Deserialize)]
pub(crate) struct Heartbeat {
    pub lease_generation: u64,
    pub owner: bool,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub(crate) struct Manifest {
    pub chunk_id: Uuid,
    pub listener_id: Uuid,
    pub epoch_id: Uuid,
    pub track: u16,
    pub sequence: u64,
    pub sample_start: u64,
    pub sample_count: u32,
    pub sample_rate: u32,
    pub captured_at: String,
    pub byte_length: usize,
    pub sha256: String,
}

#[derive(serde::Deserialize)]
pub(crate) struct Receipt {
    pub chunk_id: Uuid,
    pub sha256: String,
    pub byte_length: usize,
    #[serde(with = "time::serde::rfc3339")]
    pub committed_at: time::OffsetDateTime,
}
