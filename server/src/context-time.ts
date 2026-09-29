/**
 * Relative time phrases resolved against the utterance's event time in its meeting timezone
 * (plan section 08), never against the day a delayed job runs. Phrases this grammar does not
 * cover, and ambiguous ones ("next Friday", "at 3", a skipped or repeated DST hour), stay
 * unresolved instead of being guessed.
 */
import { type IanaTimeZone, type TimeExpression, UtcTimestamp } from '@sanctum/contracts';

interface Day { readonly y: number; readonly m: number; readonly d: number }
interface Clock { readonly h: number; readonly min: number }
type DateMeaning = { readonly day: Day } | { readonly instant: number } | null;

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const COUNTS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const UNIT_MS: Record<string, number> = { minute: MINUTE_MS, hour: 60 * MINUTE_MS };
const UNIT_DAYS: Record<string, number> = { day: 1, week: 7 };
const RELATIVE_DAYS: Record<string, number> = {
 today: 0, tonight: 0, 'this morning': 0, 'this afternoon': 0, 'this evening': 0,
 tomorrow: 1, yesterday: -1, 'day after tomorrow': 2, 'the day after tomorrow': 2,
};

/** Wall-clock reading of `ms` in `zone`, expressed as if that reading were UTC. */
function wallOf(zone: string, ms: number): number {
 const format = new Intl.DateTimeFormat('en-US', {
  timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
 });
 const part = Object.fromEntries(format.formatToParts(new Date(ms)).map(({ type, value }) => [type, Number(value)]));
 return Date.UTC(part.year!, part.month! - 1, part.day!, part.hour!, part.minute!, part.second!);
}

const dayOf = (wall: number): Day => {
 const date = new Date(wall);
 return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
};
const addDays = (day: Day, days: number): Day => dayOf(Date.UTC(day.y, day.m - 1, day.d + days));
const weekday = (day: Day) => new Date(Date.UTC(day.y, day.m - 1, day.d)).getUTCDay();

/** The one UTC instant showing this wall clock in `zone`; null inside a DST gap or a repeated hour. */
function toUtc(zone: string, day: Day, clock: Clock): number | null {
 const wall = Date.UTC(day.y, day.m - 1, day.d, clock.h, clock.min);
 const offsets = new Set([wall - DAY_MS / 2, wall + DAY_MS / 2].map(probe => wallOf(zone, probe) - probe));
 const hits = [...offsets].map(offset => wall - offset).filter(ms => wallOf(zone, ms) === wall);
 return hits.length === 1 ? hits[0]! : null;
}

function weekdayDay(today: Day, match: RegExpMatchArray): DateMeaning {
 const [, qualifier, name] = match;
 const target = WEEKDAYS.indexOf(name!);
 if (qualifier === 'next') return null;
 if (qualifier === 'last') return { day: addDays(today, -((weekday(today) - target + 7) % 7 || 7)) };
 const ahead = (target - weekday(today) + 7) % 7;
 return ahead === 0 && qualifier !== 'this' ? null : { day: addDays(today, ahead) };
}

function calendarDay(today: Day, y: number, m: number, d: number): DateMeaning {
 const day = dayOf(Date.UTC(y, m - 1, d));
 const exists = day.m === m && day.d === d;
 return exists && Date.UTC(y, m - 1, d) >= Date.UTC(today.y, today.m - 1, today.d) ? { day } : null;
}

function dateMeaning(text: string, today: Day, anchor: number): DateMeaning {
 if (text === '') return { day: today };
 if (text in RELATIVE_DAYS) return { day: addDays(today, RELATIVE_DAYS[text]!) };
 const weekdayMatch = text.match(new RegExp(`^(?:(this|next|last|on) )?(${WEEKDAYS.join('|')})$`));
 if (weekdayMatch) return weekdayDay(today, weekdayMatch);
 const span = text.match(/^in (\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve) (minute|hour|day|week)s?$/);
 if (span) {
  const [, amount, unit] = span;
  const n = COUNTS[amount!] ?? Number(amount);
  return unit! in UNIT_MS ? { instant: anchor + n * UNIT_MS[unit!]! } : { day: addDays(today, n * UNIT_DAYS[unit!]!) };
 }
 const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
 if (iso) return calendarDay(today, Number(iso[1]), Number(iso[2]), Number(iso[3]));
 const named = text.match(new RegExp(`^(${MONTHS.join('|')}) (\\d{1,2})(?:st|nd|rd|th)?$`));
 return named ? calendarDay(today, today.y, MONTHS.indexOf(named[1]!) + 1, Number(named[2])) : null;
}

const NAMED_CLOCKS: Record<string, Clock> = { noon: { h: 12, min: 0 }, midnight: { h: 0, min: 0 } };

/** `hour[:minute] [am|pm]` as a 24-hour clock; undefined when out of range. */
function clockOf(hour: number, minute: number, meridiem: string | undefined): Clock | undefined {
 const h = meridiem === undefined ? hour : (hour % 12) + (meridiem === 'pm' ? 12 : 0);
 const valid = h < 24 && minute < 60 && (meridiem === undefined || hour <= 12);
 return valid ? { h, min: minute } : undefined;
}

/** Splits a trailing or leading clock time off the phrase; `undefined` clock means "at 3" style ambiguity. */
function splitClock(text: string): { readonly rest: string; readonly clock: Clock | null | undefined } {
 const match = text.match(/(?:^|\s)(?:at\s+)?(noon|midnight|(?=\d{1,2}(?::\d{2}|\s*[ap]m))(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)(?=\s|$)|(?:^|\s)at\s+(\d{1,2})(?=\s|$)/);
 if (!match) return { rest: text, clock: null };
 const rest = text.replace(match[0], ' ').replace(/\s+/g, ' ').trim();
 const [, word, hour, minute, meridiem, bare] = match;
 if (bare !== undefined) return { rest, clock: Number(bare) > 12 ? clockOf(Number(bare), 0, undefined) : undefined };
 return { rest, clock: NAMED_CLOCKS[word!] ?? clockOf(Number(hour), Number(minute ?? 0), meridiem) };
}

/** The resolved instant; `timed` when the phrase fixes a time of day, not just a day. */
function normalize(phrase: string, anchor: number, zone: string): { readonly ms: number; readonly timed: boolean } | null {
 const text = phrase.toLowerCase().replace(/[.,!?]+$/, '').replace(/\s+/g, ' ').trim();
 const { rest, clock } = splitClock(text);
 if (clock === undefined) return null;
 const meaning = dateMeaning(rest.replace(/^(on|by) /, ''), dayOf(wallOf(zone, anchor)), anchor);
 if (meaning === null) return null;
 if ('instant' in meaning) return clock === null ? { ms: meaning.instant, timed: true } : null;
 const ms = toUtc(zone, meaning.day, clock ?? { h: 0, min: 0 });
 return ms === null ? null : { ms, timed: clock !== null };
}

/** Resolves `phrase` said at `anchor` in `timezone`; day-only phrases normalize to that local midnight but stay ambiguous for exact scheduling. */
export function resolveTime(phrase: string, anchor: UtcTimestamp, timezone: IanaTimeZone): typeof TimeExpression.Type {
 const resolved = normalize(phrase, Date.parse(anchor), timezone);
 return {
  phrase,
  normalized: resolved === null ? null : UtcTimestamp.make(new Date(resolved.ms).toISOString()),
  anchor,
  timezone,
  ambiguous: resolved === null || !resolved.timed,
 };
}
