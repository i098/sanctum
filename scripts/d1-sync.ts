/**
 * TiDB -> D1 standby sync (docs/d1-switchover.md). One direction, full snapshot.
 *
 *   node scripts/d1-sync.ts snapshot --out snapshot.sql   read TiDB, write the SQL that replaces D1's rows
 *   node scripts/d1-sync.ts verify                        compare row counts and checksums of TiDB and D1
 *
 * Environment: D1_SYNC_MYSQL_URL (read-only TiDB user, TLS is always on). `verify` also runs `wrangler d1 execute`, which
 * needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID. Tables, columns and foreign-key order come from the baseline schema.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { createConnection } from 'mysql2/promise';

export type Cell = string | number | bigint | Uint8Array | null;
export type Row = Record<string, Cell>;
export interface Column { readonly name: string; readonly type: string }
export interface Table { readonly name: string; readonly columns: ReadonlyArray<Column>; readonly selfReference: boolean }
export interface Schema {
  /** Foreign-key parents first. */
  readonly tables: ReadonlyArray<Table>;
  readonly triggers: ReadonlyArray<{ readonly name: string; readonly sql: string }>;
  readonly searchIndexes: ReadonlyArray<string>;
}
export type ReadRows = (table: Table) => Promise<Iterable<Row>>;

export const BASELINE = new URL('../server/migrations-d1/0001_baseline.sql', import.meta.url);
/** Maximum bytes of one INSERT: D1 refuses statements over 100 KB. */
const STATEMENT_BYTES = 90_000;
/** D1 only: the transaction clock is not in TiDB. */
const LOCAL_TABLES = ['tx_clock', 'tx_conflict', 'd1_migrations'];

export function loadSchema(baseline: string): Schema {
  const db = new DatabaseSync(':memory:');
  db.exec(baseline);
  const master = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all() as Array<{ type: string; name: string; sql: string }>;
  const searchIndexes = master.filter(m => /^CREATE VIRTUAL TABLE/i.test(m.sql)).map(m => m.name);
  const shadow = (name: string) => searchIndexes.some(s => name.startsWith(`${s}_`));
  const names = master.filter(m => m.type === 'table' && !LOCAL_TABLES.includes(m.name) && !searchIndexes.includes(m.name) && !shadow(m.name)).map(m => m.name);
  const parents = new Map(names.map(name => [name, (db.prepare(`PRAGMA foreign_key_list(${name})`).all() as Array<{ table: string }>).map(f => f.table)]));
  const tables: Table[] = [];
  const pending = new Set(names);
  while (pending.size > 0) {
    const ready = [...pending].filter(name => parents.get(name)!.every(p => p === name || !pending.has(p)));
    if (ready.length === 0) throw new Error(`foreign-key cycle among ${[...pending].join(', ')}`);
    for (const name of ready) {
      pending.delete(name);
      const info = db.prepare(`PRAGMA table_xinfo(${name})`).all() as Array<{ name: string; type: string; hidden: number }>;
      tables.push({ name, columns: info.filter(c => c.hidden === 0), selfReference: parents.get(name)!.includes(name) });
    }
  }
  return { tables, triggers: master.filter(m => m.type === 'trigger').map(({ name, sql }) => ({ name, sql })), searchIndexes };
}

const text = (cell: Cell) => (typeof cell === 'string' ? cell : String(cell));
const hex = (cell: Cell) => Buffer.from(cell as Uint8Array).toString('hex');

/** The SQL literal of one cell. */
function literal(column: Column, cell: Cell): string {
  if (cell === null) return 'NULL';
  if (column.type === 'BLOB') return `X'${hex(cell)}'`;
  if (column.type === 'INTEGER') return BigInt(cell as string | number | bigint).toString();
  if (column.type === 'REAL') return String(Number(cell));
  return `'${text(cell).replaceAll("'", "''")}'`;
}

/** The same cell text from TiDB, node:sqlite or D1, so equal rows hash equal. */
function canonical(column: Column, cell: Cell): string | null {
  if (cell === null) return null;
  if (column.type === 'BLOB') return hex(cell);
  if (column.type === 'INTEGER') return BigInt(cell as string | number | bigint).toString();
  if (column.type === 'REAL') return String(Number(cell));
  return text(cell);
}

export interface TableDigest { readonly count: number; readonly sum: string }

/** Row count and an order-independent checksum: the sum of the rows' SHA-256 values modulo 2^256. */
export async function digest(table: Table, read: ReadRows): Promise<TableDigest> {
  let count = 0;
  let sum = 0n;
  for (const row of await read(table)) {
    count++;
    const cells = table.columns.map(c => canonical(c, row[c.name]!));
    sum = (sum + BigInt(`0x${createHash('sha256').update(JSON.stringify(cells)).digest('hex')}`)) & ((1n << 256n) - 1n);
  }
  return { count, sum: sum.toString(16) };
}

/** SQL that makes D1 hold exactly the rows `read` returns. Triggers are dropped while loading so the search index is rebuilt once. */
export async function snapshot(schema: Schema, read: ReadRows, write: (statement: string) => void): Promise<void> {
  write('PRAGMA defer_foreign_keys = on;');
  for (const t of schema.triggers) write(`DROP TRIGGER IF EXISTS ${t.name};`);
  for (const table of [...schema.tables].reverse()) write(`DELETE FROM ${table.name};`);
  for (const table of schema.tables) {
    const head = `INSERT INTO ${table.name} (${table.columns.map(c => c.name).join(', ')}) VALUES `;
    let values: string[] = [];
    let bytes = head.length;
    const flush = () => {
      if (values.length > 0) write(`${head}${values.join(', ')};`);
      values = [];
      bytes = head.length;
    };
    for (const row of await read(table)) {
      const tuple = `(${table.columns.map(c => literal(c, row[c.name]!)).join(', ')})`;
      const size = Buffer.byteLength(tuple) + 2;
      if (head.length + size > STATEMENT_BYTES) throw new Error(`a ${table.name} row needs ${size} bytes; D1 allows ${STATEMENT_BYTES} per statement`);
      if (bytes + size > STATEMENT_BYTES) flush();
      values.push(tuple);
      bytes += size;
    }
    flush();
  }
  for (const index of schema.searchIndexes) write(`INSERT INTO ${index} (${index}) VALUES ('rebuild');`);
  for (const t of schema.triggers) write(`${t.sql};`);
}

/** Rows of a node:sqlite database, for tests and local checks. */
export function sqliteRows(db: DatabaseSync): ReadRows {
  return async table => {
    const statement = db.prepare(`SELECT ${table.columns.map(c => c.name).join(', ')} FROM ${table.name}`);
    statement.setReadBigInts(true);
    return statement.all() as Row[];
  };
}

async function mysqlRows(url: string): Promise<{ read: ReadRows; close: () => Promise<void> }> {
  const connection = await createConnection({
    uri: url,
    ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    typeCast: (field, next) => (field.type === 'JSON' ? field.string() : next()),
  });
  const read: ReadRows = async table => {
    const order = table.selfReference ? ' ORDER BY created_at' : '';
    const [rows] = await connection.query(`SELECT ${table.columns.map(c => `\`${c.name}\``).join(', ')} FROM \`${table.name}\`${order}`);
    return rows as Row[];
  };
  return { read, close: () => connection.end() };
}

/** Rows of the remote D1 database through `wrangler d1 execute`, paged by rowid. */
function d1Rows(config: string, database: string): ReadRows {
  const query = (sql: string) => {
    const out = execFileSync('npx', ['wrangler', 'd1', 'execute', database, '--remote', '--config', config, '--json', '--command', sql], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
    return (JSON.parse(out) as Array<{ results: Row[] }>)[0]!.results;
  };
  return async table => {
    const select = table.columns.map(c => (c.type === 'BLOB' ? `hex(${c.name}) AS ${c.name}` : c.name)).join(', ');
    const rows: Row[] = [];
    for (let after = 0; ; ) {
      const page = query(`SELECT rowid AS _rowid, ${select} FROM ${table.name} WHERE rowid > ${after} ORDER BY rowid LIMIT 2000`);
      for (const row of page) {
        for (const c of table.columns) if (c.type === 'BLOB' && row[c.name] !== null) row[c.name] = Buffer.from(row[c.name] as string, 'hex');
        rows.push(row);
      }
      if (page.length < 2000) return rows;
      after = Number(page[page.length - 1]!._rowid);
    }
  };
}

export async function verify(schema: Schema, source: ReadRows, target: ReadRows): Promise<string[]> {
  const failures: string[] = [];
  for (const table of schema.tables) {
    const [a, b] = [await digest(table, source), await digest(table, target)];
    if (a.count !== b.count || a.sum !== b.sum) failures.push(`${table.name}: TiDB ${a.count} rows, D1 ${b.count} rows${a.count === b.count ? ' (checksums differ)' : ''}`);
  }
  return failures;
}

async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { out: { type: 'string' }, config: { type: 'string', default: 'deploy/d1/wrangler.jsonc' }, database: { type: 'string', default: 'sanctum' } } });
  const url = process.env.D1_SYNC_MYSQL_URL;
  if (!url) throw new Error('D1_SYNC_MYSQL_URL is not set');
  const schema = loadSchema(readFileSync(BASELINE, 'utf8'));
  const mysql = await mysqlRows(url);
  try {
    if (positionals[0] === 'snapshot') {
      if (!values.out) throw new Error('snapshot needs --out <file>');
      writeFileSync(values.out, '');
      await snapshot(schema, mysql.read, statement => appendFileSync(values.out!, `${statement}\n`));
      console.log(`wrote ${values.out} for ${schema.tables.length} tables`);
    } else if (positionals[0] === 'verify') {
      const failures = await verify(schema, mysql.read, d1Rows(values.config!, values.database!));
      if (failures.length > 0) throw new Error(`D1 differs from TiDB:\n${failures.join('\n')}`);
      console.log(`D1 matches TiDB: row counts and checksums of ${schema.tables.length} tables`);
    } else throw new Error('usage: d1-sync.ts snapshot --out <file> | verify');
  } finally {
    await mysql.close();
  }
}

if (import.meta.main) await main();
