import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

const MYSQL = new URL('../server/migrations/', import.meta.url);
const BASELINE = new URL('../server/migrations-d1/0001_baseline.sql', import.meta.url);
/** Tables and virtual-table shadows that exist only in D1. */
const D1_ONLY = /^(tx_clock|tx_conflict|context_items_fts(_\w+)?)$/;

const TOP_LEVEL_COMMA = /,(?![^(]*\))/;

/** Column names per table of the MySQL schema after every migration; the embedded issuer's auth_ tables are not part of D1. */
function mysqlColumns(): Map<string, string[]> {
  const tables = new Map<string, string[]>();
  for (const file of readdirSync(MYSQL).filter(f => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(new URL(file, MYSQL), 'utf8').replace(/^\s*--.*$/gm, '');
    for (const [, name, body] of sql.matchAll(/CREATE TABLE `?(\w+)`? \(([\s\S]*?)\n\)\s*ENGINE/gi)) {
      if (name!.startsWith('auth_')) continue;
      const columns = body!.split(TOP_LEVEL_COMMA).map(item => item.trim()).filter(item => !/^(PRIMARY KEY|UNIQUE KEY|KEY|FULLTEXT KEY|CONSTRAINT)\b/i.test(item));
      tables.set(name!, columns.map(item => /^`?(\w+)`?/.exec(item)![1]!));
    }
    for (const [, table, column] of sql.matchAll(/ALTER TABLE `?(\w+)`? ADD COLUMN `?(\w+)`?/gi)) if (!table!.startsWith('auth_')) tables.get(table!)!.push(column!);
  }
  return tables;
}

test('every MySQL table exists in the D1 baseline with the same column names', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(BASELINE, 'utf8'));
  const d1 = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map(t => t.name).filter(n => !D1_ONLY.test(n));
  const mysql = mysqlColumns();
  assert.deepEqual(d1.sort(), [...mysql.keys()].sort());
  for (const [table, columns] of mysql) {
    const actual = (db.prepare(`PRAGMA table_xinfo(${table})`).all() as Array<{ name: string }>).map(c => c.name);
    assert.deepEqual(actual.sort(), columns.sort(), table);
  }
});
