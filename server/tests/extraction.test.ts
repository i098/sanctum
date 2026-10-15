/**
 * Extraction and canonical notes against labeled synthetic transcripts and recorded-shape model
 * output replayed by `fixtureLlm`. The meeting sits on the 2026-11-01 US DST change and crosses
 * UTC midnight, so date resolution must use the utterance time in the meeting timezone.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from '@effect/vitest';
import { ContextItem, Meeting, TranscriptSegment, Unavailable, UtcTimestamp, CaptureEpochId } from '@sanctum/contracts';
import { Effect, Layer, Schema } from 'effect';
import { engineeringDefaults } from '../src/config.ts';
import { type EpochAnchor, extractCandidates, notesCeilingMs, summarizeMeeting } from '../src/extraction.ts';
import { fixtureLlm, LlmClient, makeLlm } from '../src/llm.ts';
import { type ModelProvider, ProviderError, type ProviderRequest } from '../src/providers/types.ts';

const RATE = 16_000;
const epoch = CaptureEpochId.make(randomUUID());
const anchors: EpochAnchor[] = [{ epoch_id: epoch, sample_rate: RATE, sample_start: 0, captured_at: UtcTimestamp.make('2026-11-01T00:00:00Z') }];

const meeting = Schema.decodeSync(Meeting)({
  id: randomUUID(),
  workspace_id: randomUUID(),
  state: 'closed',
  title: null,
  started_at: '2026-11-01T00:00:00Z',
  ended_at: '2026-11-01T00:10:00Z',
  timezone: 'America/Los_Angeles',
  boundary_revision: 1,
  visibility: 'workspace',
  processing: { transcript: 'complete', notes: 'pending', memory: 'pending', recording: 'complete' },
});

const segment = (startSeconds: number, endSeconds: number, text: string, speaker: string, status: 'final' | 'partial' = 'final', epoch_id: string = epoch) =>
  Schema.decodeSync(TranscriptSegment)({
    id: randomUUID(),
    source: { epoch_id, track: 0, sample_start: startSeconds * RATE, sample_end: endSeconds * RATE },
    text,
    status,
    revision: 1,
    origin: 'live',
    provider: 'workers-ai',
    model: 'nova-3',
    provider_connection_id: null,
    speaker_label: speaker,
    speaker_track_id: null,
    confidence: 0.9,
    created_at: '2026-11-03T12:00:00Z',
  });

const segments = [
  segment(310, 315, 'Can we do the migration at 1:30 tomorrow morning?', 'speaker_1'),
  segment(0, 3, 'Okay, we decided to keep pilot access limited to the current test group.', 'speaker_0'),
  segment(5, 10, 'Maria will send the rollout notes by Monday.', 'speaker_1'),
  segment(300, 305, "Let's ship the beta tomorrow at 10.", 'speaker_0'),
  segment(320, 322, 'Actually cancel everyth', 'speaker_0', 'partial'),
];
const [s4, s1, s2, s3] = segments;
const source = (line: TranscriptSegment, start_ms: number, end_ms: number) => ({ segment_id: line.id, start_ms, end_ms });

const snapshot = [
  Schema.decodeSync(ContextItem)({
    id: randomUUID(),
    revision: 1,
    meeting_id: meeting.id,
    kind: 'decision',
    text: 'Use MySQL for storage.',
    state: 'committed',
    derivation: 'spoken',
    event_at: null,
    valid_from: null,
    valid_until: null,
    time: null,
    author: { type: 'system', id: randomUUID() },
    sources: [source(s1!, 0, 3_000)],
    supersedes: null,
    created_at: '2026-11-01T00:01:00Z',
  }),
];

const candidate = (fields: Record<string, unknown>) => ({ quote: null, derivation: 'spoken', time: null, ...fields });
/** Recorded-shape model answer: five grounded spoken facts, one inference and six that must be rejected. */
const modelAnswer = JSON.stringify({
  candidates: [
    candidate({ kind: 'decision', text: 'Keep pilot access limited to the current test group.', quote: 'keep pilot access limited to the current test group', segments: ['S1'] }),
    candidate({ kind: 'commitment', text: 'Maria sends the rollout notes by Monday.', quote: 'Maria will send the rollout notes by Monday', segments: ['S2'], time: { phrase: 'by Monday', local: '2026-11-02', ambiguous: false } }),
    candidate({ kind: 'decision', text: 'Ship the beta tomorrow at 10.', quote: "ship the beta tomorrow at 10", segments: ['S3'], time: { phrase: 'tomorrow at 10', local: '2026-11-01T10:00', ambiguous: false } }),
    candidate({ kind: 'open_question', text: 'Can the migration run at 1:30 tomorrow morning?', quote: 'do the migration at 1:30 tomorrow morning', segments: ['S4', 'S4'], time: { phrase: '1:30 tomorrow morning', local: '2026-11-01T01:30', ambiguous: false } }),
    candidate({ kind: 'project_fact', text: 'The beta has a restricted test group.', derivation: 'inferred', segments: ['S1', 'S3'] }),
    candidate({ kind: 'decision', text: 'Open access to everyone.', quote: 'open access to everyone', segments: ['S9'] }),
    candidate({ kind: 'decision', text: 'Open access to everyone.', quote: 'we will keep access open to everyone', segments: ['S1'] }),
    candidate({ kind: 'commitment', text: 'Maria sends notes.', segments: ['S2'] }),
    candidate({ kind: 'decision', text: 'Use MySQL for storage', quote: 'Okay', segments: ['S1'] }),
    candidate({ kind: 'commitment', text: 'Maria sends notes by Friday.', quote: 'Maria will send the rollout notes', segments: ['S2'], time: { phrase: 'by Friday', local: '2026-11-06', ambiguous: false } }),
    candidate({ kind: 'project_fact', text: 'Maria sends rollout notes to the test group.', quote: 'the current test group. Maria will send the rollout notes', segments: ['S2', 'S1'] }),
    candidate({ kind: 'decision', text: 'The test group ships the beta.', quote: "the current test group. Let's ship the beta", segments: ['S1', 'S3'] }),
  ],
});

/** Labeled expected candidates for the fixture above. */
const labeled = [
  { kind: 'decision', text: 'Keep pilot access limited to the current test group.', quote: 'keep pilot access limited to the current test group', derivation: 'spoken', sources: [source(s1!, 0, 3_000)], time: null },
  {
    kind: 'commitment',
    text: 'Maria sends the rollout notes by Monday.',
    quote: 'Maria will send the rollout notes by Monday',
    derivation: 'spoken',
    sources: [source(s2!, 5_000, 10_000)],
    time: { phrase: 'by Monday', normalized: '2026-11-02T08:00:00.000Z', anchor: '2026-11-01T00:00:05.000Z', timezone: 'America/Los_Angeles', ambiguous: true },
  },
  {
    kind: 'decision',
    text: 'Ship the beta tomorrow at 10.',
    quote: 'ship the beta tomorrow at 10',
    derivation: 'spoken',
    sources: [source(s3!, 300_000, 305_000)],
    time: { phrase: 'tomorrow at 10', normalized: '2026-11-01T18:00:00.000Z', anchor: '2026-11-01T00:05:00.000Z', timezone: 'America/Los_Angeles', ambiguous: false },
  },
  {
    kind: 'open_question',
    text: 'Can the migration run at 1:30 tomorrow morning?',
    quote: 'do the migration at 1:30 tomorrow morning',
    derivation: 'spoken',
    sources: [source(s4!, 310_000, 315_000)],
    time: { phrase: '1:30 tomorrow morning', normalized: null, anchor: '2026-11-01T00:05:10.000Z', timezone: 'America/Los_Angeles', ambiguous: true },
  },
  { kind: 'project_fact', text: 'The beta has a restricted test group.', quote: null, derivation: 'inferred', sources: [source(s1!, 0, 3_000), source(s3!, 300_000, 305_000)], time: null },
  {
    kind: 'project_fact',
    text: 'Maria sends rollout notes to the test group.',
    quote: 'the current test group. Maria will send the rollout notes',
    derivation: 'spoken',
    sources: [source(s2!, 5_000, 10_000), source(s1!, 0, 3_000)],
    time: null,
  },
];

describe('extractCandidates', () => {
  it.effect('returns exactly the labeled grounded candidates from a recorded model answer', () =>
    Effect.gen(function* () {
      const requests: ProviderRequest[] = [];
      const candidates = yield* Effect.provide(extractCandidates({ meeting, segments, snapshot, epochs: anchors }), fixtureLlm([modelAnswer], requests));
      expect(candidates).toEqual(labeled);
      const [request] = requests;
      expect(request).toMatchObject({ model: 'qwen-3.8-27b', reasoning: 'low', json: { name: 'context_candidates' } });
      expect(request!.prompt).toContain('S1 [Sat 2026-10-31 17:00:00] speaker_0: Okay, we decided');
      expect(request!.prompt).toContain("S3 [Sat 2026-10-31 17:05:00] speaker_0: Let's ship the beta tomorrow at 10.");
      expect(request!.prompt).toContain('- decision: Use MySQL for storage.');
      expect(request!.prompt).not.toContain('cancel everyth');
    }));

  it.effect('fails without a capture epoch anchor instead of guessing segment times', () =>
    Effect.gen(function* () {
      const requests: ProviderRequest[] = [];
      const foreign = segment(1, 2, 'From another epoch.', 'speaker_0', 'final', randomUUID());
      const failure = yield* Effect.flip(Effect.provide(extractCandidates({ meeting, segments: [...segments, foreign], snapshot, epochs: anchors }), fixtureLlm([modelAnswer], requests)));
      expect(failure).toMatchObject({ _tag: 'Unavailable', retryable: false, message: `no capture epoch anchor for epoch ${foreign.source.epoch_id}` });
      expect(requests).toHaveLength(0);
    }));

  it.effect('does not call the model without final speech', () =>
    Effect.gen(function* () {
      const requests: ProviderRequest[] = [];
      expect(yield* Effect.provide(extractCandidates({ meeting, segments: [segments[4]!], snapshot, epochs: anchors }), fixtureLlm([], requests))).toEqual([]);
      expect(requests).toHaveLength(0);
    }));

  it.live('surfaces an unavailable provider and invalid output as failures, never as empty or demo results', () =>
    Effect.gen(function* () {
      const input = { meeting, segments, snapshot, epochs: anchors };
      const down = new Unavailable({ message: 'Workers AI HTTP 503', retryable: true });
      const requests: ProviderRequest[] = [];
      // Three attempts on the extraction role, then three on the fallback.
      expect(yield* Effect.flip(Effect.provide(extractCandidates(input), fixtureLlm([down, down, down, down, down, down, modelAnswer], requests)))).toMatchObject({ _tag: 'Unavailable', retryable: true });
      expect(requests).toHaveLength(6);
      const invalid = JSON.stringify({ candidates: [candidate({ kind: 'rumour', text: 'x', segments: ['S1'] })] });
      expect(yield* Effect.flip(Effect.provide(extractCandidates(input), fixtureLlm([invalid, invalid])))).toMatchObject({ retryable: false, message: expect.stringMatching(/failed the context_candidates schema/) });
    }));
});

describe('bounded existing context', () => {
  const item = (kind: string, text: string) => ({ ...snapshot[0]!, id: randomUUID(), kind, text }) as ContextItem;
  /** 431 items (the size of the second soak dry run), about 130 characters each, each with its own vocabulary. */
  const large = [
    item('project_fact', 'The remote control product launch date is November 3rd, 2026, confirmed with the supplier.'),
    ...Array.from({ length: 430 }, (_, i) => item('decision', `Topic${i} budget review number ${i} agreed with team member${i}: keep scope${i} steady through the quarter.`)),
  ];
  const prompt = (items: ReadonlyArray<ContextItem>, answer = JSON.stringify({ candidates: [] })) =>
    Effect.gen(function* () {
      const requests: ProviderRequest[] = [];
      const said = segment(0, 3, 'The launch will slip to December 1st.', 'speaker_0');
      const found = yield* Effect.provide(extractCandidates({ meeting, segments: [said], snapshot: items, epochs: anchors }), fixtureLlm([answer], requests));
      return { found, prompt: requests[0]!.prompt };
    });

  it.effect('keeps the context block under budget on a large meeting', () =>
    Effect.gen(function* () {
      const { prompt: text } = yield* prompt(large);
      const block = text.slice(text.indexOf('Existing context:\n'), text.indexOf('\n\nTranscript:'));
      expect(block.length).toBeLessThanOrEqual(4_100);
      expect(block.split('\n').length).toBeLessThan(60);
    }));

  it.effect('still shows the item a new fact supersedes, however old', () =>
    Effect.gen(function* () {
      const { prompt: text } = yield* prompt(large);
      expect(text).toContain('launch date is November 3rd, 2026');
      expect(text).not.toContain('Topic100 ');
    }));

  it.effect('rejects a repeat of an item left out of the prompt', () =>
    Effect.gen(function* () {
      const repeat = JSON.stringify({ candidates: [candidate({ kind: 'decision', text: 'Topic100 budget review number 100 agreed with team member100: keep scope100 steady through the quarter.', quote: 'launch will slip', segments: ['S1'] })] });
      expect((yield* prompt(large, repeat)).found).toEqual([]);
    }));
});

describe('extraction model fallback', () => {
  const input = { meeting, segments, snapshot, epochs: anchors };
  const notesAnswer = JSON.stringify({ title: 'Beta', summary: 'The team limited pilot access.', sections: [{ heading: 'Access', points: [{ text: 'Pilot access stays limited.', segments: ['S1'] }] }] });
  /** Providers that record each request under their name and replay `answers`; an `Error` answer is thrown. */
  const providers = (cerebrasAnswers: ReadonlyArray<string | Error> | undefined, workersAnswers: ReadonlyArray<string | Error>) => {
    const seen: Array<{ provider: string; request: ProviderRequest }> = [];
    const stub = (provider: string, answers: ReadonlyArray<string | Error>): ModelProvider => {
      const queue = [...answers];
      return {
        complete: async request => {
          seen.push({ provider, request });
          const answer = queue.shift() ?? new Error('no answer left');
          if (answer instanceof Error) throw answer;
          return answer;
        },
      };
    };
    const llm = makeLlm(engineeringDefaults.modelRoles, { 'workers-ai': stub('workers-ai', workersAnswers), ...(cerebrasAnswers ? { cerebras: stub('cerebras', cerebrasAnswers) } : {}) });
    return { seen, layer: Layer.succeed(LlmClient, llm) };
  };
  const failure = new ProviderError('Cerebras HTTP 500', false);

  it.effect('extracts on Cerebras Qwen and leaves Workers AI unused while it answers', () =>
    Effect.gen(function* () {
      const { seen, layer } = providers([modelAnswer], []);
      expect(yield* Effect.provide(extractCandidates(input), layer)).toEqual(labeled);
      expect(seen.map(entry => [entry.provider, entry.request.model, entry.request.reasoning])).toEqual([['cerebras', 'qwen-3.8-27b', 'low']]);
    }));

  it.effect('falls back to Workers AI Qwen when Cerebras fails or has no key', () =>
    Effect.gen(function* () {
      const failed = providers([failure], [modelAnswer]);
      expect(yield* Effect.provide(extractCandidates(input), failed.layer)).toEqual(labeled);
      expect(failed.seen.map(entry => [entry.provider, entry.request.model])).toEqual([['cerebras', 'qwen-3.8-27b'], ['workers-ai', '@cf/qwen/qwen3.8-27b']]);
      const unconfigured = providers(undefined, [modelAnswer]);
      expect(yield* Effect.provide(extractCandidates(input), unconfigured.layer)).toEqual(labeled);
      expect(unconfigured.seen.map(entry => entry.provider)).toEqual(['workers-ai']);
    }));

  it.effect('summarizes on the same fallback and records the model that answered', () =>
    Effect.gen(function* () {
      const { seen, layer } = providers([failure], [notesAnswer]);
      const notes = yield* Effect.provide(summarizeMeeting({ meeting, segments, epochs: anchors }), layer);
      expect(notes.model).toBe('@cf/qwen/qwen3.8-27b');
      expect(seen.map(entry => entry.provider)).toEqual(['cerebras', 'workers-ai']);
    }));

  it.effect('fails with the fallback error when both providers fail', () =>
    Effect.gen(function* () {
      const { layer } = providers([failure], [new ProviderError('Workers AI HTTP 400', false)]);
      expect(yield* Effect.flip(Effect.provide(extractCandidates(input), layer))).toMatchObject({ _tag: 'Unavailable', retryable: false, message: expect.stringContaining('Workers AI HTTP 400') });
    }));
});

describe('summarizeMeeting', () => {
  it.effect('produces one canonical cited summary and drops points citing unknown segments', () =>
    Effect.gen(function* () {
      const answer = JSON.stringify({
        title: 'Beta rollout',
        summary: 'The team limited pilot access and scheduled the beta.',
        sections: [
          { heading: 'Access', points: [{ text: 'Pilot access stays with the test group.', segments: ['S1'] }, { text: 'Invented point.', segments: ['S7'] }] },
          { heading: 'Schedule', points: [{ text: 'Beta ships tomorrow at 10; rollout notes by Monday.', segments: ['S3', 'S2', 'S3'] }] },
          { heading: 'Unsupported', points: [{ text: 'Nothing cited.', segments: [] }] },
        ],
      });
      const notes = yield* Effect.provide(summarizeMeeting({ meeting, segments, epochs: anchors }), fixtureLlm([answer]));
      expect(notes).toEqual({
        meeting_id: meeting.id,
        model: 'qwen-3.8-27b',
        title: 'Beta rollout',
        summary: 'The team limited pilot access and scheduled the beta.',
        sections: [
          { heading: 'Access', points: [{ text: 'Pilot access stays with the test group.', sources: [source(s1!, 0, 3_000)] }] },
          { heading: 'Schedule', points: [{ text: 'Beta ships tomorrow at 10; rollout notes by Monday.', sources: [source(s3!, 300_000, 305_000), source(s2!, 5_000, 10_000)] }] },
        ],
      });
    }));

  it.effect('summarizes a long meeting in bounded windows and writes the title from the window summaries', () =>
    Effect.gen(function* () {
      const long = Array.from({ length: 250 }, (_, i) => segment(i * 2, i * 2 + 1, `Line ${i + 1}.`, 'speaker_0'));
      const window = (title: string, ref: string) => JSON.stringify({ title, summary: `${title} summary.`, sections: [{ heading: title, points: [{ text: `${title} point.`, segments: [ref] }] }] });
      const requests: ProviderRequest[] = [];
      const answers = [window('First', 'S1'), window('Second', 'S121'), window('Third', 'S250'), JSON.stringify({ title: 'Whole meeting', summary: 'All three parts.' })];
      const notes = yield* Effect.provide(summarizeMeeting({ meeting, segments: long, epochs: anchors }), fixtureLlm(answers, requests));
      expect(requests.map(request => request.json!.name)).toEqual(['meeting_notes', 'meeting_notes', 'meeting_notes', 'meeting_notes_title']);
      expect(requests.map(request => request.prompt.split('\n').filter(line => /^S\d+ /.test(line)).length)).toEqual([120, 120, 10, 0]);
      expect(requests.every(request => request.maxOutputTokens <= engineeringDefaults.modelRequest.maxOutputTokens)).toBe(true);
      expect(requests[3]!.prompt).toContain('Part 3: Third summary.');
      expect([notes.title, notes.summary, notes.sections.map(section => section.heading)]).toEqual(['Whole meeting', 'All three parts.', ['First', 'Second', 'Third']]);
      expect(notes.sections[2]!.points[0]!.sources).toEqual([source(long[249]!, 498_000, 499_000)]);
    }));

  it.effect('refuses to summarize a meeting without final transcript', () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(Effect.provide(summarizeMeeting({ meeting, segments: [], epochs: anchors }), fixtureLlm(['{}'])));
      expect(failure).toMatchObject({ _tag: 'Unavailable', retryable: false, message: 'meeting has no final transcript to summarize' });
    }));
});

describe('notesCeilingMs', () => {
  const { extractionTimeoutMs } = engineeringDefaults.modelRequest;

  it('grows with the sequential stages (parallel window batches, then the title) and stops at the job maximum', () => {
    const margin = notesCeilingMs(1) - 2 * extractionTimeoutMs;
    expect(margin).toBeGreaterThanOrEqual(15 * 60_000);
    expect(notesCeilingMs(2) - margin).toBe(2 * 2 * extractionTimeoutMs);
    expect(notesCeilingMs(3) - margin).toBe(notesCeilingMs(2) - margin);
    expect(notesCeilingMs(15) - margin).toBe(6 * 2 * extractionTimeoutMs);
    expect(notesCeilingMs(10_000)).toBe(engineeringDefaults.jobs.ceilingByKind['notes.summarize']);
    expect(notesCeilingMs(10_000)).toBe(60 * 60_000);
  });
});
