# Fullscreen listening design contract

The user's final choice is a quiet, fullscreen, Jarvis-like listening surface.
Preserve the recognizable fluctuating bar and overall composition almost 1:1.
The original application source is intentionally absent.
The SVG/HTML references here are independent illustrations made from the approved visual decisions.

## Composition at 1280 × 720

- Canvas fills the viewport with near-black `#0a0c10`.
- Header begins about 32 px from each horizontal edge and 28 px from the top.
- Upper left: small Sanctum wordmark, then a compact local time/date block.
- Upper right: current meeting title and a quiet participant/duration line.
- The waveform spans approximately 760 px, centered horizontally, with its baseline around y=316 in the reference composition.
- Waveform drawing area is approximately 760 × 300; its area remains mostly empty around narrow spikes.
- Below the waveform: small lowercase `listening` status and one quiet helper line.
- Footer sits approximately 24–32 px from the bottom and sides.
- Lower left: a tiny state dot and brief capture/context health text.
- Lower right: Pause, Review, Agents, Fullscreen, Settings.
- No permanent sidebar, large heading, cards, transcript rail, or agent dialogue feed on the default screen.

Keep proportions responsive rather than treating these measurements as absolute at every resolution.
A smaller laptop should retain the same visual hierarchy and avoid scrolling on the main listening screen.

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
| Waveform fill | Pale blue-white, approximately `#b9c4f9` |

Use the system sans-serif stack for readable content and a system monospace stack for tiny state/navigation labels.
Header labels are roughly 10–14 px; status below the waveform is roughly 12 px.
Muted information remains readable; do not use unreadably low opacity as the only way to make the screen quiet.

## Waveform geometry

Reimplement the drawing independently with Canvas 2D or another native rendering primitive.
Use a thin continuous horizontal baseline with roughly 33 irregular regions capable of forming spikes.
Peaks are sharp needles with small broad bases, not rounded vertical equalizer bars.
The underside is asymmetric rather than a perfect mirror.
Amplitude is concentrated away from the edges and the line has a stable visual identity between frames.
A subtle blue glow surrounds pale ink; avoid bright neon gradients or a large halo.

## Motion

- Listening reacts to actual microphone energy/spectrum, with restrained amplitude and no associated sound.
- Use quick attack and slower release so speech peaks feel responsive without jitter.
- Quiet input returns toward a thin line with very subtle movement; it does not imply audio is being saved successfully.
- Paused input settles to a subdued line and changes the visible state.
- The requested speaking state may react to output audio, but background work never causes unsolicited sound.
- Reduced-motion mode keeps state readable and limits decorative movement without affecting capture.
- Stop drawing when the page is hidden; do not stop microphone capture solely because the canvas stops drawing.
- Simulated animation in the design reference is not production behavior.

## Secondary views

Review, Agents, and Settings open only on request.
Use restrained dark overlays and the same tokens; closing them returns to the listening screen without stopping capture.
Review contains Notes, Transcript, Recording, Memory, Context, and Activity.
Source timestamps support navigation from a decision to transcript to authorized audio playback.
Keep controls keyboard-accessible, trap focus correctly in dialogs, and return focus on close.

## Acceptance

Compare an implementation screenshot with `design/listener-reference.svg` at 1280 × 720.
Check header/footer placement, waveform width and baseline, empty space, colors, typography scale, and absence of dashboard furniture.
Check a real audio sample for sharp/asymmetric peaks, quick attack, slow release, and silence on all passive transitions.
The reference is a layout/motion target, not an exact audio waveform to replay.
