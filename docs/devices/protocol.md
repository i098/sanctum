# Sanctum hardware listener protocol

A listener needs a microphone, network access, and a screen or a light.
Use HTTPS for the API and WSS for live audio.
The server cannot confirm that a physical indicator works. Implement the [recording indication rules](#recording-indication) on the device.

## Pairing and credentials

The endpoints below start with `/api/v1` and use JSON.
Protected endpoints require a human principal with `capture:ingest` and `context:write`.
When you use a browser session, send its CSRF header on approval and revocation.

| Method and path | Auth | Request | Success |
| --- | --- | --- | --- |
| `POST /device/authorize` | None | `{name, capabilities}` | `200` `{device_code, user_code, verification_uri, verification_uri_complete, expires_in: 600, interval: 5}` |
| `POST /device/token` | None | `{grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code}` | `200` `{access_token, token_type: "Bearer", device_id, workspace_id, approved_by_name, workspace_name}` once |
| `GET /device/pending?user_code=…` | Session | Pairing code in query | `200` `{name, capabilities, expires_at}` |
| `POST /device/approve` | Session | `{user_code, approve}` | `200` device |
| `GET /devices` | Session | None | `200` `{items: Device[]}` |
| `DELETE /devices/{device_id}` | Session | None | `204` |

`name` has 1 to 200 characters. `approve` is a boolean.
The capabilities object is `{mic: true, screen: boolean, light: "none"|"mono"|"pwm"|"rgb", speaker: boolean}`.
Set `screen` to `true` or choose a light other than `none`.
A device object has `id`, `name`, `capabilities`, `status`, `approved_by`, `created_at`, `approved_at`, `last_used_at`, and `revoked_at`.
`status` is `pending`, `approved`, `denied`, or `revoked`.
`approved_by` is a principal or `null`. Times are UTC ISO timestamps or `null` except `created_at`.

The `device_code` contains 32 random bytes in unpadded base64url. Keep it private.
Display the `user_code` as eight decimal digits in `1234-5678` form.
The server ignores hyphens and spaces in the user code.
Show the verification URL `<origin>/pair`. The complete URL includes the code, for example `<origin>/pair?code=12345678`.
Do not open the microphone during pairing.

Wait five seconds between token polls. A token failure returns HTTP `400` with `{error}`:

| `error` | Device action |
| --- | --- |
| `authorization_pending` | Wait for the next poll. |
| `slow_down` | Add five seconds to the interval for all further polls in this pairing attempt. |
| `access_denied` | Stop polling. The person denied the request. |
| `expired_token` | Stop polling. The ten-minute approval window ended. |
| `invalid_grant` | Stop polling. The code is unknown or the server already issued the token. |

Pending lookup returns `404` for an unknown, expired, or used code.
The sixth wrong code from one principal in ten minutes returns `403`.
One IPv4 address or IPv6 /64 prefix can have at most five pending codes.
Authorization removes expired rows and returns `503` when 1,000 pending rows fill the limit.
Sanctum stores hashes of both codes and the token, not their plain values.
Approval creates a non-expiring token for the approver with only `capture:ingest`. The device uses no seat.
The device can redeem an approval once, up to 60 seconds after the approval window ends.
If the device does not receive the token response, revoke the device in Settings and pair it again.
The token can capture only through listeners that this device registers.
Keep the token in private storage. Send it in `Authorization: Bearer <token>` with each capture request.
Show the approver and workspace names on the screen or terminal after pairing.
The approver sees their devices. A workspace administrator can see and revoke all devices in the workspace.
Device credentials do not appear in the agent list. The pairing API is not in MCP.

## Listener and live audio

1. Register with `POST /api/v1/listeners` using `{name, mode: "room", capabilities: {device: capabilities}}`. Keep the returned `id` with the token.
2. Claim the lease with `POST /api/v1/listeners/{id}/heartbeat` and `lease_generation: 0`.
3. Send a heartbeat every 15 seconds with the returned generation. The lease lasts 45 seconds.
4. Show the recording indication. Open the microphone only after the indication succeeds.
5. Upgrade `GET /api/v1/listeners/{id}/stream` with the bearer header and no `Origin` header.
6. Send a JSON `start` text frame within ten seconds. Wait for `accepted` before sending audio.

A heartbeat has `lease_generation`, `state`, `epoch_id`, `buffered_chunks`, and `storage_bytes_free`.
Use `null` for the epoch before capture and for unknown free storage.
Do not send heartbeats in `unpaired`. Report `stopped` in `error`; other states use their names.
A receipt contains `lease_generation`, `lease_expires_at`, and `owner`.

The `start` object has `_tag: "start"`, `protocol_version: 1`, `listener_id`, `epoch_id`, `track`, `lease_generation`, and `capabilities`.
Use a new UUID for each new epoch. A `track` is an unsigned 16-bit number.
Include `clock: {sample_rate: 16000, channels: 1, encoding: "pcm_s16le", sample_start, captured_at, timezone}`.
Use a UTC ISO timestamp for `captured_at` and an IANA timezone such as `UTC`.
`clock.sample_start` is the sample index at that timestamp, normally `0` in a new epoch.
See the [golden fixture](../../packages/contracts/fixtures/device-wire.json) for a complete `start` and matching binary frames.

Devices send capabilities on each `start`. The server saves the last declaration under `device` in the listener capabilities.
An invalid declaration receives `rejected` with reason `invalid_start` and close code `1008`.
A browser can omit capabilities. Its default is `{mic: true, screen: true, light: "none", speaker: true}`.
A socket that sends `capabilities` cannot start spoken work. It does not receive `speech_chunk`, `speech_cancel`, or `action_update`.
Only browser sockets receive vocabulary prompts.

Every value longer than one byte uses little-endian order. The header is 24 bytes.

| Offset | Type | Value |
| --- | --- | --- |
| 0 | `u8` | Version `1` |
| 1 | `u8` | Frame kind `1` (mono PCM16 LE) |
| 2 | `u16` | Track from `start` |
| 4 | `u32` | Frame sequence within the epoch |
| 8 | `u64` | First sample index, from `0` to `2^53 - 1` |
| 16 | `u32` | Sample count, from `1` to `9600` |
| 20 | `u32` | Reserved, `0` |
| 24 | `i16[]` | Exactly the declared number of samples |

Send 20 to 100 ms of audio per frame. At 16 kHz, 20 ms has 320 samples and uses 664 bytes.
The maximum frame size across supported rates is 19,224 bytes. The server accepts only PCM audio.
The server sends `ack` for live progress. It discards audio already covered by the live watermark.
Control frames are JSON. In addition to `accepted`, `rejected`, and `ack`, the server can send `degraded`, `recovered`, `transcript`, `speech_chunk`, `speech_cancel`, and `action_update`.
The client ends live capture with `{"_tag":"stop","reason":"close"}`. Other stop reasons are `pause`, `device_change`, and `interrupted`.

If the socket drops, keep recording to disk and show `reconnecting`. Retry the socket every two seconds with the same epoch and clock.
Continue live audio from the current sample after `accepted`, at or beyond `resume_from_sample`. Send the gap as archive chunks.
Treat close code `1013` as a retry. On `epoch_closed`, start a new epoch.
On `stale_generation` or `owner: false`, close the microphone and show `stopped`. Claim the lease and start a new epoch.
On heartbeat `401`, close the microphone, delete the token, and show `unpaired`.
A revoked device sees `401` by its next heartbeat plus the request time.
The server ends its open epoch after the 45-second lease lapses and the worker runs its sweep.

## Durable audio

The WebSocket is the live path, not a durable recording receipt.
If the server never accepted an epoch, send `start` with `archive_only: true` before you upload its chunks.
Send independent WAV chunks to `PUT /api/v1/listeners/{id}/chunks/{chunk_id}` with `Content-Type: audio/wav`.
Set `x-sanctum-manifest` to a JSON object with `chunk_id`, `listener_id`, `epoch_id`, `track`, `sequence`, `sample_start`, `sample_count`, `sample_rate`, `captured_at`, `byte_length`, and `sha256`.
Use the epoch clock for sample positions and timestamps. Hash the full WAV with SHA-256 and send lowercase hexadecimal.
Keep each chunk on disk until the server returns a receipt. Retries must use the same ID and hash.
The reference client uses 30-second chunks (960,044 bytes). A microcontroller can send two-second chunks (64,044 bytes).

Use this canonical WAV header for 16 kHz mono PCM16. Let `n = sample_count * 2`.

| Offset | Bytes | Value |
| --- | --- | --- |
| 0 | 4 | ASCII `RIFF` |
| 4 | 4 | `36 + n` |
| 8 | 4 | ASCII `WAVE` |
| 12 | 4 | ASCII `fmt ` with a trailing space |
| 16 | 4 | `16`, format chunk size |
| 20 | 2 | `1`, PCM |
| 22 | 2 | `1`, mono |
| 24 | 4 | `16000`, samples per second |
| 28 | 4 | `32000`, bytes per second |
| 32 | 2 | `2`, block alignment |
| 34 | 2 | `16`, bits per sample |
| 36 | 4 | ASCII `data` |
| 40 | 4 | `n` |
| 44 | `n` | PCM16 LE audio |

## Recording indication

A mono light uses only on and off. A PWM light adds brightness. An RGB light adds color.
Each pattern starts with a lit interval. The durations alternate between lit and dark, then repeat.
Begin each non-recording state with a 300 ms dark interval before the first pattern.
Apply changes between recording-visible light patterns at the end of the current one-second period.
The reference indicator writes at 50 Hz.

| State | Microphone | Screen | Color | Pattern in ms |
| --- | --- | --- | --- | --- |
| `unpaired` | Closed | Device name, pairing code and verification URL | `hsl(220 100% 62%)` | Each digit: 200 on, 200 off for each blink. Zero uses ten blinks. Add 1,000 dark between digits and 3,000 dark before repeating. |
| `stopped` | Closed | `stopped`, idle waveform, `Not listening.` | `hsl(220 100% 62%)` | 100, 3900 |
| `paused` | Closed | `paused`, idle waveform, `Paused. The microphone is off.` | `hsl(220 100% 62%)` | 100, 200, 100, 3600 |
| `starting` | Closed | `starting`, connecting waveform | `hsl(220 100% 62%)` | 250, 250 |
| `listening` | Open | `listening`, microphone waveform, `Recording.`, saved-through time | `hsl(175 72% 48%)` | Steady on. For PWM and RGB use `40% + 60% × level`. |
| `reconnecting` | Open | `reconnecting`, connecting waveform, `Recording on this device. Server not reachable.` | `hsl(34 88% 59%)` | 900, 100 |
| `degraded` | Open | `degraded`, listening waveform, warning with the cause | `hsl(34 88% 59%)` | 760, 60, 120, 60 |
| `error` | Closed | `error`, cause, no waveform motion | `hsl(0 100% 68%)` | 100 on and 100 off three times, then 1,400 additional dark |

- **R1.** Light the indicator for at least 80% of every one-second window in `listening`, `reconnecting`, or `degraded`.
  Never leave it dark for more than 150 ms in those states.
  Show the current state on every screen frame and disable screen blanking.
- **R2.** Limit every lit interval to 300 ms in all other states. A steady light means the microphone is open.
- **R3.** Complete the `listening` indication before opening the microphone. Close the microphone before leaving a recording-visible state.
- **R4.** Close the microphone within one second of an indication failure and enter `error`.
- **R5.** Permit no external setting or server message to change the pattern, switch it off, or reduce its lit brightness below 40%.
- **R6.** Refuse to start with no screen and no light. The reference client exits with code `2`; the server rejects invalid `start` capabilities.

If possible, power the LED from the microphone supply rail so software cannot hide recording.
Use the [fixture](../../packages/contracts/fixtures/device-wire.json) to check the pattern at one-millisecond intervals for 60 seconds.
In its `segments_ms` arrays, even indexes are lit and odd indexes are dark. One lit segment represents a steady light.
Measure each pattern from the time the device enters the state.
The reference client supports mono and PWM lights. Other clients can also implement RGB.

The kiosk uses loopback `GET /events` with server-sent events.
Each event has `state`, `level`, `bands`, `code`, `verification_uri`, `name`, `cause`, `saved_through`, and `owner`.
`level` and the eight `bands` range from zero to one.
`owner` is `null` or `{approved_by_name, workspace_name}`.
The pairing code, verification URL, cause, and saved-through UTC time are `null` when unavailable.
Send 25 events per second in recording-visible states and one per second in other states.
While recording, treat two seconds with no connected kiosk as an indication fault.
