# Soak driver

`drive.ts` plays canonical mono PCM16 WAV audio into a Sanctum API at real speed, as a live listener (issue #154).
Header comment in the file has the full contract.

```bash
SANCTUM_SOAK_TOKEN=... node scripts/soak/drive.ts --base-url https://<host> (--audio day.wav | --manifest corpus/manifest.json) --state-dir <dir> \
  [--kill-file <path>] [--max-usd 15] [--baseline-usd 0] [--max-seconds N] [--name soak-driver]
```

- **Audio**: `--audio` plays one WAV. `--manifest` plays the corpus from `build-corpus.ts`: each meeting's WAV at its `start_s`, silence in the gaps, so a sample's position is its offset from T0. At run start the driver writes T0 (when sample 0 was captured) into the manifest's `t0.epoch_s`; a restart keeps it.
- **Event times**: every epoch is stamped with the real time, so an outage (kill, crash, cost-stop restart) delays all later audio by its length. A fact's event time is then not `t0 + at_s`: read `actual_at[fact id]` in `<state-dir>/driver.json`, the real capture time of the fact's first sample as streamed. `outages` lists each epoch after the first with its position `at_s` and the cumulative delay `lag_s` behind T0.
- **Token**: the soak workspace owner's token, with `capture:ingest`, `context:read` and `context:write`. One principal registers the listener, streams and shares; an enrolled device cannot share.
- **Kill switch**: create `<state-dir>/KILL` (or `--kill-file`), or send SIGINT, SIGTERM or SIGUSR2. The driver ends the epoch, uploads the last chunk, shares meetings and exits 0. A kill file left from an earlier run stops the next start.
- **Cost hard stop**: exit 3 when `baseline + speech minutes x (Whisper + extraction ceiling) + run seconds x container + chunk PUTs x R2` reaches `--max-usd`. Rates are in `RATES` (fetched 2026-10-14; extraction is a ceiling, since the API does not meter it). Pass the audio-build spend as `--baseline-usd`.
- **Resume**: `<state-dir>/driver.json` (mode 600) keeps the listener, the acknowledged offset, cumulative units, counters, `actual_at` and `outages`. A restart continues in a new epoch from the offset. After a rejection the driver backs off (1 s doubling to 30 s) before it reconnects.
- **Output**: one JSON line per event on stdout; `status` every 30 s. `speech_chunks` must stay 0, so the audio must never address Sanctum.
