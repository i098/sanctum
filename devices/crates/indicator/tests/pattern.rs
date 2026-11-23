use sanctum_device_contract::DeviceState::{self, *};
use sanctum_indicator::pattern;
use serde_json::Value;

#[test]
fn every_millisecond_matches_the_wire_fixture() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../packages/contracts/fixtures/device-wire.json"
    ))
    .unwrap();
    for (state, name) in [
        (Unpaired, "unpaired"),
        (Stopped, "stopped"),
        (Starting, "starting"),
        (Listening, "listening"),
        (Reconnecting, "reconnecting"),
        (Degraded, "degraded"),
        (Paused, "paused"),
        (Error, "error"),
    ] {
        let row = &fixture["patterns"][name];
        let recording = row["recording"].as_bool().unwrap();
        let lead_in = if recording {
            0
        } else {
            fixture["non_recording_entry_dark_ms"].as_u64().unwrap()
        };
        let codes = fixture["pairing_codes"].as_array().unwrap();
        let no_code = [Value::Null];
        for code in if state == Unpaired {
            codes.as_slice()
        } else {
            &no_code
        } {
            check_cycle(state, row, code.as_str(), recording, lead_in);
        }
    }
}

fn check_cycle(state: DeviceState, row: &Value, code: Option<&str>, recording: bool, lead_in: u64) {
    let cycle = expected_cycle(row, code);
    let rgb = hsl_to_rgb(row["color"].as_str().unwrap());
    let floor = row["brightness_floor"].as_f64().unwrap_or(1.0);
    let brightness = ((floor + (1.0 - floor) * 0.5) * 255.0).round() as u8;
    let mut window = [0_i32; 1000];
    let mut lit_ms = 0;
    let mut run = 0;
    for ms in 0..60_000 {
        let frame = pattern(state, ms, 0.5, code);
        let expected = ms >= lead_in && cycle[(ms - lead_in) as usize % cycle.len()];
        assert_eq!(frame.on, expected, "{state:?} {code:?} at {ms} ms");
        assert_eq!(frame.rgb, rgb);
        assert_eq!(frame.brightness, if expected { brightness } else { 0 });
        let slot = ms as usize % window.len();
        lit_ms += i32::from(frame.on) - window[slot];
        window[slot] = i32::from(frame.on);
        run = if frame.on != recording { run + 1 } else { 0 };
        assert!(
            run <= if recording { 150 } else { 300 },
            "{state:?} at {ms} ms"
        );
        if recording && ms >= 999 {
            assert!(lit_ms >= 800, "{state:?} at {ms} ms");
        }
    }
}

fn expected_cycle(row: &Value, code: Option<&str>) -> Vec<bool> {
    if let Some(segments) = row["segments_ms"].as_array() {
        return segments
            .iter()
            .enumerate()
            .flat_map(|(i, length)| {
                std::iter::repeat_n(i % 2 == 0, length.as_u64().unwrap() as usize)
            })
            .collect();
    }
    let mut cycle = Vec::new();
    let digits = code.unwrap().chars().filter_map(|c| c.to_digit(10));
    for (i, number) in digits.enumerate() {
        let count = if number == 0 {
            row["zero_blinks"].as_u64().unwrap()
        } else {
            number.into()
        };
        for _ in 0..count {
            cycle.extend(std::iter::repeat_n(
                true,
                row["pulse_ms"][0].as_u64().unwrap() as usize,
            ));
            cycle.extend(std::iter::repeat_n(
                false,
                row["pulse_ms"][1].as_u64().unwrap() as usize,
            ));
        }
        let gap = if i == 7 {
            "repeat_gap_ms"
        } else {
            "digit_gap_ms"
        };
        cycle.extend(std::iter::repeat_n(
            false,
            row[gap].as_u64().unwrap() as usize,
        ));
    }
    cycle
}

fn hsl_to_rgb(color: &str) -> [u8; 3] {
    let mut values = color
        .trim_start_matches("hsl(")
        .trim_end_matches(')')
        .split_whitespace();
    let h: f64 = values.next().unwrap().parse().unwrap();
    let s = values
        .next()
        .unwrap()
        .trim_end_matches('%')
        .parse::<f64>()
        .unwrap()
        / 100.0;
    let l = values
        .next()
        .unwrap()
        .trim_end_matches('%')
        .parse::<f64>()
        .unwrap()
        / 100.0;
    [0.0, 8.0, 4.0].map(|n| {
        let k = (n + h / 30.0) % 12.0;
        let channel = l - s * l.min(1.0 - l) * (k - 3.0).min(9.0 - k).clamp(-1.0, 1.0);
        (channel * 255.0).round() as u8
    })
}

#[test]
fn the_recording_brightness_stays_in_range() {
    for (level, expected) in [
        (f32::NAN, 102),
        (-1.0, 102),
        (0.0, 102),
        (1.0, 255),
        (2.0, 255),
    ] {
        assert_eq!(
            pattern(DeviceState::Listening, 0, level, None).brightness,
            expected
        );
    }
    assert!((0..6_000).all(|ms| !pattern(Unpaired, ms, 0.0, None).on));
    assert!((0..6_000).all(|ms| !pattern(Unpaired, ms, 0.0, Some("1\n")).on));
}
