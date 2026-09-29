import { describe, expect, it } from '@effect/vitest';
import { IanaTimeZone, UtcTimestamp } from '@sanctum/contracts';
import { resolveTime } from '../src/context-time.ts';

const LA = IanaTimeZone.make('America/Los_Angeles');
const at = (anchor: string, phrase: string, zone = LA) => resolveTime(phrase, UtcTimestamp.make(anchor), zone).normalized;

describe('relative time resolution', () => {
  it('anchors on the utterance in the meeting timezone, not on UTC dates', () => {
    // 23:59:30 PDT on Tuesday 29 September is already 30 September in UTC.
    expect(at('2026-09-30T06:59:30Z', 'tomorrow')).toBe('2026-09-30T07:00:00.000Z');
    expect(at('2026-09-30T06:59:30Z', 'today')).toBe('2026-09-29T07:00:00.000Z');
    expect(at('2026-09-30T07:00:30Z', 'Tomorrow.')).toBe('2026-10-01T07:00:00.000Z');
    expect(at('2026-09-26T17:08:16.123456Z', 'tomorrow at 9am', IanaTimeZone.make('Europe/Berlin'))).toBe('2026-09-27T07:00:00.000Z');
  });

  it('applies the offset in force on the resolved day across DST changes', () => {
    // Saturday 31 October 10:00 PDT; PST starts at 02:00 on 1 November.
    expect(at('2026-10-31T17:00:00Z', 'tomorrow at 9am')).toBe('2026-11-01T17:00:00.000Z');
    expect(at('2026-10-31T17:00:00Z', 'at 9:30 pm')).toBe('2026-11-01T04:30:00.000Z');
    expect(at('2026-10-31T17:00:00Z', 'in 2 hours')).toBe('2026-10-31T19:00:00.000Z');
  });

  it('keeps skipped and repeated DST wall times unresolved', () => {
    const repeated = resolveTime('tomorrow at 1:30am', UtcTimestamp.make('2026-10-31T17:00:00Z'), LA);
    expect(repeated).toEqual({ phrase: 'tomorrow at 1:30am', normalized: null, anchor: '2026-10-31T17:00:00Z', timezone: LA, ambiguous: true });
    expect(at('2027-03-13T18:00:00Z', 'tomorrow at 2:30am')).toBeNull();
    expect(at('2027-03-13T18:00:00Z', 'tomorrow at 3:30am')).toBe('2027-03-14T10:30:00.000Z');
  });

  it('resolves weekdays, spans and calendar dates and refuses ambiguous ones', () => {
    const saturday = '2026-09-26T17:00:00Z';
    expect(at(saturday, 'on Friday')).toBe('2026-10-02T07:00:00.000Z');
    expect(at(saturday, 'last monday')).toBe('2026-09-21T07:00:00.000Z');
    expect(at(saturday, 'this saturday')).toBe('2026-09-26T07:00:00.000Z');
    expect(at(saturday, 'saturday')).toBeNull();
    expect(at(saturday, 'next Friday')).toBeNull();
    expect(at(saturday, 'in two weeks')).toBe('2026-10-10T07:00:00.000Z');
    expect(at(saturday, 'October 3rd at noon')).toBe('2026-10-03T19:00:00.000Z');
    expect(at(saturday, '2026-12-01')).toBe('2026-12-01T08:00:00.000Z');
    expect(at(saturday, 'February 30')).toBeNull();
    expect(at(saturday, 'September 1')).toBeNull();
    expect(at(saturday, 'tomorrow at 3')).toBeNull();
    expect(at(saturday, 'tomorrow at 15')).toBe('2026-09-27T22:00:00.000Z');
    expect(at(saturday, 'next week')).toBeNull();
    expect(at(saturday, 'in 2 hours at 5pm')).toBeNull();
    expect(at(saturday, 'at 13pm')).toBeNull();
  });
});
