# Sanctum

A silent, website-first meeting memory and shared context layer for people and agents.

This private repository is an implementation handoff only.
It contains no legacy application source, credentials, recordings, or production data.
Build the application independently from the contracts below.

## Start here

1. Read [HANDOFF.md](HANDOFF.md), the copy-ready instruction for one integrated implementation run.
2. Read [tasks/plan.md](tasks/plan.md), the complete architecture and behavior contract.
3. Execute [tasks/todo.md](tasks/todo.md) in order and record evidence for each checkpoint.
4. Match [docs/DESIGN.md](docs/DESIGN.md) and the [visual reference](design/listener-reference.html) closely.
5. Resolve the remaining product settings in [docs/DECISIONS.md](docs/DECISIONS.md) before activating dependent production behavior.

Give your coding agent this instruction:

> Read AGENTS.md and HANDOFF.md, then implement tasks/plan.md using tasks/todo.md. Build from scratch; do not import the old application. Preserve the approved fullscreen fluctuating waveform. Complete reversible implementation and local validation autonomously, and report any unresolved live-deployment requirements separately.

## What to build

- Browser microphone capture with a fullscreen, listening-first interface.
- Silent notes, research, and previously authorized background actions.
- Automatic isolated meetings with manual split and merge.
- Complete transcripts, private R2 recordings, and selective time-aware memory.
- Speaker attribution with explicit/verified identity mappings.
- MySQL-backed shared context for the website, TypeScript/Python SDKs, and remote MCP.
- Pipedream discovery through three fixed gateways: search, inspect, and request action.

The listener tab must stay open and the device awake to record.
Server-side jobs can continue after the tab closes.

## Selected stack

React, TypeScript, Vite, Tailwind, Canvas/Web Audio, WebRTC, Pipecat, Python 3.12, FastAPI, Pydantic, MySQL 8.4/InnoDB, Cloudflare R2, Pipedream, and FastMCP.
The full stack, model-role choices, and evaluation gates appear in plan section 04.

## Visual target

![Fullscreen listening reference](design/listener-reference.svg)

This is an independently authored visual reference matching the approved layout, not copied legacy application code or a runtime screenshot.
The HTML reference adds illustrative motion without accessing a microphone.
The implementation should reproduce the layout, proportions, colors, sparse controls, and waveform character almost 1:1; the actual waveform must react to real audio.

## Review and validation

```bash
python3 scripts/validate_handoff.py
python3 scripts/render_handoff.py
python3 -m http.server 8080
```

Open `http://localhost:8080/index.html` for the visual implementation document or `http://localhost:8080/design/listener-reference.html` for the design target.
The documentation renderer's Mermaid/code viewers need network access; Markdown and the design reference remain usable offline.
If Lavish is installed, run `lavish-axi index.html` for annotations.

The validation script checks this handoff's integrity, not application behavior.
There is no production implementation to run yet.
