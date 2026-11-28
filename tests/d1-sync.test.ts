import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { BASELINE, d1Select, digest, loadSchema, snapshot, sqliteRows, verify, type Row, type Table } from '../scripts/d1-sync.ts';

const baseline = readFileSync(BASELINE, 'utf8');
const schema = loadSchema(baseline);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const PRINCIPAL = '22222222-2222-4222-8222-222222222222';

/** Rows as mysql2 returns them (BIGINT as string, JSON as text, BINARY as Buffer); columns a fixture omits become NULL. */
function fixture(): Record<string, Row[]> {
  const base = { id: 'c0000000-0000-4000-8000-000000000001', revision: '1', workspace_id: WORKSPACE, kind: 'decision', state: 'committed', derivation: 'spoken', sources: '[]', author_type: 'human', author_principal_id: PRINCIPAL, created_at: '2026-01-02 03:04:05.123456' };
  return {
    workspaces: [{ id: WORKSPACE, name: "O'Brien \u00e9 \ud83d\ude00", timezone: 'UTC', context_seq: '9007199254740993', permission_revision: 1, capture_policy: '{"a": 1, "b": [true, null]}', created_at: '2026-01-01 00:00:00.000000' }],
    principals: [{ id: PRINCIPAL, kind: 'human', display_name: null, created_at: '2026-01-01 00:00:00.000000' }],
    workspace_members: [{ workspace_id: WORKSPACE, principal_id: PRINCIPAL, role: 'owner', created_at: '2026-01-01 00:00:00.000000' }],
    // A superseding row listed first would break a load that ignores foreign-key order within a table.
    context_items: [
      { ...base, id: 'c0000000-0000-4000-8000-000000000002', revision: 2, text: 'Revised: off-site in May', supersedes_id: base.id, supersedes_revision: 1 },
      { ...base, text: 'Plan the off-site trip\nline two' },
    ],
    jobs: [{ id: 'd0000000-0000-4000-8000-000000000001', workspace_id: WORKSPACE, kind: 'k', work_key: 'w', status: 'pending', active_work_key: 'w', payload: '{}', available_at: '2026-01-01 00:00:00.000000', max_attempts: 3, lease_generation: 0, attempts: 0, rearmed: 0, created_at: '2026-01-01 00:00:00.000000', updated_at: '2026-01-01 00:00:00.000000' }],
    profiles: [{ id: 'e0000000-0000-4000-8000-000000000001', workspace_id: WORKSPACE, kind: 'person', display_name: 'A', details: '{}', revision: 1, created_at: '2026-01-01 00:00:00.000000', updated_at: '2026-01-01 00:00:00.000000' }],
    profile_embeddings: [{ workspace_id: WORKSPACE, profile_id: 'e0000000-0000-4000-8000-000000000001', kind: 'needs', model: 'm', dimension: 1, embedding: Buffer.from([0, 0, 128, 63]), source_revision: 1, created_at: '2026-01-01 00:00:00.000000' }],
  };
}

const source = (data: Record<string, Row[]>) => async (table: Table) => (data[table.name] ?? []).map(row => Object.fromEntries(table.columns.map(c => [c.name, row[c.name] ?? null])));

async function load(data: Record<string, Row[]>, target = new DatabaseSync(':memory:')) {
  if (target.prepare("SELECT 1 FROM sqlite_master WHERE name = 'workspaces'").get() === undefined) target.exec(baseline);
  const statements: string[] = [];
  await snapshot(schema, source(data), s => statements.push(s));
  for (const statement of statements) target.exec(statement);
  return { target, statements };
}

test('fixture rows load into SQLite with equal counts and checksums', async () => {
  const data = fixture();
  const { target } = await load(data);
  for (const table of schema.tables) {
    const [expected, actual] = [await digest(table, source(data)), await digest(table, sqliteRows(target))];
    assert.deepEqual(actual, expected, table.name);
  }
  assert.equal(target.prepare('SELECT count(*) AS n FROM context_items').get()!.n, 2);
  assert.deepEqual(await verify(schema, source(data), sqliteRows(target)), []);
});

test('a second snapshot replaces stale rows, searches the text and keeps D1-only tables', async () => {
  const data = fixture();
  const { target } = await load(data);
  target.exec("INSERT INTO workspaces (id, name, timezone, created_at) VALUES ('stale', 's', 'UTC', '2026-01-01 00:00:00.000000')");
  data.context_items = data.context_items!.slice(1);
  await load(data, target);
  assert.equal(target.prepare("SELECT count(*) AS n FROM workspaces WHERE id = 'stale'").get()!.n, 0);
  assert.equal(target.prepare('SELECT count(*) AS n FROM tx_clock').get()!.n, 1);
  const found = (query: string) => target.prepare('SELECT rowid FROM context_items_fts WHERE context_items_fts MATCH ?').all(query).length;
  assert.equal(found('"offsite"*'), 1);
  assert.equal(found('"revised"*'), 0);
  target.exec("INSERT INTO context_items (id, revision, workspace_id, kind, text, state, derivation, sources, author_type, author_principal_id, created_at) VALUES ('new', 1, '" + WORKSPACE + "', 'decision', 'Hire a designer', 'committed', 'spoken', '[]', 'human', '" + PRINCIPAL + "', '2026-01-03 00:00:00.000000')");
  assert.equal(found('"designer"'), 1);
});

test('inserts stay under the D1 statement size and an oversized row fails loudly', async () => {
  const data = fixture();
  data.sync_cursors = Array.from({ length: 400 }, (_, i) => ({ name: `feed-${i}`, cursor: 'x'.repeat(250), updated_at: '2026-01-01 00:00:00.000000' }));
  const { statements } = await load(data);
  const inserts = statements.filter(s => s.startsWith('INSERT INTO sync_cursors'));
  assert(inserts.length > 1);
  for (const s of statements) assert(Buffer.byteLength(s) <= 90_000);
  data.artifacts = [{ id: 'a', workspace_id: WORKSPACE, kind: 'document', title: 't', content_type: 'text/plain', content: 'x'.repeat(100_000), sha256: Buffer.alloc(32), provenance: '{}', created_by: PRINCIPAL, created_at: '2026-01-01 00:00:00.000000' }];
  await assert.rejects(snapshot(schema, source(data), () => undefined), /artifacts row needs/);
});

test('verify names the table whose rows differ', async () => {
  const data = fixture();
  const { target } = await load(data);
  target.exec("UPDATE principals SET display_name = 'changed'");
  assert.deepEqual(await verify(schema, source(data), sqliteRows(target)), ['principals: TiDB 1 rows, D1 1 rows (checksums differ)']);
});

test('d1Select keeps a NULL BLOB NULL and hex-encodes a present one', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t (a BLOB, b BLOB); INSERT INTO t VALUES (NULL, x\'0aff\')');
  const table: Table = { name: 't', selfReference: false, columns: [{ name: 'a', type: 'BLOB' }, { name: 'b', type: 'BLOB' }] };
  assert.deepEqual({ ...db.prepare(`SELECT ${d1Select(table)} FROM t`).get() }, { a: null, b: '0AFF' });
});
