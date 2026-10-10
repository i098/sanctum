# Architecture and slice contracts

Pointer map for the parallel build of [tasks/todo.md](../tasks/todo.md).
Behavior is defined by [tasks/plan.md](../tasks/plan.md); this file fixes who owns which file and which names siblings import.

## Rules

- `fm/sanctum-build-v1` is the integration branch; every slice branches from it and merges back into it.
- A slice edits only files it owns below, plus one registration line in each hot file it is listed against.
- Changes to another slice's files, tables or contracts go through the integration branch, never directly.
- A slice may amend migration statements for its own tables until the pull request merges; merged migrations may already be applied to the deployed database ([operations.md](operations.md#cloudflare)), so they are never edited.
- When a sibling is not merged yet, build a stand-in at exactly its path and export name, headed `// stand-in: replaced by the <sibling> slice at integration`, or use a test-side fake.
- List every stand-in you created in your hand-off; integration keeps the real file and deletes the stand-in.
- Signatures below are the contract; extend them compatibly, never rename them.
- Run `npm run check:app` and the gates in [docs/CI.md](CI.md) before handing a slice back.
- Report the Sentrux comparison results defined in [docs/CI.md](CI.md#quality-regression-gates); a new cycle or import depth is an integration bug.

## Shared foundation (integration owner)

| Area | Where | Use |
| --- | --- | --- |
| Wire schemas | [packages/contracts/src](../packages/contracts/src/index.ts) | Branded IDs, `UtcTimestamp`, `SourceRange`, errors, every seam type; JSON-representable only. |
| Error envelope | [errors.ts](../packages/contracts/src/errors.ts) | `Unauthenticated` 401, `Forbidden` 403, `NotFound` 404, `RevisionConflict` 409, `HashConflict` 409, `Unavailable` 503. |
| HTTP contract | [api.ts](../packages/contracts/src/api.ts) | `SanctumApi` from `@sanctum/contracts/api` only; the index never re-exports it, so registering a group never deepens modules that import the index. Each slice defines its `HttpApiGroup` in its contracts area file, importing only `common.ts`, `errors.ts` and `auth.ts`. |
| Live media | [media.ts](../packages/contracts/src/media.ts) | Binary PCM frame layout, `encodePcmFrame`, `decodePcmFrame`, control messages. |
| Listener device API | [capture.ts](../packages/contracts/src/capture.ts) | `ListenersApi` (register, heartbeat, `putChunk`), `LISTENER_STREAM_PATH`. |
| Test audio | [fixtures.ts](../packages/contracts/src/fixtures.ts) | `syntheticPcm` from `@sanctum/contracts/fixtures`. |
| Config | [server/src/config.ts](../server/src/config.ts) | `serverConfig`, `engineeringDefaults` (plan 02), `mcpAuthorizationConfig`, `requireActivation` (rules in [operations.md](operations.md#processes)). |
| Database | [server/src/db.ts](../server/src/db.ts) | `dbLayer`, column schemas `DbUtc`, `DbSafeInt`, `DbBool`, `DbJson`, `DbSha256`, `mysqlErrno`. |
| Migrations | [server/src/migrate.ts](../server/src/migrate.ts) | Ledger, named lock, per-step resume; `npm run migrate --workspace server`. |
| Authorization seam | [server/src/auth.ts](../server/src/auth.ts) | `Authenticator` tag, `AuthenticatedLive`; `Authenticated` middleware and `CurrentAccess` live in contracts. |
| Object storage | [server/src/providers/object-store.ts](../server/src/providers/object-store.ts) | `ObjectStore` tag (`put`, `head`, `get`, `presignGet`, `list`, `delete`), `ObjectStoreError.ambiguous` and `.unconfigured`. |
| Job types | [server/src/job-types.ts](../server/src/job-types.ts) | `ClaimedJob`, `JobOutcome`, `JobHandler<R>`, `JobHandlers<R>`; imports no application module, so handler modules and jobs.ts never import the registry. |
| Job registry | [server/src/job-handlers.ts](../server/src/job-handlers.ts) | `jobHandlers`; only worker.ts imports it. `JobFailure` is in contracts. |
| Capture seam | [web-app/src/lib/capture/view.ts](../web-app/src/lib/capture/view.ts) | `CaptureView`, `CaptureSnapshot`, `LevelSource`, `createCaptureStore`. |
| Analyser levels | [levels.ts](../web-app/src/lib/capture/levels.ts) | `createAnalyserLevels(analyser, bandCount)` for the waveform. |
| Server tests | [server/tests/support](../server/tests/support/database.ts) | `withDatabase`, `seedWorkspace`, `fixtureAccess`, `memoryObjectStore`; one MySQL 8.4 per run. |

Conventions:

- IDs are UUID `CHAR(36) ascii_bin`; wall clock is `DATETIME(6)` UTC written with `UTC_TIMESTAMP(6)`; samples are `BIGINT UNSIGNED`.
- Owned rows reference each other through `(workspace_id, id)` foreign keys, so a row cannot point into another workspace.
- Decode rows only through `SqlSchema` plus the `db.ts` column schemas; never read `Date` or `Number` BIGINTs from mysql2.
- Domain functions take `access: AccessScope` first and never read credentials; unauthorized reads fail as `NotFound`.
- Tests use synthetic fixtures and fakes; no live provider, R2 or Pipedream call from any test.
- `server/src/providers/` never imports application modules; providers take options, and application code imports providers, never the reverse (a two-way directory dependency tripled Sentrux coupling).

## Slices

Each entry lists owned files, then the exact exports siblings import. `R` is `SqlClient.SqlClient` unless stated.

### kernel (T03, T05, job ledger core from T11/T19)

Owns `server/src/store.ts`, `server/src/auth.ts` (extends the foundation file), `server/src/agents.ts`, `server/src/cache.ts`, `server/src/jobs.ts` (replaces the stand-in), migrations `001_initial` and `004_jobs`, and the agent section of `packages/contracts/src/auth.ts` (kept beside `SessionApi` so no import chain deepens).
Kernel added `browser_sessions.workspace_id` to `001_initial` and `jobs.rearmed` (coalesced re-arm while running) to `004_jobs`.

- `auth.ts`: `KernelAuthenticatorLive: Layer<Authenticator, never, R>` (sessions + hashed bearer credentials) is main.ts's default; the unconfigured authenticator is gone.
- `auth.ts`: `resolveAccess(input: { workspace_id; principal_id }): Effect<AccessScope, Forbidden, R>` for workers and sockets.
- `auth.ts`: `requireScope(access, scope: AccessScopeName): Effect<void, Forbidden>`.
- `auth.ts`: `authorizeMeeting(access, meeting_id, need: 'read' | 'write'): Effect<void, NotFound, R>`.
- `auth.ts`: `listVisibleMeetingIds(access): Effect<ReadonlyArray<MeetingId>, SqlError, R>`.
- `jobs.ts`: `enqueueJob(input: EnqueueJob): Effect<JobId, SqlError, R>`, joining the caller's transaction.
- `jobs.ts`: `EnqueueJob = { workspace_id; kind: JobKind; work_key: string; payload: unknown; requested_by: PrincipalId | null; source_revision?: number; delay_ms?: number; max_attempts?: number; expedite?: boolean }`; an active row with the same key is re-armed (timer restarts; `expedite` makes it due no later than this request).
- `job-runner.ts`: `runWorker<R>(handlers: JobHandlers<R>, options?): Effect<never, SqlError, R | SqlClient>`, plus claim, lease, fenced completion and deadlock retry; its sweeper also runs media's `sweepLapsedListeners` from listeners.ts and meetings' `sweepIdleMeetings` from meetings.ts. Only worker.ts imports it.
- `jobs.ts` holds only `enqueueJob` and imports no application module, so enqueueing never deepens a caller's import chain.
- `db.ts`: `nextContextSeq(workspace_id): Effect<number, SqlError, R>` locks the workspace row; call inside the change's transaction.
- `store.ts`: `bumpPermissionRevision(workspace_id): Effect<number, SqlError, R>`.
- `store.ts`: `workspaceForOrg(input: { issuer; org_id }): Effect<Option<WorkspaceId>, SqlError, R>` and `linkWorkspaceOrg(input: { workspace_id; issuer; org_id }): Effect<void, SqlError, R>` (idempotent; a clash with another link is a defect) over migration `012_workspace_orgs`.
- `store.ts`: `addMember(input: { workspace_id; principal_id; role; org_issuer? })` stores `workspace_members.org_issuer` (migration `016_member_org_issuer`): the issuer whose organization sync granted the membership, NULL when Sanctum did; org sync revokes only memberships its issuer granted.
- `store.ts`: `setMembership(issuer, workspace_id, principal_id, role | null): Effect<void, SeatLimitReached | SqlError, R>`, the upsert (through `addMember` and its seat limit) and revoke path that provider organization glue calls; `roleFromSlugs(slugs)` maps organization role slugs to a Sanctum role; `claimSeat(workspace_id, principal_id | null)` checks a seat in its own transaction. `auth.ts` `createHumanPrincipal({ issuer, subject, name })` creates the human principal and its identity link for the same glue.
- `cache.ts`: `scopedCacheKey(access, ...parts: ReadonlyArray<string | number>): string` including principal, permission and source revisions.
- contracts: `AgentsApi` with `createAgent`, `listAgents`, `revokeCredential`.

### capture (T06, T07, browser half of T09)

Owns `web-app/src/lib/capture/{controller,permissions,microphone,recorder,recording-worklet,buffer,uploader,orphans}.ts`, `web-app/src/pages/listen/engine.ts`, their tests.

- `engine.ts`: `getCaptureEngine(): CaptureView`, a singleton above every overlay/router lifecycle; `subscribeTranscript(listener)` and `subscribeActions(listener)` fan out live transcript segments and `action_update` messages from the listener stream.
- `controller.ts`: `createCaptureController(deps): CaptureView & { dispose(): void }`, publishing through `createCaptureStore`.
- Client of `ListenersApi`, `LISTENER_STREAM_PATH`, `StartMessage`, `encodePcmFrame` and `RecordingChunkManifest`.
- Hands group ownership to serve through the `HeartbeatReceipt.owner` flag only.

### listen-ui (T21 visual core)

Owns `web-app/src/pages/listen/{index.tsx,waveform.ts,rails.ts,captions.ts,listen.css,Dialog.tsx,ReviewDialog.tsx,InputPicker.tsx,input-level.ts}`, `web-app/src/main.tsx`, `web-app/e2e/listen-*.spec.ts`.

- `Dialog.tsx`: `Dialog({ title, open, onClose, children, closeLabel? })` with focus trap, Escape and focus return; AgentsDialog, Settings and the welcome (`closeLabel` Skip) reuse it.
- `InputPicker.tsx`: `InputPicker({ engine, check? })`, the microphone choice (through `CaptureView.chooseInput`); only with `check` does it also test the chosen input for sound while capture is stopped or paused; `InputCheckText({ input })` is that test's line for one `useInputLevel` reading; `input-level.ts`: `useInputLevel(deviceId)`, the live level and dead-input state of one input outside capture. Settings and the silent-input warning use the picker, and only Settings sets `check`; the welcome's microphone step uses the picker without `check` and draws its level bar and `InputCheckText` from one `useInputLevel` reading. The dead-input floor, threshold and run rule (`SILENT_PEAK`, `SILENT_SECONDS`, `deadRun`) live once in capture's `microphone.ts`, shared by the capture engine and the check.
- `waveform.ts`: `startWaveform(canvas, levels, listener)`, the kiosk orb canvas ported one-to-one; samples never enter React state.
- `rails.ts`: `startTranscriptRail(lines, subscribeTranscript)` and `startActionFeed(feed, subscribeActions)`, the kiosk's side live updates.
- Imports only `getCaptureEngine`, `subscribeTranscript`, `subscribeActions`, view.ts types and `microphone.ts` (light: no recorder) from capture; compares against `design/listener-reference.svg` at 1280x720 and a narrow laptop size.
- Review tabs (T21 box 2) live in `ReviewPanels.tsx` and `review-data.ts`. They added three compatible API fields: `GET /meetings/{id}/actions` (`listMeetingActions` in `ActionsApi` and actions.ts), an optional `meeting_id` on `GET /context/changes`, and `pieces` plus `sample_rate` on `RecordingAccess` (playback.ts) to map a source sample to a playback offset.

### models (T04, T15)

Owns `server/src/matcher.ts`, `server/src/llm.ts`, `server/src/planner.ts`, `server/src/extraction.ts`, `server/src/providers/{workers-ai,anthropic,openai}.ts`, migration `009_matching`, `scripts/benchmark-matching.ts`, and adds `modelRoles` to config.ts.

- `llm.ts`: `LlmClient` tag, `LlmLive: Layer<LlmClient, ConfigError>`, `fixtureLlm(responses)` for tests; missing keys fail with `Unavailable`.
- `extraction.ts`: `extractCandidates(input: { meeting: Meeting; segments: ReadonlyArray<TranscriptSegment>; snapshot: ReadonlyArray<ContextItem>; epochs?: ReadonlyArray<EpochAnchor> }): Effect<ReadonlyArray<ExtractionCandidate>, Unavailable, LlmClient>`; fails `Unavailable` when a segment's epoch has no anchor (pass `capture_epochs` anchors).
- `extraction.ts`: `summarizeMeeting(input: Omit<ExtractionInput, 'snapshot'>): Effect<MeetingNotes, Unavailable, LlmClient>`, the one canonical summary for notes, email sections and exports.
- `planner.ts`: `planWork(access, input: { meeting_id; request: string; actions: ReadonlyArray<GetIntegrationActionOutput>; research?: { text: string; sources } }): Effect<{ web_research: boolean; actions: ReadonlyArray<RequestActionInput> }, Unavailable | Forbidden, LlmClient>`; offers only inspected actions whose missing fields it can fill, never the `app` field, and takes researched facts for arguments from `research` when given.
- `llm.ts`: `research(prompt, admit?)` sends one hosted web-search request (OpenAI Responses `web_search` by default) after `admit(model)` succeeds and never retries it in-process.
- `planner.ts`: `respondToRequest(input: { request: string; context: ContextSnapshot }): Stream<string, Unavailable, LlmClient>` for requested speech.
- `matcher.ts`: `rankMatches(access, query: { profile_id; kind: 'needs' | 'offers'; top_k: number }): Effect<ReadonlyArray<{ profile_id: ProfileId; score: number }>, NotFound, R>`.
- Matching (integration-owned): `MatchingApi` (contracts `matching.ts`, `GET /api/v1/profiles/{profile_id}/matches`) and the `matching.rank` job live in server `matching.ts`; both call `rankMatches` after a `context:read` check, and the job stores its ranking as a workspace `document` artifact.

### pipedream (T17)

Owns `server/src/providers/pipedream.ts`, `server/src/integrations.ts`, the `integration_accounts` statement in `008_actions`, `IntegrationsApi` in `packages/contracts/src/integrations.ts`.

- `providers/pipedream.ts`: `PipedreamClient` tag, `PipedreamLive`, `fixturePipedream(catalog)` (10,000-entry fixture support).
- `integrations.ts`: `searchIntegrationActions(access, input: SearchIntegrationActionsInput): Effect<SearchIntegrationActionsOutput, Unavailable, R | PipedreamClient>`.
- `integrations.ts`: `getIntegrationAction(access, input: GetIntegrationActionInput): Effect<GetIntegrationActionOutput, NotFound | Unavailable, R | PipedreamClient>`.
- `integrations.ts`: `executeIntegrationAction(input: { access; account_id; action_key; version; configuration_ref; arguments; provider_idempotency_key }): Effect<{ receipt: Record<string, unknown> }, IntegrationFailure, R | PipedreamClient>`; `IntegrationFailure.ambiguous` marks unknown outcomes.

### media (T08, server half of T09, T10, T11)

Owns `server/src/listeners.ts`, `server/src/recordings.ts`, `server/src/transcripts.ts`, `server/src/media/{ingest,session}.ts`, `server/src/providers/{whisper,r2}.ts`, migrations `002_capture` and `003_transcripts`, `media.ts` and `ListenersApi` in contracts.

- Registers `ListenersApi` in contracts api.ts and its handlers in server api.ts; attaches the upgrade handler in main.ts.
- `providers/r2.ts`: `R2ObjectStoreLive: Layer<ObjectStore, ConfigError>`; worker.ts provides it (an unconfigured stand-in until media lands).
- `recordings.ts`: `listCommittedChunks(input: { workspace_id; source: SourceRange }): Effect<ReadonlyArray<RecordingChunkManifest & { object_key: string }>, SqlError, R>`.
- `transcripts.ts`: `finalSegments(access, source: SourceRange): Effect<ReadonlyArray<TranscriptSegment>, SqlError, R>`.
- `transcripts.ts`: `getSegments(access, ids: ReadonlyArray<TranscriptSegmentId>): Effect<ReadonlyArray<TranscriptSegment>, SqlError, R>` for source validation.
- `session.ts` calls meetings' hooks and actions' `SpeechGate`; handles job kind `transcript.reconcile`.

### meetings (T12, T13, T14)

Owns `server/src/meetings.ts`, `server/src/meeting-store.ts`, `server/src/meeting-corrections.ts`, `server/src/meetings-api.ts`, `server/src/boundaries.ts`, `server/src/playback.ts`, `server/src/speakers.ts`, `server/src/providers/pyannote.ts`, `scripts/evaluate-speakers.ts`, migrations `005_meeting_ranges`, `006_speakers` and `017_meeting_end_fence`, `MeetingsApi` in contracts meetings.ts.
Plan T13 lists `recordings.ts`; its playback half lives in `playback.ts` so media keeps `recordings.ts`.

- `meetings.ts`: `onFinalSegments(event: { workspace_id; listener_id; capture_group_id: string | null; segments: ReadonlyArray<TranscriptSegment> }): Effect<void, SqlError, R>`.
- `meetings.ts`: `onCaptureEnded(event: { workspace_id; listener_id; epoch_id; track; sample_end; reason: EpochEndReason }): Effect<void, SqlError, R>`.
- `meetings.ts`: `sweepIdleMeetings(idleMs?): Effect<void, SqlError, R>` closes open meetings that are quiet for `engineeringDefaults.meetingIdleCloseMs` (see DECISIONS.md, "Meeting end decision").
- `meetings.ts`: `getMeeting(access, meeting_id): Effect<Meeting, NotFound, R>` and `meetingRanges(access, meeting_id): Effect<ReadonlyArray<MeetingRange>, NotFound, R>`.
- `playback.ts`: `issueRecordingAccess(access, meeting_id): Effect<RecordingAccess, NotFound | Forbidden | Unavailable, R | ObjectStore>`.
- Handles job kinds `meeting.finalize`, `recording.assemble`, `speakers.refine`; boundary corrections call context's `appendContextEvent`.
- `MeetingsApi` operations: `listMeetings`, `getMeeting`, `closeMeeting`, `endMeeting`, `splitMeeting`, `mergeMeetings`, `getTranscript`, `recordingAccess`, `mapSpeaker`, `getNotes`, `exportMeeting`.
- Notes (integration-owned): `meeting.finalize` enqueues `notes.summarize` (`notes-job.ts`), which stores the models slice's canonical `summarizeMeeting` output on `meetings.notes` with `notes_revision` and `processing.notes`; corrections, and final text that lands after a close left the transcript incomplete (`recordFinalWindow`), re-finalize and so regenerate notes. `notes.ts` serves `getNotes` and the Markdown `exportMeeting`; `meeting-evidence.ts` loads a meeting's final segments and epoch anchors for extraction and notes.
- Automatically detected meetings start restricted; `createMeeting` grants `owner` only to the capturing listener's principal ([DECISIONS.md](DECISIONS.md)), and kernel's `authorizeMeeting` has no role override.

### context (T16)

Owns `server/src/context.ts`, `server/src/context-events.ts`, `server/src/context-changes.ts`, `server/src/context-jobs.ts`, `server/src/context-schedule.ts`, migration `007_context`, `ContextApi` in contracts context.ts.

- `context-events.ts`: `appendContextEvent(input: { workspace_id; meeting_id: MeetingId | null; item: { id; revision } | null; change: ContextChangeKind; actor: PrincipalId; source_revision?: number }): Effect<number, SqlError, R>`, inside the caller's transaction.
- `context.ts`: `getContextSnapshot(access, meeting_id): Effect<ContextSnapshot, NotFound, R>` and `addContextItem(access, input: AddContextItem): Effect<ContextItem, RevisionConflict | HashConflict | NotFound, R>`.
- Handles job kinds `context.refresh` and `memory.commit` using `extractCandidates`.
- `context-schedule.ts`: `requestLiveContextRefresh(workspace_id, meeting_id)` counts the meeting's unprocessed final segments and calls `requestContextRefresh` with `requested_by: null` (system actor); meetings' `onFinalSegments` calls it after it claims new speech for the open meeting, so context updates during the meeting, not only at `memory.commit`.
- `ContextApi` operations: `getContext`, `searchContext`, `addContextItem`, `reviseContextItem`, `getContextChanges`, `getSource`.

### actions (T18, T19 recovery, T20)

Owns `server/src/actions.ts`, `server/src/executor.ts`, `server/src/research.ts`, `server/src/media/speech-gate.ts`, `server/src/speech-requests.ts`, `server/src/providers/speech.ts`, `web-app/src/lib/capture/playback.ts`, the grant and action statements in `008_actions`, migrations `010_action_titles` and `021_paid_model_calls`, `ActionsApi` in contracts `actions-api.ts` (registered through api.ts only, never the index), speech control messages in contracts media.ts.

- `actions.ts`: `requestAction(access, input: RequestActionInput): Effect<RequestActionOutput, Forbidden | NotFound | HashConflict, R>` (the third gateway).
- `actions.ts`: `getActionReceipt(access, action_id): Effect<ActionReceipt, NotFound, R>`.
- `speech-gate.ts`: `SpeechGate` tag with `openRequest({ listener_id; epoch_id; request_id; sample_end })`, `mayEmit(request_id, generation): boolean`, `cancel(listener_id, reason)`.
- `playback.ts` (web): `createPlayback(context: AudioContext)` registered by engine.ts; drops chunks of cancelled generations.
- Handles job kinds `action.execute`, `action.reconcile`, `research.run`.
- `actions.ts`: `listenerFeed(access, listener_id)` returns the listener's open meeting and its agent-work feed rows (newest `ACTION_FEED_ROWS`, oldest first) with the readable title chosen in one place: the request's optional `title`, else a label made from `action_key`.
- Media's session sends them as `action_update` on the listener stream: a snapshot after each `accepted`, then changes, read from MySQL every `liveLimits.actionFeedMs` because the job worker that changes most states runs in another process.
- `speech-gate.ts`: `speechController(...)` per live socket and the `SpeechReplies` tag; media's session creates the controller only when the process provides `SpeechSynthesizer` (media/providers.ts `SpeechSynthesizerLive`) and `SpeechReplies` (speech-requests.ts `SpeechRepliesLive`), so a process without them stays silent.
- `speech-requests.ts`: the API provides `SpeechWorkRequestsLive`; session.ts passes this optional service to the controller's independent work fiber.
  The [spoken work decision](DECISIONS.md#spoken-work-decision---2026-10-10) owns the trigger and authorization contract.
- Replies read the requester's context for the listener's open meeting; a device credential without `context:read` gets no reply, never a guess.
- Results over the Pipedream output budget are stored as `action_output` artifacts and referenced by `provider_receipt.artifact_id`.
- `research.run` (`executor.ts` with `research.ts`): finds the requester's granted actions among `searchIntegrationActions` matches for the request, inspects each with its grant's account, lets `planWork` decide on web research and fill in actions, researches first, then requests each planned action through `requestAction`.
  When the plan has both, `planWork` runs again with the cited research so action arguments take researched facts from it; a refused research requests no action and reports that as the `outcome`.
  Web research reserves one of the workspace's `SANCTUM_PAID_RESEARCH_CALLS_PER_DAY` and the install's `SANCTUM_PAID_RESEARCH_CALLS_PER_DAY_TOTAL` paid calls in `paid_model_calls` before sending, records the provider's token usage, stores a `research` artifact once per job, and adds an `external` `research_observation` citing it; a spent allowance is a `refused` result, a rate limit pauses the job, and nothing to do is a reported `outcome`.
- Known ASR timing limit: delayed finals across lane rotation can split a request prematurely or be ignored during an active reply.
  Sorting only restores segments collected before turn completion; the authorized follow-up is [#96](https://github.com/i098/sanctum/issues/96).

### interfaces (T22, T23)

Owns `server/src/mcp.ts`, `scripts/generate-sdks.ts`, `sdk/typescript/`, `sdk/python/`, `sdk/examples/`, `web-app/src/pages/listen/AgentsDialog.tsx`, `server/tests/api-contract.test.ts`, `server/tests/mcp.test.ts`.

- Generates OpenAPI from `SanctumApi`; mounts `/mcp` from main.ts.
- MCP tools: `list_meetings`, `get_context`, `search_context`, `get_source`, `get_context_changes`, `add_context`, `revise_context`, `request_action`, `get_action`, `search_integration_actions`, `get_integration_action`.
- Tools call the functions named above; no business schema is redefined.

### serve (T24, T25)

Owns `server/Dockerfile`, `docker-compose.yml`, `Caddyfile`, production parts of `web-app/vite.config.ts`, `server/src/capture-groups.ts`, `server/tests/handoff.test.ts`, `server/tests/capabilities.test.ts`.

- `capture-groups.ts`: `claimGroupLease(input: { workspace_id; capture_group_id; listener_id }): Effect<boolean, SqlError, R>`, called inside media's heartbeat, and `holdsGroupLease(workspace_id, listener): Effect<boolean, SqlError, R>`, required by live `start` and watermark writes.
- Serves built web assets from main.ts behind the API routes.

### deploy

Owns `deploy/cloudflare/` (Worker, Container classes, `wrangler.jsonc`) and the Cloudflare section of [operations.md](operations.md#cloudflare); runs the `server/Dockerfile` image unchanged.

### landing

Owns `web-app/landing/` (static page, `npm run build:landing`), `web-app/e2e/landing.spec.ts` and the landing branch of the Worker in `deploy/cloudflare/src/index.ts`; operation in [operations.md](operations.md#cloudflare).

- The hero runs the listening view's `startWaveform` from `web-app/src/pages/listen/waveform.ts` on simulated levels and never asks for the microphone; reduced motion keeps one still frame.
- The page loads only its own built files; the Worker adds its CSP, and the copy states only what the hosted site runs today.

### sign-in (S1)

Owns `server/src/signin.ts`, `server/src/owner.ts`, `server/tests/signin.test.ts`; operation in [operations.md](operations.md#sign-in).

- Mounts `/auth/*` from main.ts; opens sessions through `openSession` and `linkIdentity` in auth.ts.
- Login refreshes `principals.display_name` and `principals.email` (migration `018_principal_email`) from the ID token (`name`, else `given_name` and `family_name`, with an email but no name the display name is cleared to NULL); Settings' Sign-in row shows them (the email leads when the name is NULL; shared and audit text then says "a member") with the role as a label and initials for the avatar.
- B1 (self-hosted organizations): `server/src/issuer-orgs.ts` (Better Auth organization hooks and the sign-in repair `reconcileMember`), migration `013_issuer_organizations`, `web-app/src/pages/auth/team.tsx` (Team and Profile dialogs) and the `/invite/<id>` page; operation in [operations.md](operations.md#self-hosted-sign-in).

### organizations (W1)

Owns `server/src/org-sync.ts`, `server/src/providers/workos.ts` and the WorkOS suites in `server/tests/signin.test.ts`; operation in [operations.md](operations.md#workos-organizations).

- `org-sync.ts`: `reconcileSignIn(identity, name, create)`, called by signin.ts after the ID token is verified; `linkExistingWorkspace(settings, workspace_id, identity)` for Team's "Set up team"; `syncWorkosEvents` handles job kind `workos.sync` and is registered in worker.ts next to its layer (one more import would make job-handlers.ts a Sentrux god file); `armWorkosSync` schedules it when the worker starts.
- `WorkosOrganizations` tag (`WorkosOrganizationsFromEnv`), provided by main.ts and worker.ts.

### workspace deletion

Owns `server/src/workspaces.ts`, migration `014_workspace_deletion`, `WorkspaceApi` and the `WorkspaceOwner` middleware in contracts `workspace.ts`, `web-app/src/pages/listen/WorkspaceDeletion.tsx`.

- `auth.ts` joins only live workspaces, so a deleted workspace refuses every session, credential and `resolveAccess` at once; `WorkspaceOwnerLive` and `openSession` alone still admit an owner until `purge_after`, so the owner can sign in again and undo.
- Deleting ends this process's open listener sockets of the workspace with a `rejected` message (`unauthorized`) and close code 1008 (`server/src/media/open-sockets.ts`), and `workspaceIsLive` in store.ts refuses segment, chunk commit and recording-object writes of a deleted workspace in every process; a reconcile or recording job that meets the deletion mid-run fails with the requester refusal, so Undo requeues it; the web app pauses capture after a successful delete.
- Handles job kind `workspace.purge`; a table added with a `workspace_id` column joins `PURGED_TABLES` in workspaces.ts, children first. The purge also deletes the embedded issuer's organization of the workspace (`auth_invitation`, `auth_member`, `auth_organization` with `id = workspace_id`, which hold no `workspace_id` column) and clears `auth_session.activeOrganizationId` that names it. It keeps the deployment-wide `workos.sync` job row, because it is anchored to the oldest workspace.

### team widgets (W2)

Owns `server/src/widget-token.ts`, `server/tests/support/team-server.ts`, `web-app/src/pages/listen/{WorkosTeam.tsx,team.css}`, `web-app/e2e/team-csp.spec.ts` and the widget-token suite in `server/tests/signin.test.ts`; operation in [operations.md](operations.md#workos-organizations).

- `widget-token.ts`: `WidgetTokenLive` mounts `GET`/`POST /api/v1/workspace/team` (link status; owner-only "Set up team") and `POST /api/v1/workspace/widget-token` from main.ts; it calls `WorkosClient.widgetToken` in `providers/workos.ts`.
- `/auth/config` reports `workos_organizations`; SettingsDialog lazy-loads `WorkosTeam.tsx` for admins of a linked workspace and owners on such a server.
- The `style-src` hashes in `web.ts` cover the widgets' fixed `<style>` elements; `team-csp.spec.ts` fails when a dependency bump changes one.

### onboarding (first-run welcome)

Owns `server/src/onboarding.ts`, migration `020_onboarding`, `OnboardingApi` in contracts `onboarding.ts`, `server/tests/onboarding.test.ts`, `web-app/src/pages/listen/Welcome.tsx` and `web-app/e2e/listen-welcome.spec.ts`.

- `OnboardingApi` is website only (`OpenApi.Exclude`, so not in the SDKs or MCP): `GET`/`POST /api/v1/onboarding` read and set `principals.onboarded_at` with the workspace name, and `POST /api/v1/workspace/name` renames the workspace for `workspace:admin`.
- `TeamButton` in SettingsDialog.tsx opens this server's Team (self-hosted issuer, WorkOS widgets or Set up team) for both Settings and the welcome; the microphone step uses listen-ui's `InputPicker`, `InputCheckText` and `useInputLevel`.

## Hot files

| File | Who touches it | How |
| --- | --- | --- |
| `packages/contracts/src/api.ts` | every slice with REST | One `.add(XApi)` line. |
| `server/src/api.ts` | every slice with REST | One handler layer in the `ApiLive` list. |
| `server/src/main.ts` | kernel, media, interfaces, serve, sign-in, team widgets | Authenticator swap; upgrade handler; `/mcp` mount; `/auth/*` mount; widget-token mount; static assets. |
| `server/src/worker.ts` | slices with provider layers | Provide the layer next to `dbLayer`. |
| `server/src/job-handlers.ts` | media, meetings, context, actions | One `kind: handler` entry; the services a handler needs come from its type, and worker.ts provides their layers. Handler modules import `job-types.ts`, never this file. |
| `server/src/config.ts` | models, media, actions, pipedream | Own key inside `serverConfig`; defaults stay in `engineeringDefaults`. |
| `server/src/media/session.ts` | media, meetings, actions | Media owns it; siblings expose functions it calls. |
| `web-app/src/pages/listen/engine.ts` | capture, listen-ui, actions | Capture owns it; actions adds playback registration. |
| `packages/contracts/src/jobs.ts` | any slice adding a job kind | Add the literal to `JobKind`. |
