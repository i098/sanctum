use sanctum_listener_core::wire::{Start, frame, wav_header};
use serde::Deserialize;
use serde_json::{Value, value::RawValue};

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[test]
fn matches_shared_device_wire_fixture() {
    const WIRE: &str = include_str!("../../../../packages/contracts/fixtures/device-wire.json");
    #[derive(Deserialize)]
    struct Fixture<'a> {
        #[serde(borrow)]
        start: &'a RawValue,
    }
    let fixture: Value = serde_json::from_str(WIRE).unwrap();
    let raw = serde_json::from_str::<Fixture>(WIRE).unwrap().start.get();
    let start: Start = serde_json::from_str(raw).unwrap();
    let compact: String = raw
        .lines()
        .map(|line| line.trim().replacen("\": ", "\":", 1))
        .collect();
    assert_eq!(serde_json::to_vec(&start).unwrap(), compact.as_bytes());
    for item in fixture["frames"].as_array().unwrap() {
        let cycle = item["sample_cycle"].as_array().unwrap();
        let samples: Vec<_> = cycle
            .iter()
            .cycle()
            .take(item["sample_count"].as_u64().unwrap() as usize)
            .flat_map(|sample| (sample.as_i64().unwrap() as i16).to_le_bytes())
            .collect();
        assert_eq!(
            hex(&frame(
                item["track"].as_u64().unwrap() as u16,
                item["sequence"].as_u64().unwrap() as u32,
                item["sample_start"].as_u64().unwrap(),
                &samples,
            )),
            item["hex"].as_str().unwrap()
        );
    }
    let wav = &fixture["wav"];
    assert_eq!(
        hex(&wav_header(wav["sample_count"].as_u64().unwrap() as u32)),
        wav["header_hex"].as_str().unwrap()
    );
}
