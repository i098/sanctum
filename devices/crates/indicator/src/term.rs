use std::io::{self, IsTerminal, Write};

use sanctum_device_contract::{DeviceState, Light, Lit, Screen, Status};

use crate::pattern::state_name;

pub(crate) fn require_tty(output: &impl IsTerminal) -> io::Result<()> {
    if output.is_terminal() {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "The term indicator needs a terminal on stdout",
        ))
    }
}

#[derive(Default)]
pub(crate) struct TermLight(Option<bool>);

impl Light for TermLight {
    fn set(&mut self, lit: Lit) -> io::Result<()> {
        if self.0 != Some(lit.on) {
            let mut output = io::stdout().lock();
            output.write_all(if lit.on {
                b"Light: on\n"
            } else {
                b"Light: off\n"
            })?;
            output.flush()?;
            self.0 = Some(lit.on);
        }
        Ok(())
    }
}

pub(crate) struct TermScreen<W> {
    output: W,
    last: String,
    line: String,
}

impl<W> TermScreen<W> {
    pub(crate) fn new(output: W) -> Self {
        Self {
            output,
            last: String::new(),
            line: String::new(),
        }
    }
}

impl<W: Write + Send> Screen for TermScreen<W> {
    fn show(&mut self, status: &Status) -> io::Result<()> {
        let line = &mut self.line;
        line.clear();
        line.push_str(state_name(status.state));
        let mut append = |value: Option<&str>| {
            if let Some(value) = value {
                line.push_str(" | ");
                line.extend(value.chars().map(|c| if c.is_control() { ' ' } else { c }));
            }
        };
        match status.state {
            DeviceState::Unpaired => {
                append(Some(&status.name));
                append(status.code.as_deref());
                append(status.verification_uri.as_deref());
            }
            _ => {
                if let Some(owner) = &status.owner {
                    append(Some(&owner.approved_by_name));
                    append(Some(&owner.workspace_name));
                }
                if matches!(status.state, DeviceState::Degraded | DeviceState::Error) {
                    append(status.cause.as_deref());
                }
            }
        }
        if self.last != *line {
            line.push('\n');
            self.output.write_all(line.as_bytes())?;
            self.output.flush()?;
            line.pop();
            std::mem::swap(&mut self.last, line);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::status;
    use sanctum_device_contract::{DeviceState::*, Owner};

    #[test]
    fn prints_one_safe_line_per_change() {
        let mut screen = TermScreen::new(Vec::new());
        let mut frame = status(Unpaired);
        frame.code = Some("1234-5678".into());
        frame.verification_uri = Some("https://device.test/pair".into());
        screen.show(&frame).unwrap();
        screen.show(&frame).unwrap();
        frame.state = Error;
        frame.owner = Some(Owner {
            approved_by_name: "Sam".into(),
            workspace_name: "Studio".into(),
        });
        frame.cause = Some("No LED\n\x1b[2J".into());
        screen.show(&frame).unwrap();
        assert_eq!(
            String::from_utf8(screen.output).unwrap(),
            "unpaired | Test listener | 1234-5678 | https://device.test/pair\nerror | Sam | Studio | No LED  [2J\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn refuses_non_terminal_output() {
        let output = std::fs::File::open("/dev/null").unwrap();
        assert_eq!(
            require_tty(&output).unwrap_err().kind(),
            io::ErrorKind::InvalidInput
        );
    }
}
