/**
 * Accelerated capture replay (plan section 18): feeds a synthetic 24-hour trace of final
 * transcript windows through the live path's `publishFinalWindow` against a disposable MySQL
 * database, then checks meeting boundaries, one owner per segment and bounded memory. It proves
 * behavior over a day of source time in seconds of wall time; it is not a 24-hour uptime soak.
 *
 * Usage: node scripts/replay-capture.ts --fixture server/tests/fixtures/day.json --accelerated [--mysql-url mysql://...]
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { SqlClient } from '@effect/sql';
import { Effect } from 'effect';
import { publishFinalWindow } from '../server/src/transcripts.ts';
import { database } from './benchmark.ts';

interface Block { readonly label: string; readonly at_minute: number; readonly utterances: number; readonly every_seconds: number; readonly first: string }
interface DayTrace { readonly sample_rate: number; readonly utterance_seconds: number; readonly blocks: ReadonlyArray<Block>; readonly expected: { readonly meetings: number; readonly segments: number } }

/** Final windows in source order: each block's first line carries its cue, the rest are ordinary discussion. */
function windows(trace: DayTrace) {
  return trace.blocks.flatMap(block =>
    Array.from({ length: block.utterances }, (_, i) => {
      const start = Math.round((block.at_minute * 60 + i * block.every_seconds) * trace.sample_rate);
      const text = i === 0 ? block.first : `In the ${block.label} we discuss item ${i} and the follow up owners.`;
      return { sample_start: start, sample_end: start + trace.utterance_seconds * trace.sample_rate, text };
    }),
  );
}

async function replay(trace: DayTrace, mysqlUrl: string) {
  const db = await database(mysqlUrl);
  try {
    const rssBefore = process.memoryUsage().rss;
    const started = performance.now();
    for (const window of windows(trace)) {
      await db.runtime.runPromise(publishFinalWindow({
        workspace_id: db.owner.workspace_id, epoch_id: db.epoch, track: 0, window, segments: [{ ...window, confidence: 0.9, speaker_label: null }],
        origin: 'live', provider: 'replay', model: 'replay', provider_connection_id: null, listener_id: db.listener, capture_group_id: null,
      }));
    }
    const wallMs = performance.now() - started;
    const counts = await db.runtime.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const [meetings] = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM meetings`;
      const [segments] = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM transcript_segments WHERE status = 'final'`;
      const [unowned] = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM transcript_segments s WHERE (SELECT COUNT(*) FROM meeting_ranges r JOIN meetings m
        ON m.id = r.meeting_id AND m.boundary_revision = r.boundary_revision WHERE r.epoch_id = s.epoch_id AND s.sample_start >= r.sample_start AND s.sample_start < r.sample_end) <> 1`;
      return { meetings: Number(meetings!.n), segments: Number(segments!.n), unowned: Number(unowned!.n) };
    }));
    return { ...counts, wallMs, rssGrowthMiB: (process.memoryUsage().rss - rssBefore) / 2 ** 20 };
  } finally {
    await db.drop();
  }
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { fixture: { type: 'string' }, accelerated: { type: 'boolean', default: false }, 'mysql-url': { type: 'string' } } });
  const url = values['mysql-url'] ?? process.env['SANCTUM_TEST_MYSQL_URL'];
  if (!values.fixture || !values.accelerated || !url) throw new Error('Usage: --fixture <day.json> --accelerated and --mysql-url or SANCTUM_TEST_MYSQL_URL');
  const trace: DayTrace = JSON.parse(readFileSync(values.fixture, 'utf8'));
  const result = await replay(trace, url);
  console.log(JSON.stringify(result));
  const failures = [
    result.meetings !== trace.expected.meetings && `meetings ${result.meetings}, expected ${trace.expected.meetings}`,
    result.segments !== trace.expected.segments && `segments ${result.segments}, expected ${trace.expected.segments}`,
    result.unowned !== 0 && `${result.unowned} segments without exactly one owning meeting`,
  ].filter(Boolean);
  failures.forEach(failure => console.error(failure));
  if (failures.length > 0) process.exitCode = 1;
}
