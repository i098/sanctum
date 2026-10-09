# Fullscreen listening design contract

The user's final choice is a quiet, fullscreen, Jarvis-like listening surface.
Preserve the recognizable fluctuating bar and overall composition almost 1:1.
The original application source is otherwise absent.
On explicit request, the waveform and the side live updates are ported one-to-one from the earlier Sanctum kiosk (42nights/sanctum `web-app/src/pages/kiosk`); nothing else from that source was copied.
The SVG/HTML references here are illustrations made from the approved visual decisions.

## Composition at 1280 × 720

- Canvas fills the viewport with near-black `#0a0c10`.
- Header begins about 32 px from each horizontal edge and 28 px from the top.
- Upper left: small Sanctum wordmark, then a compact local time/date block.
- Upper right: the open meeting's title (its start time when it has no title) and a quiet participant/duration line; with no open meeting, the corner stays empty.
- The waveform is the kiosk's 760 px line (at most 92% of the viewport width), centered horizontally with its baseline around y=316 in the reference composition; narrower lines scale every size with it, as the kiosk's canvas did.
- Its canvas covers the viewport, so loud needles and their glow keep their full shape instead of being cut flat at the kiosk's 300 px stage edges.
- The stage remains mostly empty around narrow spikes.
- Below the waveform: small lowercase `listening` status and one quiet helper line, starting 220 px under the baseline (the deepest underside measured at full-scale input plus its glow), so ink never runs under text. While browser captions run, a second helper line, at most 300 px wide, says that live captions use the browser's speech service (in Chrome, Google's).
- Footer sits approximately 24–32 px from the bottom and sides.
- Lower left: a tiny state dot and brief capture/context health text.
- Lower right: Pause, End meeting (only while a meeting is open, after one confirmation), Review, Agents, Fullscreen, Settings.
- Side live updates sit in the band from the status down to the footer, beside the status: the live transcript rail on the left, the agent-work feed on the right (see "Side live updates").
- No permanent sidebar, large heading, or cards on the default screen.

Keep proportions responsive rather than treating these measurements as absolute at every resolution.
A smaller laptop should retain the same visual hierarchy and avoid scrolling on the main listening screen.
On phones the status tucks under the waveform, the rails stack full width above a two-row footer, and an empty agent-work feed is hidden.
End meeting has no room in the phone control row, so it takes its own line above it, and the rails end higher by that line.
After End meeting, the helper line says that the meeting ended and that its notes are being prepared in Review, until capture starts again.

## Tokens

| Token | Value |
| --- | --- |
| Background | `#0a0c10` |
| Raised overlay | `#12161e` |
| Subtle surface | `#171c26` |
| Divider | `#222936` |
| Primary text | `#e7ecf3` |
| Secondary text | `#a7adb8` |
| Muted text | `#8b919c` |
| Blue accent | `#3d7dff` |
| Cyan state accent | `#22d3c5` |
| Amber warning | `#f2a23b` |
| Waveform ink | Pale white mixed 62/38 with the state accent: about `#a9c4f9` idle, `#9fe5e3` listening |
| Live dot / done | Lime `#c6f24e` |
| Failed | Red `#ff5d5d` |

Use the system sans-serif stack for readable content and a system monospace stack for tiny state/navigation labels.
Header labels are roughly 10–14 px; status below the waveform is roughly 12 px.
Muted information remains readable; do not use unreadably low opacity as the only way to make the screen quiet.

## Waveform geometry

Canvas 2D, ported from the kiosk's orb canvas: a thin continuous baseline carrying 33 slots.
Each slot has a jittered position, a needle half-width, an underside ratio between 0.45 and 1, a breathing phase and one shuffled spectrum band, fixed per page load.
Peaks are sharp needles (steep power falloff) with a wide, shallow ink-bleed base, drawn as one closed shape around the baseline; they are not rounded equalizer bars.
The underside is asymmetric rather than a perfect mirror.
Amplitude fades toward the edges and the line keeps a stable visual identity between frames.
The glow is a canvas shadow in the state colour that grows with the overall level; avoid bright neon gradients or a large halo.

## Motion

- Listening reacts to actual microphone spectrum and level, with no associated sound: each slot follows its band with fast attack and slow decay.
- State looks follow the kiosk table: stopped and paused use its idle look, starting and reconnecting its connecting look, listening and degraded its listening look; changes tween over 0.9 s with a quartic ease-out.
- Only listening states read the microphone; every other state breathes gently without reacting to audio, so the line never implies audio is being captured or saved.
- Quiet input returns toward a thin, gently breathing line.
- Steady room noise, such as hum, fans and hiss, becomes a per-band noise floor within a few seconds and draws the same calm line. Only sound above that floor, such as speech, moves the needles. The capture stream stays unprocessed apart from echo cancellation.
- The requested speaking state may react to output audio, but background work never causes unsolicited sound.
- Reduced-motion mode draws about four frames a second at 45% amplitude, skips rail motion, and keeps state readable without affecting capture.
- Stop drawing when the page is hidden; do not stop microphone capture solely because the canvas stops drawing.
- Simulated animation in the design reference is not production behavior.

## Side live updates

Both rails are bottom-anchored in the band from the status down to the footer and show whole lines only; whatever the band cannot fit is dropped or hidden, never cut mid-line.

- Transcript rail (left, under a `LISTENING` eyebrow): final live transcript segments from the listener stream, prefixed `S0:`-style when the speaker is known; partial segments never appear. Newest at the bottom, sliding up 6 px over 0.2 s; the band shows only whole lines that fit below the waveform, so short screens such as 1280×720 show fewer, never more than ten, and the oldest collapses over 0.3 s. The three newest lines use secondary text, older ones the muted colour, never dimmer. The eyebrow dot pulses lime only while listening.
- Browser captions (in the transcript rail, same line style): while capture runs, the browser's own speech recognition (Web Speech API, interim results) shows the utterance in progress word by word at the bottom of the rail, restarting whenever the browser ends a session. They are display-only: never sent to the server, stored, or fed to the speech gate. A final server segment replaces every browser word shown before it arrived. An utterance taller than the rail shows only its tail after an ellipsis. Pause, stop, a recognition error, or a browser without recognition (Firefox) leaves only server segments.
- Agent-work feed (right, under an `AGENT WORK` eyebrow): the actions of the open meeting this listener captures, each with its readable title (the request's own, else a label made from the action key, never the raw key), an icon and a truthful state label. A long title stops at two lines with an ellipsis, the status keeps the row's right edge, and the row's tooltip holds the full title. It keeps the latest five and shows only the whole rows that fit the band below the waveform, so short screens such as 1280×720 show fewer. New rows slide in from 24 px right over 0.5 s, the oldest beyond five collapses over 0.4 s, rows older than the newest two rest at 40%, and a row turning done flashes its lime edge. When the meeting closes, is interrupted or is replaced by another, every row collapses. Rows arrive as `action_update` messages on the listener stream: a snapshot on every connect and reconnect, then each change within about a second; the page never polls for them. The feed shows the live meeting’s agent work while the page is listening: a pause, a stop or a server rejection ends the stream for good and collapses every row (the resume snapshot refills them), before capture it stays empty, and an unexpected drop keeps the rows until the reconnect snapshot.

## Secondary views

Review, Agents, and Settings open only on request.
Use restrained dark overlays and the same tokens; closing them returns to the listening screen without stopping capture.
Review contains Notes, Transcript, Recording, Memory, Context, and Activity.
Source timestamps support navigation from a decision to transcript to authorized audio playback.
Settings shows the website sign-in state: signed in (name and role, Connect sign-in and Sign out only when a sign-in issuer is configured), signed out (a Sign in link), not configured (no route, or a non-JSON or 4xx answer from `/auth/config`) or unavailable (network error or 5xx).
On a server whose organizations come from WorkOS (hosted), the Workspace row adds a Team action for owners and admins of a linked workspace, and for the owner of an unlinked one, whose Team offers Set up team first; it opens Team over Settings with the WorkOS profile and members widgets on the same tokens, and full screen on phones.
Signed out, the helper line under the status becomes a Sign in to listen link. A sign-in redirect that ends without a session (`/?signin=not_member|failed|unconfigured`) opens Settings once with the reason; `not_member` shows the issuer and subject for the operator.
With the self-hosted embedded issuer, Settings adds a Profile row (Edit: display name and password) and a Team action on the Workspace row; both open a dialog over Settings, and Team lists members and roles; owners and admins also see pending invitations with a copyable invitation link.
Keep controls keyboard-accessible, trap focus correctly in dialogs, and return focus on close.

## Acceptance

Compare an implementation screenshot with `design/listener-reference.svg` at 1280 × 720.
Check header/footer placement, waveform width and baseline, the rails' band, empty space, colors, typography scale, and absence of dashboard furniture.
Check a real audio sample for sharp/asymmetric peaks, quick attack, slow release, and silence on all passive transitions.
The reference is a layout/motion target, not an exact audio waveform to replay.
