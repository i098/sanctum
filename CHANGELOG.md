# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Internal: base images come from the `mirror.gcr.io` mirror, because ECR Public refused anonymous CI pulls ([#194](https://github.com/i098/sanctum/issues/194)).

## [0.1.0] - 2026-10-14

### Added

- The listen stream pushes readable agent-work updates ([#1](https://github.com/i098/sanctum/issues/1)).
- The listening page shows live captions word by word ([#18](https://github.com/i098/sanctum/issues/18)).
- MCP accepts bearer tokens with default scopes ([#16](https://github.com/i098/sanctum/issues/16)).
- Voice and extraction models run on Cloudflare Workers AI ([#19](https://github.com/i098/sanctum/issues/19)), and live and batch audio is transcribed with Workers AI Whisper ([#29](https://github.com/i098/sanctum/issues/29)).
- Sign-in: the sign-in decision and config contract is recorded ([#17](https://github.com/i098/sanctum/issues/17)); any OIDC provider works, with a first-owner CLI ([#20](https://github.com/i098/sanctum/issues/20)); self-hosted installs get an embedded Better Auth issuer ([#30](https://github.com/i098/sanctum/issues/30)), organizations and a team UI ([#56](https://github.com/i098/sanctum/issues/56)); the hosted site uses WorkOS AuthKit ([#41](https://github.com/i098/sanctum/issues/41)), with organization sync and self-serve workspaces ([#43](https://github.com/i098/sanctum/issues/43)), Team widgets ([#61](https://github.com/i098/sanctum/issues/61)), and a way for owners to link an existing workspace ([#67](https://github.com/i098/sanctum/issues/67)).
- Provider organizations link to workspaces ([#15](https://github.com/i098/sanctum/issues/15)), and each workspace has a seat limit ([#27](https://github.com/i098/sanctum/issues/27)).
- The website shows sign-in states and a sign-out control ([#28](https://github.com/i098/sanctum/issues/28)).
- Workspaces can be deleted, with a soft delete and a durable purge ([#33](https://github.com/i098/sanctum/issues/33)).
- An End meeting control closes a meeting, and a meeting closes after 10 idle minutes ([#52](https://github.com/i098/sanctum/issues/52)).
- A landing page at the apex address ([#76](https://github.com/i098/sanctum/issues/76)) and a first-run welcome onboarding ([#86](https://github.com/i098/sanctum/issues/86)).
- The listening view warns about a silent microphone and has an input picker ([#83](https://github.com/i098/sanctum/issues/83)).
- The app, API and MCP are served from `app.sanctum.42nights.dev` ([#74](https://github.com/i098/sanctum/issues/74)).
- A Pipedream Connect flow for integrations ([#107](https://github.com/i098/sanctum/issues/107)).
- Spoken requests that the model selects start research jobs ([#94](https://github.com/i098/sanctum/issues/94)).

### Changed

- Planning uses Workers AI Qwen ([#100](https://github.com/i098/sanctum/issues/100)), spoken work decisions use Cerebras ([#108](https://github.com/i098/sanctum/issues/108)), and speech output uses Cloudflare Aura-2 instead of Cartesia ([#101](https://github.com/i098/sanctum/issues/101)).
- Handoff files moved under `docs/build`, and the repository has community health files and a PR template ([#118](https://github.com/i098/sanctum/issues/118), [#113](https://github.com/i098/sanctum/issues/113)).
- Internal: base images come from the `public.ecr.aws` mirror, the Sentrux gate allows quality drops up to 250 points, and one listener feed test is restored ([#89](https://github.com/i098/sanctum/issues/89), [#98](https://github.com/i098/sanctum/issues/98), [#34](https://github.com/i098/sanctum/issues/34)).

### Fixed

- The listening header shows the open meeting and retries its read after a failure ([#5](https://github.com/i098/sanctum/issues/5), [#24](https://github.com/i098/sanctum/issues/24)).
- The listening view shows why live transcription is degraded, clears the warning once it recovers, and says when browser captions are unavailable ([#6](https://github.com/i098/sanctum/issues/6), [#72](https://github.com/i098/sanctum/issues/72), [#80](https://github.com/i098/sanctum/issues/80)).
- Listen says "You are not signed in." on a 401, and the Sign in links are visible and clickable on the landing and listen pages ([#4](https://github.com/i098/sanctum/issues/4), [#78](https://github.com/i098/sanctum/issues/78), [#59](https://github.com/i098/sanctum/issues/59)).
- The listening page sends the CSRF header from its SDK client ([#46](https://github.com/i098/sanctum/issues/46)), and a tab icon stops the `/favicon.ico` 404 ([#7](https://github.com/i098/sanctum/issues/7)).
- The listening waveform no longer jitters ([#81](https://github.com/i098/sanctum/issues/81)), and sign-in is confirmed after self-serve workspace creation ([#92](https://github.com/i098/sanctum/issues/92)).
- Settings shows the signed-in account instead of "Owner" ([#79](https://github.com/i098/sanctum/issues/79)).
- Live Whisper transcription keeps up with continuous speech and drops filler on silent audio ([#66](https://github.com/i098/sanctum/issues/66), [#47](https://github.com/i098/sanctum/issues/47)).
- End meeting is final, and late audio no longer creates a ghost meeting ([#65](https://github.com/i098/sanctum/issues/65)).
- A detected meeting's owner gets access for the capturing principal ([#12](https://github.com/i098/sanctum/issues/12)), the meeting title comes from the generated notes ([#44](https://github.com/i098/sanctum/issues/44)), and context refresh is scheduled during live meetings ([#45](https://github.com/i098/sanctum/issues/45)).
- Containers restart when their start settings change, and they receive the provider and model settings ([#54](https://github.com/i098/sanctum/issues/54), [#3](https://github.com/i098/sanctum/issues/3)).
- Accepted research requests now run, and a spoken research request answers "Looking that up." ([#95](https://github.com/i098/sanctum/issues/95), [#111](https://github.com/i098/sanctum/issues/111)).

### Security

- The Cloudflare Worker no longer contains a secret login link ([#63](https://github.com/i098/sanctum/issues/63)).

[Unreleased]: https://github.com/i098/sanctum/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/i098/sanctum/releases/tag/v0.1.0
