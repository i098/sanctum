/**
 * Soak corpus builder: real AMI/ICSI meeting audio as filler, with scripted Aura-2 clips spliced in
 * at known times, plus the manifest the driver and checkpoint runner read.
 *
 * The 24 hour schedule is 24 meetings, one per hour: 40 minutes of speech (one WAV each, 16 kHz mono
 * PCM16) then a 20 minute gap the driver streams as silence. Every meeting opens and closes with a
 * scripted cue the boundary code scores. Planted facts replace a short window of filler, never sit
 * within 3 minutes of a meeting edge, and never address the product, so no spoken work is triggered.
 *
 * AMI and ICSI are CC BY 4.0: the licence page is fetched and checked on every run and recorded in the
 * manifest. Audio is for internal soak use only; generated files stay under .work/ and are not committed.
 *
 * Usage: node scripts/soak/build-corpus.ts [--out .work/soak-corpus] [--meetings 24]
 * Needs ffmpeg on PATH and WORKERS_AI_ACCOUNT_ID + WORKERS_AI_API_TOKEN for Aura-2 (clips are cached).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

export const SAMPLE_RATE = 16_000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2;
const MEETINGS = 24;
const SPEECH_SECONDS = 2400;
const GAP_SECONDS = 1200;
const SLOT_SECONDS = SPEECH_SECONDS + GAP_SECONDS;
const EDGE_MARGIN_SECONDS = 180;
/** Upper bound for one scripted clip; the build fails if Aura-2 returns a longer one. */
const MAX_CLIP_SECONDS = 10;
/** Silence either side of a spliced clip so it reads as its own utterance. */
const CLIP_PAD_SECONDS = 0.3;
/** Skipped at the start of each source: set-up chatter, and the source's own start cue. */
const FILLER_SKIP_SECONDS = 90;

const START_CUE = { spoken: "Good morning everyone, let's get started.", voice: 'luna' };
const END_CUE = { spoken: "Thanks everyone, that's all for today.", voice: 'luna' };

/** A planted utterance. `offset` is seconds from the start of the meeting's speech to the start of the clip. */
interface FactPlan {
  readonly id: string;
  readonly kind: 'fact' | 'distractor' | 'stable';
  readonly meeting: number;
  readonly offset: number;
  readonly voice: string;
  readonly spoken: string;
  /** Human text; scoring uses `aliases`, or `expect` when the answer depends on the real T0 date. */
  readonly answer: string;
  /** Whole-token matches (manifest `alias_match`); empty when `expect` is set. */
  readonly aliases: ReadonlyArray<string>;
  /** The scorer resolves this against `t0` and `after_s` (the fact's at_s) to an absolute date. */
  readonly expect?: { readonly kind: 'weekday_after'; readonly weekday: string };
  /** Keyword query an agent would send; search needs every 3+ letter term in one item, so keep it short. */
  readonly keywords: string;
  readonly supersedes?: string;
  readonly tests: string;
}

// ponytail: voices are the three Aura-2 speakers checked against the live API; add more when variety matters.
export const FACTS: ReadonlyArray<FactPlan> = [
  { id: 'L1', kind: 'fact', meeting: 0, offset: 600, voice: 'luna', spoken: 'We decided the launch date is November 3.', answer: 'November 3', aliases: ['Nov 3', 'Nov 3rd', 'November 3', 'November 3rd', '3 November', '11/3'], keywords: 'launch', tests: 'basic recall' },
  { id: 'V0', kind: 'distractor', meeting: 0, offset: 1080, voice: 'orion', spoken: 'Northwood Freight quoted nine thousand dollars for shipping, and we rejected that quote.', answer: 'Northwood', aliases: ['Northwood Freight', 'Northwood'], keywords: 'shipping', tests: 'look-alike vendor that was rejected' },
  { id: 'V1', kind: 'fact', meeting: 0, offset: 1560, voice: 'apollo', spoken: 'We chose Northwind Freight for shipping.', answer: 'Northwind', aliases: ['Northwind Freight', 'Northwind'], keywords: 'shipping', tests: 'look-alike distractor of V0' },
  { id: 'B1', kind: 'fact', meeting: 2, offset: 1800, voice: 'luna', spoken: 'The budget cap is forty-eight thousand dollars.', answer: '$48,000', aliases: ['$48,000', '48,000', '$48k', '48k', 'forty-eight thousand', 'forty eight thousand', '48 thousand'], keywords: 'budget', tests: 'supersession with B2' },
  { id: 'D', kind: 'stable', meeting: 3, offset: 1200, voice: 'orion', spoken: 'There will be no deploys on Fridays.', answer: 'no deploys on Fridays', aliases: ['no deploys on Friday', 'no Friday deploys', 'no deploys on Fridays', 'no deployments on Fridays'], keywords: 'deploy', tests: 'retention over 24 hours; never changes' },
  { id: 'L2', kind: 'fact', meeting: 4, offset: 300, voice: 'apollo', spoken: 'The launch has moved to November 17.', answer: 'November 17', aliases: ['Nov 17', 'Nov 17th', 'November 17', 'November 17th', '17 November', '11/17'], keywords: 'launch', supersedes: 'L1', tests: 'supersedes L1' },
  { id: 'O1', kind: 'fact', meeting: 6, offset: 900, voice: 'luna', spoken: 'Priya owns onboarding.', answer: 'Priya', aliases: ['Priya'], keywords: 'onboarding', tests: 'supersession with O2' },
  { id: 'B2', kind: 'fact', meeting: 9, offset: 600, voice: 'orion', spoken: 'The budget has been raised to sixty-two thousand dollars.', answer: '$62,000', aliases: ['$62,000', '62,000', '$62k', '62k', 'sixty-two thousand', 'sixty two thousand', '62 thousand'], keywords: 'budget', supersedes: 'B1', tests: 'supersedes B1' },
  { id: 'C', kind: 'fact', meeting: 10, offset: 1800, voice: 'apollo', spoken: 'Dana sends the signed contract by Friday.', answer: 'the Friday after the utterance', aliases: [], expect: { kind: 'weekday_after', weekday: 'Friday' }, keywords: 'contract', tests: 'relative date resolves to the first Friday after the calendar date of at_s' },
  { id: 'L3', kind: 'fact', meeting: 13, offset: 600, voice: 'luna', spoken: 'The launch is now December 1.', answer: 'December 1', aliases: ['Dec 1', 'Dec 1st', 'December 1', 'December 1st', '1 December', '12/1'], keywords: 'launch', supersedes: 'L2', tests: 'second supersession' },
  { id: 'O2', kind: 'fact', meeting: 15, offset: 1800, voice: 'orion', spoken: 'Marcus takes over onboarding.', answer: 'Marcus', aliases: ['Marcus'], keywords: 'onboarding', supersedes: 'O1', tests: 'owner change' },
  { id: 'R', kind: 'fact', meeting: 22, offset: 1800, voice: 'apollo', spoken: 'The rollout region is eu-west.', answer: 'eu-west', aliases: ['eu-west', 'eu west', 'EU West', 'Europe West'], keywords: 'rollout', tests: 'newest fact at the last checkpoint' },
];

type Mode = 'current' | 'as_of' | 'range' | 'history' | 'never_said';

interface QuestionPlan {
  readonly id: string;
  readonly question: string;
  readonly keywords: string;
  readonly mode: Mode;
  /** Fact ids that answer it: all of them for `range`, in order for `history`, the newest for `current`/`as_of`. */
  readonly expect: ReadonlyArray<string>;
  /** Seconds from T0; `as_of` asks what was true at that time, `range` asks what was decided inside it. */
  readonly as_of_s?: number;
  readonly range_s?: readonly [number, number];
}

interface CheckpointPlan { readonly id: string; readonly at_s: number; readonly questions: ReadonlyArray<QuestionPlan> }

const HOUR = 3600;
const CHECKPOINTS: ReadonlyArray<CheckpointPlan> = [
  { id: 'cp1', at_s: HOUR, questions: [
    { id: 'cp1-launch', question: 'What launch date was decided?', keywords: 'launch', mode: 'current', expect: ['L1'] },
    { id: 'cp1-vendor', question: 'Which shipping vendor was chosen (not Northwood)?', keywords: 'shipping', mode: 'current', expect: ['V1'] },
  ] },
  { id: 'cp2', at_s: 5 * HOUR, questions: [
    { id: 'cp2-launch', question: 'What is the current launch date?', keywords: 'launch', mode: 'current', expect: ['L2'] },
    { id: 'cp2-launch-as-of', question: 'What was the launch date as of T0+04:00?', keywords: 'launch', mode: 'as_of', as_of_s: 4 * HOUR, expect: ['L1'] },
    { id: 'cp2-budget', question: 'What is the budget cap?', keywords: 'budget', mode: 'current', expect: ['B1'] },
    { id: 'cp2-deploy', question: 'Are there any deploy restrictions?', keywords: 'deploy', mode: 'current', expect: ['D'] },
  ] },
  { id: 'cp3', at_s: 12 * HOUR, questions: [
    { id: 'cp3-range', question: 'What was decided between T0+04:00 and T0+10:00?', keywords: 'launch onboarding budget', mode: 'range', range_s: [4 * HOUR, 10 * HOUR], expect: ['L2', 'O1', 'B2'] },
    { id: 'cp3-budget-as-of', question: 'What was the budget cap before T0+08:00?', keywords: 'budget', mode: 'as_of', as_of_s: 8 * HOUR, expect: ['B1'] },
    { id: 'cp3-owner', question: 'Who owns onboarding?', keywords: 'onboarding', mode: 'current', expect: ['O1'] },
    { id: 'cp3-contract', question: 'When does Dana send the contract?', keywords: 'contract', mode: 'current', expect: ['C'] },
  ] },
  { id: 'cp4', at_s: 24 * HOUR, questions: [
    { id: 'cp4-launch-history', question: 'What is the current launch date, and what is its history in order?', keywords: 'launch', mode: 'history', expect: ['L1', 'L2', 'L3'] },
    { id: 'cp4-owner', question: 'Who owns onboarding now?', keywords: 'onboarding', mode: 'current', expect: ['O2'] },
    { id: 'cp4-budget-as-of', question: 'What did we decide about the budget before T0+12:00?', keywords: 'budget', mode: 'as_of', as_of_s: 12 * HOUR, expect: ['B2'] },
    { id: 'cp4-vendor', question: 'Which vendor was chosen at the start?', keywords: 'shipping', mode: 'current', expect: ['V1'] },
    { id: 'cp4-region', question: 'What is the rollout region?', keywords: 'rollout', mode: 'current', expect: ['R'] },
    { id: 'cp4-never-said', question: 'Who approved the Q3 audit?', keywords: 'audit approved', mode: 'never_said', expect: [] },
  ] },
];

interface Source { readonly corpus: 'AMI' | 'ICSI'; readonly id: string }

const AMI_FILLER: ReadonlyArray<ReadonlyArray<string>> = [['ES2002a', 'ES2002b'], ['EN2001a'], ['EN2006a']];
const ICSI_FILLER = ['Bed002', 'Bed003', 'Bed004', 'Bed005', 'Bed006', 'Bed008', 'Bed009', 'Bed010', 'Bed011', 'Bed013', 'Bed014', 'Bed015', 'Bed016',
  'Bmr002', 'Bmr003', 'Bmr005', 'Bmr006', 'Bmr007', 'Bmr010', 'Bmr011', 'Bro004'];

/** Meetings 0, 8 and 16 are AMI (a short AMI session continues with the next one of its series); the rest are ICSI, each at least 44 minutes. */
const FILLER: ReadonlyArray<ReadonlyArray<Source>> = Array.from({ length: MEETINGS }, (_, i) =>
  i % 8 === 0
    ? AMI_FILLER[i / 8]!.map((id): Source => ({ corpus: 'AMI', id }))
    : [{ corpus: 'ICSI', id: ICSI_FILLER[i - Math.ceil(i / 8)]! }]);

const CORPORA = {
  AMI: {
    licence: 'CC BY 4.0', licence_page: 'https://groups.inf.ed.ac.uk/ami/corpus/license.shtml',
    attribution: 'AMI Meeting Corpus, University of Edinburgh and the AMI consortium, https://groups.inf.ed.ac.uk/ami/corpus/',
    url: ({ id }: Source) => `https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/${id}/audio/${id}.Mix-Headset.wav`,
  },
  ICSI: {
    licence: 'CC BY 4.0', licence_page: 'https://groups.inf.ed.ac.uk/ami/icsi/license.shtml',
    attribution: 'ICSI Meeting Corpus, International Computer Science Institute, https://groups.inf.ed.ac.uk/ami/icsi/',
    url: ({ id }: Source) => `https://groups.inf.ed.ac.uk/ami/ICSIsignals/NXT/${id}.interaction.wav`,
  },
} as const;
const MODIFICATIONS = 'Trimmed to a 40 minute window, concatenated where one session is shorter, and short windows replaced by synthetic speech. Internal soak use; not redistributed.';

const FACT_BY_ID = new Map(FACTS.map(fact => [fact.id, fact]));
/** Seconds from T0 at which a planted fact starts. */
const startOf = (fact: FactPlan) => fact.meeting * SLOT_SECONDS + fact.offset;

/** The messages of every rule whose condition holds. */
const violations = (rules: ReadonlyArray<readonly [boolean, string]>) => rules.filter(([broken]) => broken).map(([, message]) => message);

function factErrors(fact: FactPlan): string[] {
  const target = FACT_BY_ID.get(fact.supersedes ?? '');
  const crowded = FACTS.some(other => other !== fact && other.meeting === fact.meeting && Math.abs(other.offset - fact.offset) < 2 * MAX_CLIP_SECONDS);
  return violations([
    [FILLER[fact.meeting] === undefined, 'meeting is outside the schedule'],
    [fact.offset < EDGE_MARGIN_SECONDS || fact.offset + MAX_CLIP_SECONDS > SPEECH_SECONDS - EDGE_MARGIN_SECONDS, `offset ${fact.offset} is within ${EDGE_MARGIN_SECONDS} s of a meeting edge`],
    [/sanctum/i.test(fact.spoken), 'must not address the product'],
    [fact.supersedes !== undefined && (!target || startOf(target) >= startOf(fact)), `supersedes ${fact.supersedes}, which is missing or not earlier`],
    [(fact.expect !== undefined) !== (fact.aliases.length === 0), 'needs exactly one of aliases or expect'],
    [crowded, 'is within 20 s of another fact in its meeting'],
  ]).map(message => `${fact.id}: ${message}`);
}

function questionErrors(checkpoint: CheckpointPlan, q: QuestionPlan): string[] {
  // `as_of` asks about its own time; every other mode asks about the state at the checkpoint.
  const stateAt = q.as_of_s ?? checkpoint.at_s;
  const horizon = q.range_s?.[1] ?? stateAt;
  return q.expect.flatMap(id => {
    const fact = FACT_BY_ID.get(id);
    if (!fact) return [`${q.id}: unknown fact ${id}`];
    return violations([
      // The fact's meeting must be closed, with its gap to process it, before the checkpoint asks.
      [fact.meeting * SLOT_SECONDS + SPEECH_SECONDS > checkpoint.at_s, `is not in a closed meeting at ${checkpoint.id}`],
      [startOf(fact) > horizon, `is after ${horizon} s`],
      [(q.mode === 'as_of' || q.mode === 'current') && FACTS.some(f => f.supersedes === id && startOf(f) <= stateAt), `is already superseded at ${stateAt} s`],
    ]).map(message => `${q.id}: ${id} ${message}`);
  });
}

/** Problems with the plan itself; empty when every fact, cue and checkpoint question is consistent. */
export function validatePlan(): string[] {
  const duplicate = FACT_BY_ID.size === FACTS.length ? [] : ['duplicate fact id'];
  return [...duplicate, ...FACTS.flatMap(factErrors), ...CHECKPOINTS.flatMap(checkpoint => checkpoint.questions.flatMap(q => questionErrors(checkpoint, q)))];
}

/** Overwrites `base` with the padded clip, its start at sample `at`; returns the clip's end sample. Mutates `base`. */
export function splice(base: Int16Array, at: number, clip: Int16Array, gain: number): number {
  const pad = Math.round(CLIP_PAD_SECONDS * SAMPLE_RATE);
  const from = at - pad;
  const to = at + clip.length + pad;
  if (from < 0 || to > base.length) throw new Error(`clip at sample ${at} does not fit in ${base.length} samples`);
  base.fill(0, from, to);
  for (let i = 0; i < clip.length; i++) base[at + i] = Math.max(-32768, Math.min(32767, Math.round(clip[i]! * gain)));
  return at + clip.length;
}

function rms(samples: Int16Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
  return Math.sqrt(sum / Math.max(1, samples.length));
}

const toInt16 = (bytes: Uint8Array) => new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));

async function cached(path: string, make: () => Promise<Uint8Array>): Promise<Buffer> {
  if (existsSync(path)) return readFileSync(path);
  const bytes = Buffer.from(await make());
  writeFileSync(path, bytes);
  return bytes;
}

async function fetchRange(url: string, from: number, to: number): Promise<Uint8Array> {
  const reply = await fetch(url, { headers: { range: `bytes=${from}-${to}` } });
  if (reply.status !== 206) throw new Error(`${url} answered ${reply.status} to a range request`);
  const bytes = new Uint8Array(await reply.arrayBuffer());
  if (bytes.length !== to - from + 1) throw new Error(`${url} returned ${bytes.length} of ${to - from + 1} bytes; the source is shorter than the plan`);
  return bytes;
}

/** Bytes of PCM in a source after checking it is the 16 kHz mono PCM16 WAV the corpora publish. */
async function dataBytes(url: string): Promise<number> {
  const header = Buffer.from(await fetchRange(url, 0, 43));
  const ok = header.toString('latin1', 0, 4) === 'RIFF' && header.toString('latin1', 8, 12) === 'WAVE' && header.toString('latin1', 36, 40) === 'data'
    && header.readUInt16LE(20) === 1 && header.readUInt16LE(22) === 1 && header.readUInt32LE(24) === SAMPLE_RATE && header.readUInt16LE(34) === 16;
  if (!ok) throw new Error(`${url} is not a 16 kHz mono PCM16 WAV with a 44 byte header`);
  return header.readUInt32LE(40);
}

/** Exactly SPEECH_SECONDS of audio: the first source from FILLER_SKIP_SECONDS on, then the next sources from their start. */
async function fillerSamples(sources: ReadonlyArray<Source>, cacheDir: string): Promise<Int16Array> {
  let need = SPEECH_SECONDS * BYTES_PER_SECOND;
  let skip = FILLER_SKIP_SECONDS * BYTES_PER_SECOND;
  const chunks: Buffer[] = [];
  for (const source of sources) {
    if (need === 0) break;
    const url = CORPORA[source.corpus].url(source);
    const take = Math.min(need, Math.max(0, (await dataBytes(url)) - skip));
    if (take > 0) chunks.push(await cached(join(cacheDir, `${source.id}-${skip}-${take}.pcm`), () => fetchRange(url, 44 + skip, 44 + skip + take - 1)));
    need -= take;
    skip = 0;
  }
  if (need > 0) throw new Error(`${sources.map(source => source.id).join('+')} is ${need / BYTES_PER_SECOND} s too short for a ${SPEECH_SECONDS} s meeting`);
  return toInt16(Buffer.concat(chunks));
}

/** Aura-2 speech for `text`, resampled to the corpus rate. Cached by voice and text so reruns cost nothing. */
async function synthesize(text: string, voice: string, cacheDir: string): Promise<Int16Array> {
  const key = createHash('sha256').update(`${voice}\n${text}`).digest('hex').slice(0, 16);
  return toInt16(await cached(join(cacheDir, `tts-${key}.pcm`), async () => {
    const account = process.env['WORKERS_AI_ACCOUNT_ID'];
    const token = process.env['WORKERS_AI_API_TOKEN'];
    if (!account || !token) throw new Error('WORKERS_AI_ACCOUNT_ID and WORKERS_AI_API_TOKEN are required to synthesize the planted clips');
    const reply = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/@cf/deepgram/aura-2-en`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text, speaker: voice, encoding: 'linear16', container: 'none', sample_rate: 24_000 }),
    });
    if (!reply.ok) throw new Error(`Aura-2 answered ${reply.status} for voice ${voice}`);
    const resampled = spawnSync('ffmpeg', ['-v', 'error', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', 'pipe:0', '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', '1', 'pipe:1'],
      { input: Buffer.from(await reply.arrayBuffer()), maxBuffer: 2 ** 26 });
    if (resampled.status !== 0) throw new Error(`ffmpeg resample failed: ${resampled.stderr?.toString() ?? 'not found on PATH'}`);
    return resampled.stdout;
  }));
}

function wav(samples: Int16Array): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + samples.byteLength, 4);
  header.write('WAVEfmt ', 8, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(BYTES_PER_SECOND, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(samples.byteLength, 40);
  return Buffer.concat([header, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)]);
}

async function checkLicences(corpora: ReadonlyArray<keyof typeof CORPORA>) {
  return Promise.all(corpora.map(async corpus => {
    const { licence, licence_page, attribution } = CORPORA[corpus];
    const page = await (await fetch(licence_page)).text();
    if (!/Creative\s+Commons\s+Attribution\s+4\.0/i.test(page)) throw new Error(`${licence_page} no longer states CC BY 4.0; check the licence before using ${corpus} audio`);
    return { corpus, licence, licence_page, attribution, modifications: MODIFICATIONS, verified_at: new Date().toISOString() };
  }));
}

async function build(out: string, count: number) {
  const errors = validatePlan();
  if (errors.length > 0) throw new Error(`corpus plan is inconsistent:\n${errors.join('\n')}`);
  const cacheDir = join(out, 'cache');
  mkdirSync(cacheDir, { recursive: true });
  mkdirSync(join(out, 'audio'), { recursive: true });
  const built = FILLER.slice(0, count);
  const licences = await checkLicences([...new Set(built.flat().map(source => source.corpus))]);
  const durations = new Map<string, number>();
  const schedule = [];
  for (let index = 0; index < MEETINGS; index++) {
    const start_s = index * SLOT_SECONDS;
    const meeting = { index, id: `m${String(index).padStart(2, '0')}`, start_s, speech_s: SPEECH_SECONDS, gap_s: GAP_SECONDS, end_s: start_s + SLOT_SECONDS };
    const filler = FILLER[index]!.map(source => ({ ...source, url: CORPORA[source.corpus].url(source) }));
    if (index >= count) { schedule.push({ ...meeting, audio: null, filler }); continue; }
    const samples = await fillerSamples(FILLER[index]!, cacheDir);
    const level = rms(samples);
    const plant = async (spoken: string, voice: string, offsetSeconds: number | 'end') => {
      const clip = await synthesize(spoken, voice, cacheDir);
      if (clip.length > MAX_CLIP_SECONDS * SAMPLE_RATE) throw new Error(`clip "${spoken}" is longer than ${MAX_CLIP_SECONDS} s`);
      const at = offsetSeconds === 'end' ? samples.length - clip.length - Math.round(CLIP_PAD_SECONDS * SAMPLE_RATE) : Math.round(offsetSeconds * SAMPLE_RATE);
      // Match the clip to the filler's loudness so Whisper hears it like the rest of the meeting.
      splice(samples, at, clip, Math.max(0.25, Math.min(8, level / Math.max(1, rms(clip)))));
      return { at_s: start_s + at / SAMPLE_RATE, duration_s: clip.length / SAMPLE_RATE };
    };
    const start_cue = { spoken: START_CUE.spoken, voice: START_CUE.voice, ...await plant(START_CUE.spoken, START_CUE.voice, CLIP_PAD_SECONDS) };
    for (const fact of FACTS.filter(f => f.meeting === index)) durations.set(fact.id, (await plant(fact.spoken, fact.voice, fact.offset)).duration_s);
    const end_cue = { spoken: END_CUE.spoken, voice: END_CUE.voice, ...await plant(END_CUE.spoken, END_CUE.voice, 'end') };
    const file = `audio/${meeting.id}.wav`;
    const bytes = wav(samples);
    writeFileSync(join(out, file), bytes);
    schedule.push({ ...meeting, audio: { file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), duration_s: samples.length / SAMPLE_RATE }, filler, start_cue, end_cue });
  }
  const manifest = {
    version: 1,
    generated_at: new Date().toISOString(),
    t0: { epoch_s: null, tz: null },
    alias_match: 'whole_token',
    sample_rate: SAMPLE_RATE,
    meetings_total: MEETINGS,
    meetings_built: count,
    speech_s: SPEECH_SECONDS,
    gap_s: GAP_SECONDS,
    licences,
    schedule,
    facts: FACTS.map(plan => {
      const { offset, expect, ...fact } = plan;
      const at_s = startOf(plan);
      return { ...fact, ...(expect && { expect: { ...expect, after_s: at_s } }), at_s, meeting_offset_s: offset, duration_s: durations.get(fact.id) ?? null, audio_built: fact.meeting < count };
    }),
    checkpoints: CHECKPOINTS,
  };
  writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { out: { type: 'string', default: '.work/soak-corpus' }, meetings: { type: 'string', default: String(MEETINGS) } } });
  const count = Number(values.meetings);
  if (!Number.isInteger(count) || count < 1 || count > MEETINGS) throw new Error(`--meetings must be an integer from 1 to ${MEETINGS}`);
  const manifest = await build(values.out!, count);
  console.log(JSON.stringify({ manifest: join(values.out!, 'manifest.json'), meetings_built: manifest.meetings_built, facts: manifest.facts.filter(f => f.audio_built).length }));
}
