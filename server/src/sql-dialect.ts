/**
 * SQLite spellings of the MySQL time functions the domain code used. Timestamps are TEXT
 * `YYYY-MM-DD HH:MM:SS.ffffff` UTC; SQLite keeps milliseconds, so the last three digits are always 000.
 */
import { Statement } from '@effect/sql';

const FORMAT = "'%Y-%m-%d %H:%M:%f000'";

/** A SQL expression: a trusted column name or fragment, never user text. */
type Expression = string | Statement.Fragment;

/** Joins expressions and literal text into one fragment, keeping bound parameters in order. */
const compose = (parts: ReadonlyArray<Expression>): Statement.Fragment => {
  const literals: Array<Statement.Literal> = parts.flatMap((part): Array<Statement.Literal> =>
    typeof part === 'string' ? [{ _tag: 'Literal', value: part }] : part.segments.filter(segment => segment._tag === 'Literal'));
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
export const MAX_PARAMS = 100;

/** Splits `rows` so that a statement binding `paramsPerRow` values per row stays within D1's limit. */
export const chunked = <A>(rows: ReadonlyArray<A>, paramsPerRow = 1): ReadonlyArray<ReadonlyArray<A>> => {
  const size = Math.max(1, Math.floor(MAX_PARAMS / paramsPerRow));
  return Array.from({ length: Math.ceil(rows.length / size) }, (_, index) => rows.slice(index * size, (index + 1) * size));
};
