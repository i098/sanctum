/**
 * SQLite spellings of the MySQL time functions the domain code used. Timestamps are TEXT
 * `YYYY-MM-DD HH:MM:SS.ffffff` UTC; SQLite keeps milliseconds, so the last three digits are always 000.
 */
import { type SqlClient, Statement } from '@effect/sql';

const FORMAT = "'%Y-%m-%d %H:%M:%f000'";

/** A SQL expression: a trusted column name or fragment, never user text. */
type Expression = string | Statement.Fragment;

/** Joins expressions and literal text into one fragment, keeping bound parameters in order. */
const compose = (parts: ReadonlyArray<Expression>): Statement.Fragment => {
  const literals: Array<Statement.Literal> = parts.flatMap((part): Array<Statement.Literal> => {
    if (typeof part === 'string') return [{ _tag: 'Literal', value: part }];
    return part.segments.map(segment => {
      if (segment._tag !== 'Literal') throw new Error(`SQL fragments passed to the time helpers must be plain literals, got ${segment._tag}`);
      return segment;
    });
  });
  return Statement.unsafeFragment(literals.map(literal => literal.value).join(''), literals.flatMap(literal => literal.params ?? []));
};

/** `UTC_TIMESTAMP(6)` and `NOW()`. */
export const now = Statement.unsafeFragment(`strftime(${FORMAT}, 'now')`);

/** `DATE_ADD(expression, INTERVAL seconds SECOND)`; `seconds` may be negative or fractional. */
export const addSeconds = (expression: Expression, seconds: number) =>
  compose([`strftime(${FORMAT}, `, expression, ', ', Statement.unsafeFragment("? || ' seconds')", [seconds])]);

/** `TIMESTAMPDIFF(SECOND, from, to)`: whole seconds, truncated toward zero. */
export const diffSeconds = (from: Expression, to: Expression) =>
  compose(["CAST((unixepoch(", to, ", 'subsec') - unixepoch(", from, ", 'subsec')) AS INTEGER)"]);

/** `TIMESTAMPDIFF(MICROSECOND, from, to)`. */
export const diffMicros = (from: Expression, to: Expression) =>
  compose(["CAST(ROUND((unixepoch(", to, ", 'subsec') - unixepoch(", from, ", 'subsec')) * 1000000) AS INTEGER)"]);

/** Most bound parameters per statement D1 accepts. */
const MAX_PARAMS = 100;

const slices = <A>(rows: ReadonlyArray<A>, size: number): ReadonlyArray<ReadonlyArray<A>> =>
  Array.from({ length: Math.ceil(rows.length / size) }, (_, index) => rows.slice(index * size, (index + 1) * size));

/** Splits `rows` so that a statement binding `paramsPerRow` values per row stays within D1's limit. */
export const chunked = <A>(rows: ReadonlyArray<A>, paramsPerRow = 1) => slices(rows, Math.max(1, Math.floor(MAX_PARAMS / paramsPerRow)));

/** Most `SELECT` terms D1 accepts in one `UNION ALL`. */
const MAX_COMPOUND_TERMS = 5;

/** Splits the terms of a `UNION ALL` into groups that each run as one statement. */
export const compoundGroups = <A>(terms: ReadonlyArray<A>) => slices(terms, MAX_COMPOUND_TERMS);

/**
 * `column IN (values)` with the list bound as one JSON parameter. `sql.in` binds one parameter per value, so a list
 * as long as a workspace's meetings overflows D1's 100-parameter limit; this one never does. `column` is trusted.
 */
export const inList = (sql: SqlClient.SqlClient, column: string, values: ReadonlyArray<string>) =>
  sql`${sql(column)} IN (SELECT value FROM json_each(${JSON.stringify(values)}))`;
