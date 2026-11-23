use sanctum_device_contract::{DeviceState, Lit};

use DeviceState::*;

pub(crate) fn recording(state: DeviceState) -> bool {
    matches!(state, Listening | Reconnecting | Degraded)
}

pub(crate) fn state_name(state: DeviceState) -> &'static str {
    match state {
        Unpaired => "unpaired",
        Stopped => "stopped",
        Starting => "starting",
        Listening => "listening",
        Reconnecting => "reconnecting",
        Degraded => "degraded",
        Paused => "paused",
        Error => "error",
    }
}

pub(crate) fn unit(level: f32) -> f32 {
    if level.is_nan() {
        0.0
    } else {
        level.clamp(0.0, 1.0)
    }
}

pub fn pattern(state: DeviceState, elapsed_ms: u64, level: f32, code: Option<&str>) -> Lit {
    let rgb = match state {
        Listening => [34, 211, 196],
        Reconnecting | Degraded => [242, 163, 58],
        Error => [255, 92, 92],
        _ => [61, 126, 255],
    };
    let on = is_on(state, elapsed_ms, code);
    let brightness = if !on {
        0
    } else if state == Listening {
        (102.0 + 153.0 * unit(level)).round() as u8
    } else {
        255
    };
    Lit {
        on,
        brightness,
        rgb,
    }
}

fn is_on(state: DeviceState, elapsed_ms: u64, code: Option<&str>) -> bool {
    match state {
        Listening => true,
        Reconnecting => elapsed_ms % 1000 < 900,
        Degraded => matches!(elapsed_ms % 1000, 0..760 | 820..940),
        _ => elapsed_ms
            .checked_sub(300)
            .is_some_and(|ms| idle_pulse(state, ms, code)),
    }
}

fn idle_pulse(state: DeviceState, ms: u64, code: Option<&str>) -> bool {
    match state {
        Unpaired => code.is_some_and(|code| pairing(ms, code)),
        Stopped => ms % 4000 < 100,
        Paused => matches!(ms % 4000, 0..100 | 300..400),
        Starting => ms % 500 < 250,
        Error => matches!(ms % 2000, 0..100 | 200..300 | 400..500),
        Listening | Reconnecting | Degraded => unreachable!(),
    }
}

fn pairing(elapsed_ms: u64, code: &str) -> bool {
    let bytes = code.as_bytes();
    if bytes.len() != 9 || bytes[4] != b'-' {
        return false;
    }
    let mut digits = [0; 8];
    for (pulses, digit) in digits.iter_mut().zip(bytes[..4].iter().chain(&bytes[5..])) {
        if !digit.is_ascii_digit() {
            return false;
        }
        *pulses = if *digit == b'0' {
            10
        } else {
            u64::from(digit - b'0')
        };
    }
    let mut phase = elapsed_ms % (digits.iter().sum::<u64>() * 400 + 7 * 1000 + 3000);
    for pulses in digits {
        let blinks = pulses * 400;
        if phase < blinks + 1000 {
            return phase < blinks && phase % 400 < 200;
        }
        phase -= blinks + 1000;
    }
    false
}
