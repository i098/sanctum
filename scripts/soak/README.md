# Soak driver

`drive.ts` plays one canonical mono PCM16 WAV into a Sanctum API at real speed, as a live listener (issue #154).
Header comment in the file has the full contract.

```bash
SANCTUM_SOAK_TOKEN=... node scripts/soak/drive.ts --base-url https://<host> --audio day.wav --state-dir <dir> \
  [--kill-file <path>] [--max-usd 15] [--baseline-usd 0] [--max-seconds N] [--name soak-driver]
```

- **Token**: the soak workspace owner's token, with `capture:ingest`, `context:read` and `context:write`. One principal registers the listener, streams and shares; an enrolled device cannot share.
- **Kill switch**: create `<state-dir>/KILL` (or `--kill-file`), or send SIGINT, SIGTERM or SIGUSR2. The driver ends the epoch, uploads the last chunk, shares meetings and exits 0. A kill file left from an earlier run stops the next start.
- **Cost hard stop**: exit 3 when `baseline + speech minutes x (Whisper + extraction ceiling) + run seconds x container + chunk PUTs x R2` reaches `--max-usd`. Rates are in `RATES` (fetched 2026-10-14; extraction is a ceiling, since the API does not meter it). Pass the audio-build spend as `--baseline-usd`.
- **Resume**: `<state-dir>/driver.json` (mode 600) keeps the listener, the acknowledged offset, cumulative units and counters. A restart continues in a new epoch from the offset.
- **Output**: one JSON line per event on stdout; `status` every 30 s. `speech_chunks` must stay 0, so the audio must never address Sanctum.
