mod light_sysfs;
mod pattern;
mod runner;
mod status_server;
mod term;

use std::io;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Component, Path};

use sanctum_device_contract::{Light, LightKind, Screen};

pub use pattern::pattern;
pub use runner::Indicator;

pub fn light_from_arg(arg: &str) -> io::Result<Option<(Box<dyn Light>, LightKind)>> {
    match arg {
        "none" => Ok(None),
        "term" => {
            term::require_tty(&io::stdout())?;
            Ok(Some((
                Box::new(term::TermLight::default()),
                LightKind::Mono,
            )))
        }
        _ => {
            let name = arg
                .strip_prefix("sysfs:")
                .ok_or_else(|| invalid("Expected none, term or sysfs:<LED name>[:pwm]"))?;
            let (name, pwm) = name
                .strip_suffix(":pwm")
                .map_or((name, false), |name| (name, true));
            let mut parts = Path::new(name).components();
            if !matches!(parts.next(), Some(Component::Normal(part)) if part == name)
                || parts.next().is_some()
            {
                return Err(invalid("Expected one LED name in the Linux LED class"));
            }
            let light =
                light_sysfs::SysfsLight::open(&Path::new("/sys/class/leds").join(name), pwm)?;
            Ok(Some((
                Box::new(light),
                if pwm { LightKind::Pwm } else { LightKind::Mono },
            )))
        }
    }
}

pub fn screen_from_arg(arg: &str) -> io::Result<Option<Box<dyn Screen>>> {
    match arg {
        "none" => Ok(None),
        "term" => {
            let output = io::stdout();
            term::require_tty(&output)?;
            Ok(Some(Box::new(term::TermScreen::new(output))))
        }
        _ => {
            let path = arg
                .strip_prefix("kiosk:")
                .ok_or_else(|| invalid("Expected none, term or kiosk:<dir>[:port]"))?;
            let (path, port) = match path.rsplit_once(':') {
                Some((path, port)) => (
                    path,
                    port.parse().map_err(|_| invalid("Invalid kiosk port"))?,
                ),
                None => (path, 7171),
            };
            if path.is_empty() || port == 0 {
                return Err(invalid("Expected a kiosk directory and a nonzero port"));
            }
            let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
            Ok(Some(Box::new(status_server::Kiosk::open(
                Path::new(path),
                address,
            )?)))
        }
    }
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

#[cfg(test)]
mod test_support {
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{Duration, Instant};

    use sanctum_device_contract::{DeviceState, Status};

    pub(crate) struct Scratch(pub(crate) PathBuf);

    impl Scratch {
        pub(crate) fn new() -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let dir = std::env::temp_dir().join(format!(
                "sanctum-indicator-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed),
            ));
            fs::create_dir(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    pub(crate) fn status(state: DeviceState) -> Status {
        Status {
            state,
            level: 0.0,
            bands: [0.0; 8],
            name: "Test listener".into(),
            code: None,
            verification_uri: None,
            cause: None,
            saved_through: None,
            owner: None,
        }
    }

    pub(crate) fn eventually(mut check: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(3);
        while !check() {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}
