use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use sanctum_device_contract::{Light, Lit};

pub(crate) struct SysfsLight {
    brightness: PathBuf,
    max: u32,
    pwm: bool,
}

impl SysfsLight {
    pub(crate) fn open(dir: &Path, pwm: bool) -> io::Result<Self> {
        let max = fs::read_to_string(dir.join("max_brightness"))?
            .trim()
            .parse::<u32>()
            .ok()
            .filter(|&n| n > 0)
            .ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidData, "Invalid LED max_brightness")
            })?;
        let trigger = dir.join("trigger");
        writable(&trigger)?.write_all(b"none\n")?;
        let selected = fs::read_to_string(trigger)?;
        if selected.trim() != "none" && !selected.split_whitespace().any(|s| s == "[none]") {
            return Err(io::Error::other("The LED trigger is not set to none"));
        }
        let mut light = Self {
            brightness: dir.join("brightness"),
            max,
            pwm,
        };
        light.set(Lit {
            on: false,
            brightness: 0,
            rgb: [0; 3],
        })?;
        Ok(light)
    }
}

impl Light for SysfsLight {
    fn set(&mut self, lit: Lit) -> io::Result<()> {
        let value = if !lit.on {
            0
        } else if self.pwm {
            (u64::from(self.max) * u64::from(lit.brightness)).div_ceil(255)
        } else {
            u64::from(self.max)
        };
        // A sysfs attribute must receive the complete value in one write.
        let mut text = [0; 11];
        let mut buf = text.as_mut_slice();
        writeln!(buf, "{value}")?;
        let len = 11 - buf.len();
        writable(&self.brightness)?.write_all(&text[..len])
    }
}

fn writable(path: &Path) -> io::Result<fs::File> {
    OpenOptions::new().write(true).truncate(true).open(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Indicator, test_support::*};
    use sanctum_device_contract::{DeviceState::*, Indicate, LightKind};

    #[test]
    fn scales_brightness_and_reports_a_lost_led() {
        let led = Scratch::new();
        let file = led.0.join("brightness");
        fs::write(led.0.join("max_brightness"), "15\n").unwrap();
        fs::write(led.0.join("trigger"), "[timer] none\n").unwrap();
        fs::write(&file, "0\n").unwrap();
        for (pwm, expected) in [(true, "6\n"), (false, "15\n")] {
            let mut light = SysfsLight::open(&led.0, pwm).unwrap();
            assert_eq!(fs::read_to_string(led.0.join("trigger")).unwrap(), "none\n");
            light
                .set(Lit {
                    on: true,
                    brightness: 102,
                    rgb: [0; 3],
                })
                .unwrap();
            assert_eq!(fs::read_to_string(&file).unwrap(), expected);
            light
                .set(Lit {
                    on: false,
                    brightness: 0,
                    rgb: [0; 3],
                })
                .unwrap();
            assert_eq!(fs::read_to_string(&file).unwrap(), "0\n");
        }
        let light = SysfsLight::open(&led.0, true).unwrap();
        let indicator = Indicator::new(Some((Box::new(light), LightKind::Pwm)), None, None);
        indicator.show(status(Listening)).unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "6\n");
        fs::remove_file(&file).unwrap();
        eventually(|| indicator.fault().is_some());
        assert!(!file.exists());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn detects_when_trigger_write_does_not_take_effect() {
        let led = Scratch::new();
        fs::write(led.0.join("max_brightness"), "15").unwrap();
        std::os::unix::fs::symlink("/dev/null", led.0.join("trigger")).unwrap();
        let result = SysfsLight::open(&led.0, false);
        assert_eq!(
            result.err().unwrap().to_string(),
            "The LED trigger is not set to none"
        );
    }
}
