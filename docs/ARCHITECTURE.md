# Architecture and slice contracts

Pointer map for the parallel build of [tasks/todo.md](../tasks/todo.md).
Behavior is defined by [tasks/plan.md](../tasks/plan.md); this file fixes who owns which file and which names siblings import.

## Rules

- `fm/sanctum-build-v1` is the integration branch; every slice branches from it and merges back into it.
- A slice edits only files it owns below, plus one registration line in each hot file it is listed against.
- Changes to another slice's files, tables or contracts go through the integration branch, never directly.
- A slice may amend migration statements for its own tables until the pull request merges (nothing is deployed).
- When a sibling is not merged yet, build a stand-in at exactly its path and export name, headed `// stand-in: replaced by the <sibling> slice at integration`, or use a test-side fake.
- List every stand-in you created in your hand-off; integration keeps the real file and deletes the stand-in.
- Signatures below are the contract; extend them compatibly, never rename them.
- Run `npm run check:app` and the gates in [docs/CI.md](CI.md) before handing a slice back.

## Shared foundation (integration owner)

| Area | Where | Use |
| --- | --- | --- |
| Wire schemas | [packages/contracts/src](../packages/contracts/src/index.ts) | Branded IDs, `UtcTimestamp`, `SourceRange`, errors, every seam type; JSON-representable only. |
| Error envelope | [errors.ts](../packages/contracts/src/errors.ts) | `Unauthenticated` 401, `Forbidden` 403, `NotFound` 404, `RevisionConflict` 409, `HashConflict` 409, `Unavailable` 503. |
| HTTP contract | [api.ts](../packages/contracts/src/api.ts) | `SanctumApi`; each slice defines an `HttpApiGroup` in its contracts area file. |
| Live media | [media.ts](../packages/contracts/src/media.ts) | Binary PCM frame layout, `encodePcmFrame`, `decodePcmFrame`, control messages. |
| Listener device API | [capture.ts](../packages/contracts/src/capture.ts) | `ListenersApi` (register, heartbeat, `putChunk`), `LISTENER_STREAM_PATH`. |
| Test audio | [fixtures.ts](../packages/contracts/src/fixtures.ts) | `syntheticPcm` from `@sanctum/contracts/fixtures`. |
| Config | [server/src/config.ts](../server/src/config.ts) | `serverConfig`, `engineeringDefaults` (plan 02), `requireActivation` refuses production while decisions are open. |
| Database | [server/src/db.ts](../server/src/db.ts) | `dbLayer`, column schemas `DbUtc`, `DbSafeInt`, `DbBool`, `DbJson`, `DbSha256`, `mysqlErrno`. |
| Migrations | [server/src/migrate.ts](../server/src/migrate.ts) | Ledger, named lock, per-step resume; `npm run migrate --workspace server`. |
| Authorization seam | [server/src/auth.ts](../server/src/auth.ts) | `Authenticator` tag, `AuthenticatedLive`; `Authenticated` middleware and `CurrentAccess` live in contracts. |
| Object storage | [server/src/object-store.ts](../server/src/object-store.ts) | `ObjectStore` tag (`put`, `head`, `get`, `presignGet`), `ObjectStoreError.ambiguous`. |
| Jobs | [server/src/job-handlers.ts](../server/src/job-handlers.ts) | `ClaimedJob`, `JobOutcome`, `JobHandler`, `WorkerServices`, `jobHandlers`; `JobFailure` is in contracts. |
| Capture seam | [web-app/src/lib/capture/view.ts](../web-app/src/lib/capture/view.ts) | `CaptureView`, `CaptureSnapshot`, `LevelSource`, `createCaptureStore`. |
| Analyser levels | [levels.ts](../web-app/src/lib/capture/levels.ts) | `createAnalyserLevels(analyser, bandCount)` for the waveform. |
| Server tests | [server/tests/support](../server/tests/support/database.ts) | `withDatabase`, `seedWorkspace`, `fixtureAccess`, `memoryObjectStore`; one MySQL 8.4 per run. |

Conventions:

- IDs are UUID `CHAR(36) ascii_bin`; wall clock is `DATETIME(6)` UTC written with `UTC_TIMESTAMP(6)`; samples are `BIGINT UNSIGNED`.
- Owned rows reference each other through `(workspace_id, id)` foreign keys, so a row cannot point into another workspace.
- Decode rows only through `SqlSchema` plus the `db.ts` column schemas; never read `Date` or `Number` BIGINTs from mysql2.
- Domain functions take `access: AccessScope` first and never read credentials; unauthorized reads fail as `NotFound`.
- Tests use synthetic fixtures and fakes; no live provider, R2 or Pipedream call from any test.

## Slices

Each entry lists owned files, then the exact exports siblings import. `R` is `SqlClient.SqlClient` unless stated.

### kernel (T03, T05, job ledger core from T11/T19)

Owns `server/src/store.ts`, `server/src/auth.ts` (extends the foundation file), `server/src/agents.ts`, `server/src/cache.ts`, `server/src/jobs.ts` (replaces the stand-in), migrations `001_initial` and `004_jobs`, `packages/contracts/src/agents.ts`.

- `auth.ts`: `KernelAuthenticatorLive: Layer<Authenticator, never, R>`; main.ts swaps it for `UnconfiguredAuthenticator`.
- `auth.ts`: `resolveAccess(input: { workspace_id; principal_id }): Effect<AccessScope, Forbidden, R>` for workers and sockets.
- `auth.ts`: `authenticateUpgrade(request: IncomingMessage): Effect<AccessScope, Unauthenticated | Forbidden, R>` with the Origin allowlist.
- `auth.ts`: `requireScope(access, scope: AccessScopeName): Effect<void, Forbidden>`.
- `auth.ts`: `authorizeMeeting(access, meeting_id, need: 'read' | 'write'): Effect<void, NotFound, R>`.
- `auth.ts`: `listVisibleMeetingIds(access): Effect<ReadonlyArray<MeetingId>, SqlError, R>`.
- `jobs.ts`: `enqueueJob(input: EnqueueJob): Effect<JobId, SqlError, R>`, joining the caller's transaction.
- `jobs.ts`: `EnqueueJob = { workspace_id; kind: JobKind; work_key: string; payload: unknown; requested_by: PrincipalId | null; source_revision?: number; delay_ms?: number; max_attempts?: number }`; an active row with the same key is re-armed.
- `jobs.ts`: `runWorker(handlers: typeof jobHandlers): Effect<never, SqlError, WorkerServices>`.
- `store.ts`: `nextContextSeq(workspace_id): Effect<number, SqlError, R>` locks the workspace row; call inside the change's transaction.
- `store.ts`: `bumpPermissionRevision(workspace_id): Effect<number, SqlError, R>`.
- `cache.ts`: `scopedCacheKey(access, ...parts: ReadonlyArray<string | number>): string` including principal, permission and source revisions.
- contracts: `AgentsApi` with `createAgent`, `revokeCredential`.

### capture (T06, T07, browser half of T09)

Owns `web-app/src/lib/capture/{controller,permissions,recorder,recording-worklet,buffer,uploader}.ts`, `web-app/src/pages/listen/engine.ts`, their tests.

- `engine.ts`: `getCaptureEngine(): CaptureView`, a singleton above every overlay/router lifecycle.
- `controller.ts`: `createCaptureController(deps): CaptureView & { dispose(): void }`, publishing through `createCaptureStore`.
- Client of `ListenersApi`, `LISTENER_STREAM_PATH`, `StartMessage`, `encodePcmFrame` and `RecordingChunkManifest`.
- Hands group ownership to serve through the `HeartbeatReceipt.owner` flag only.

### listen-ui (T21 visual core)

Owns `web-app/src/pages/listen/{index.tsx,waveform.ts,listen.css,Dialog.tsx,ReviewDialog.tsx}`, `web-app/src/main.tsx`, `web-app/e2e/listen-*.spec.ts`.

- `Dialog.tsx`: `Dialog({ title, open, onClose, children })` with focus trap, Escape and focus return; AgentsDialog and Settings reuse it.
- `waveform.ts`: `drawWaveform(context, bands: Float32Array, state: ListenerState, reducedMotion: boolean)`; samples never enter React state.
- Imports only `getCaptureEngine` and view.ts types from capture; compares against `design/listener-reference.svg` at 1280x720 and a narrow laptop size.

### models (T04, T15)

Owns `server/src/matcher.ts`, `server/src/llm.ts`, `server/src/planner.ts`, `server/src/extraction.ts`, `server/src/providers/{cerebras,anthropic}.ts`, migration `009_matching`, `scripts/benchmark-matching.ts`, and adds `modelRoles` to config.ts.

- `llm.ts`: `LlmClient` tag, `LlmLive: Layer<LlmClient, ConfigError>`, `fixtureLlm(responses)` for tests; missing keys fail with `Unavailable`.
- `extraction.ts`: `extractCandidates(input: { meeting: Meeting; segments: ReadonlyArray<TranscriptSegment>; snapshot: ReadonlyArray<ContextItem> }): Effect<ReadonlyArray<ExtractionCandidate>, Unavailable, LlmClient>`.
- `planner.ts`: `planActions(access, input: { meeting_id; request: string }): Effect<ReadonlyArray<RequestActionInput>, Unavailable, LlmClient>`.
- `planner.ts`: `respondToRequest(input: { request: string; context: ContextSnapshot }): Stream<string, Unavailable, LlmClient>` for requested speech.
- `matcher.ts`: `rankMatches(access, query: { profile_id; kind: 'needs' | 'offers'; top_k: number }): Effect<ReadonlyArray<{ profile_id: ProfileId; score: number }>, NotFound, R>`.

### pipedream (T17)

Owns `server/src/providers/pipedream.ts`, `server/src/integrations.ts`, the `integration_accounts` statement in `008_actions`, `IntegrationsApi` in `packages/contracts/src/integrations.ts`.

- `providers/pipedream.ts`: `PipedreamClient` tag, `PipedreamLive`, `fixturePipedream(catalog)` (10,000-entry fixture support).
- `integrations.ts`: `searchIntegrationActions(access, input: SearchIntegrationActionsInput): Effect<SearchIntegrationActionsOutput, Unavailable, R | PipedreamClient>`.
- `integrations.ts`: `getIntegrationAction(access, input: GetIntegrationActionInput): Effect<GetIntegrationActionOutput, NotFound | Unavailable, R | PipedreamClient>`.
- `integrations.ts`: `executeIntegrationAction(input: { access; account_id; action_key; version; configuration_ref; arguments; provider_idempotency_key }): Effect<{ receipt: Record<string, unknown> }, IntegrationFailure, R | PipedreamClient>`; `IntegrationFailure.ambiguous` marks unknown outcomes.

### media (T08, server half of T09, T10, T11)

Owns `server/src/listeners.ts`, `server/src/recordings.ts`, `server/src/transcripts.ts`, `server/src/media/{ingest,session}.ts`, `server/src/providers/{deepgram,r2}.ts`, migrations `002_capture` and `003_transcripts`, `media.ts` and `ListenersApi` in contracts.

- Registers `ListenersApi` in contracts api.ts and its handlers in server api.ts; attaches the upgrade handler in main.ts.
- `providers/r2.ts`: `R2ObjectStoreLive: Layer<ObjectStore, ConfigError>`.
- `recordings.ts`: `listCommittedChunks(input: { workspace_id; source: SourceRange }): Effect<ReadonlyArray<RecordingChunkManifest & { object_key: string }>, SqlError, R>`.
- `transcripts.ts`: `finalSegments(access, source: SourceRange): Effect<ReadonlyArray<TranscriptSegment>, SqlError, R>`.
- `transcripts.ts`: `getSegments(access, ids: ReadonlyArray<TranscriptSegmentId>): Effect<ReadonlyArray<TranscriptSegment>, SqlError, R>` for source validation.
- `session.ts` calls meetings' hooks and actions' `SpeechGate`; handles job kind `transcript.reconcile`.

### meetings (T12, T13, T14)

Owns `server/src/meetings.ts`, `server/src/boundaries.ts`, `server/src/playback.ts`, `server/src/speakers.ts`, `server/src/providers/pyannote.ts`, `scripts/evaluate-speakers.ts`, migrations `005_meeting_ranges` and `006_speakers`, `MeetingsApi` in contracts meetings.ts.
Plan T13 lists `recordings.ts`; its playback half lives in `playback.ts` so media keeps `recordings.ts`.

- `meetings.ts`: `onFinalSegments(event: { workspace_id; listener_id; capture_group_id: string | null; segments: ReadonlyArray<TranscriptSegment> }): Effect<void, SqlError, R>`.
- `meetings.ts`: `onCaptureEnded(event: { workspace_id; listener_id; epoch_id; track; sample_end; reason: EpochEndReason }): Effect<void, SqlError, R>`.
- `meetings.ts`: `getMeeting(access, meeting_id): Effect<Meeting, NotFound, R>` and `meetingRanges(access, meeting_id): Effect<ReadonlyArray<MeetingRange>, NotFound, R>`.
- `playback.ts`: `issueRecordingAccess(access, meeting_id): Effect<RecordingAccess, NotFound | Forbidden | Unavailable, R | ObjectStore>`.
- Handles job kinds `meeting.finalize`, `recording.assemble`, `speakers.refine`; boundary corrections call context's `appendContextEvent`.
- `MeetingsApi` operations: `listMeetings`, `getMeeting`, `closeMeeting`, `splitMeeting`, `mergeMeetings`, `getTranscript`, `recordingAccess`.

### context (T16)

Owns `server/src/context.ts`, `server/src/context-changes.ts`, migration `007_context`, `ContextApi` in contracts context.ts.

- `context.ts`: `appendContextEvent(input: { workspace_id; meeting_id: MeetingId | null; item: { id; revision } | null; change: ContextChangeKind; actor: PrincipalId; source_revision?: number }): Effect<number, SqlError, R>`, inside the caller's transaction.
- `context.ts`: `getContextSnapshot(access, meeting_id): Effect<ContextSnapshot, NotFound, R>` and `addContextItem(access, input: AddContextItem): Effect<ContextItem, RevisionConflict | HashConflict | NotFound, R>`.
- Handles job kinds `context.refresh` and `memory.commit` using `extractCandidates`.
- `ContextApi` operations: `getContext`, `searchContext`, `addContextItem`, `reviseContextItem`, `getContextChanges`, `getSource`.

### actions (T18, T19 recovery, T20)

Owns `server/src/actions.ts`, `server/src/executor.ts`, `server/src/media/speech-gate.ts`, `server/src/providers/cartesia.ts`, `web-app/src/lib/capture/playback.ts`, the grant and action statements in `008_actions`, `ActionsApi` in contracts actions.ts, speech control messages in contracts media.ts.

- `actions.ts`: `requestAction(access, input: RequestActionInput): Effect<RequestActionOutput, Forbidden | NotFound | HashConflict, R>` (the third gateway).
- `actions.ts`: `getActionReceipt(access, action_id): Effect<ActionReceipt, NotFound, R>`.
- `speech-gate.ts`: `SpeechGate` tag with `openRequest({ listener_id; epoch_id; request_id; sample_end })`, `mayEmit(request_id, generation): boolean`, `cancel(listener_id, reason)`.
- `playback.ts` (web): `createPlayback(context: AudioContext)` registered by engine.ts; drops chunks of cancelled generations.
- Handles job kinds `action.execute`, `action.reconcile`, `research.run`.

### interfaces (T22, T23)

Owns `server/src/mcp.ts`, `scripts/generate-sdks.ts`, `sdk/typescript/`, `sdk/python/`, `sdk/examples/`, `web-app/src/pages/listen/AgentsDialog.tsx`, `server/tests/api-contract.test.ts`, `server/tests/mcp.test.ts`.

- Generates OpenAPI from `SanctumApi`; mounts `/mcp` from main.ts.
- MCP tools: `list_meetings`, `get_context`, `search_context`, `get_source`, `get_context_changes`, `add_context`, `revise_context`, `request_action`, `get_action`, `search_integration_actions`, `get_integration_action`.
- Tools call the functions named above; no business schema is redefined.

### serve (T24, T25)

Owns `server/Dockerfile`, `docker-compose.yml`, `Caddyfile`, production parts of `web-app/vite.config.ts`, `server/src/capture-groups.ts`, `server/tests/handoff.test.ts`, `server/tests/capabilities.test.ts`.

- `capture-groups.ts`: `claimGroupLease(input: { workspace_id; capture_group_id; listener_id; lease_generation }): Effect<HeartbeatReceipt, SqlError, R>`, called by media's heartbeat.
- Serves built web assets from main.ts behind the API routes.

## Hot files

| File | Who touches it | How |
| --- | --- | --- |
| `packages/contracts/src/api.ts` | every slice with REST | One `.add(XApi)` line. |
| `server/src/api.ts` | every slice with REST | One handler layer in the `ApiLive` list. |
| `server/src/main.ts` | kernel, media, interfaces, serve | Authenticator swap; upgrade handler; `/mcp` mount; static assets. |
| `server/src/worker.ts` | slices with provider layers | Provide the layer next to `dbLayer`. |
| `server/src/job-handlers.ts` | media, meetings, context, actions | One `kind: handler` entry; add provider tags to `WorkerServices`. |
| `server/src/config.ts` | models, media, actions, pipedream | Own key inside `serverConfig`; defaults stay in `engineeringDefaults`. |
| `server/src/media/session.ts` | media, meetings, actions | Media owns it; siblings expose functions it calls. |
| `web-app/src/pages/listen/engine.ts` | capture, listen-ui, actions | Capture owns it; actions adds playback registration. |
| `packages/contracts/src/jobs.ts` | any slice adding a job kind | Add the literal to `JobKind`. |
