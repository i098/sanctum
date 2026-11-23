use sanctum_indicator::{Indicator, light_from_arg, screen_from_arg};
use sanctum_listener_core::{Config, RunError, input_from_arg, run};
use std::{collections::HashMap, env, process::ExitCode, sync::Arc};

const USAGE: &str = "sanctum-listener --server <origin> --state-dir <dir> --name <name>\n  --input alsa:<device>|file:<wav>|cmd:<command>\n  --light none|term|sysfs:<led>[:pwm] --screen none|term|kiosk:<dir>[:<port>]\n  [--indication-log <file>] [--max-buffer-mb 512]";

fn options(mut args: impl Iterator<Item = String>) -> Result<HashMap<String, String>, String> {
    let mut flags = HashMap::new();
    while let Some(flag) = args.next() {
        match flag.as_str() {
            "--server" | "--state-dir" | "--name" | "--input" | "--light" | "--screen"
            | "--indication-log" | "--max-buffer-mb" => {}
            _ => return Err(format!("Unknown option: {flag}")),
        }
        let value = args
            .next()
            .filter(|value| !value.is_empty() && !value.starts_with("--"))
            .ok_or_else(|| format!("Missing value for {flag}."))?;
        if flags.contains_key(&flag) {
            return Err(format!("Duplicate option: {flag}"));
        }
        flags.insert(flag, value);
    }
    Ok(flags)
}

fn start(mut flags: HashMap<String, String>) -> Result<ExitCode, String> {
    let light = flags.remove("--light").unwrap_or_else(|| "none".into());
    let screen = flags.remove("--screen").unwrap_or_else(|| "none".into());
    if light == "none" && screen == "none" {
        return Err("Select a light or a screen.".into());
    }
    let mut require = |flag: &str| flags.remove(flag).ok_or_else(|| format!("Missing {flag}."));
    let config = Config {
        server: require("--server")?,
        state_dir: require("--state-dir")?.into(),
        name: require("--name")?,
        input: input_from_arg(&require("--input")?)?,
        max_buffer_mb: flags
            .remove("--max-buffer-mb")
            .as_deref()
            .unwrap_or("512")
            .parse::<u32>()
            .ok()
            .filter(|&n| n > 0)
            .ok_or("Use a positive integer for --max-buffer-mb.")?,
        speaker: false,
    };
    let light = light_from_arg(&light).map_err(|error| format!("Light: {error}"))?;
    let screen = screen_from_arg(&screen).map_err(|error| format!("Screen: {error}"))?;
    let indicator = Arc::new(Indicator::new(
        light,
        screen,
        flags.remove("--indication-log").map(Into::into),
    ));
    if let Err(error) = run(config, indicator) {
        if matches!(
            error,
            RunError::NoIndicator
                | RunError::InvalidServer
                | RunError::InvalidConfig
                | RunError::Credential
        ) {
            return Err(error.to_string());
        }
        eprintln!("Listener stopped: {error}");
        return Ok(ExitCode::FAILURE);
    }
    Ok(ExitCode::SUCCESS)
}

fn main() -> ExitCode {
    let mut args = env::args().skip(1).peekable();
    if args
        .peek()
        .is_some_and(|arg| arg == "--help" || arg == "-h")
    {
        println!("{USAGE}");
        return ExitCode::SUCCESS;
    }
    match options(args).and_then(start) {
        Ok(status) => status,
        Err(error) => {
            eprintln!("{error}\n{USAGE}");
            ExitCode::from(2)
        }
    }
}
