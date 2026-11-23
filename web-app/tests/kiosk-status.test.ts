import { describe, expect, it } from 'vitest';
import { CLIENT_GONE, clientGone, parseStatus, type KioskStatus, statusLines } from '../src/pages/kiosk/status-source.ts';

const LISTENING = {
  state: 'listening', bands: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8], code: null, verification_uri: null,
  name: 'Room 4', cause: null, saved_through: '2026-11-23T10:00:00Z', owner: { approved_by_name: 'Ada', workspace_name: 'Acme' },
};

describe('kiosk status feed', () => {
  it('reads a status event of the section 2.6 shape', () => {
    expect(parseStatus(JSON.stringify(LISTENING))).toEqual(LISTENING);
  });

  it('ignores events that are not a status, so they never change the screen', () => {
    for (const data of ['', 'not json', 'null', '[]', '{}', JSON.stringify({ ...LISTENING, state: 'speaking' }), JSON.stringify({ ...LISTENING, state: 'toString' })]) {
      expect(parseStatus(data), data).toBeNull();
    }
  });

  it('clamps band levels to 0..1 and keeps at most eight bands', () => {
    const status = parseStatus(JSON.stringify({ ...LISTENING, bands: [2, -1, 0.5, 'x', 0, 0, 0, 0, 0.9] }));
    expect(status?.bands).toEqual([0, 0, 0.5, 0, 0, 0, 0, 0]);
  });

  it('drops an owner with a missing name', () => {
    expect(parseStatus(JSON.stringify({ ...LISTENING, owner: { approved_by_name: 'Ada' } }))?.owner).toBeNull();
  });

  it('a silent feed shows error, never the last listening state', () => {
    const gone = clientGone(parseStatus(JSON.stringify(LISTENING)));
    expect(gone).toMatchObject({ state: 'error', cause: CLIENT_GONE, name: 'Room 4', bands: [], owner: null, saved_through: null });
  });
});

describe('kiosk status lines', () => {
  const status = parseStatus(JSON.stringify(LISTENING))!;
  const lines = (patch: Partial<KioskStatus>) => statusLines({ ...status, ...patch });

  it('listening shows the quiet helper, the saved-through time and whom it records for', () => {
    expect(lines({})).toMatchObject({ text: 'Recording.', tone: undefined, owner: 'For Ada · Acme' });
    expect(lines({}).saved).toMatch(/^Saved through \d/);
  });

  it('the saved-through time shows only while listening and only for a valid time', () => {
    expect(lines({ state: 'stopped' }).saved).toBeNull();
    expect(lines({ saved_through: 'soon' }).saved).toBeNull();
  });

  it('reconnecting keeps its fixed warning; degraded and error show the cause, or a fallback without one', () => {
    expect(lines({ state: 'reconnecting', cause: 'ignored' })).toMatchObject({ text: 'Recording on this device. Server not reachable.', tone: 'warning' });
    expect(lines({ state: 'degraded', cause: 'Upload behind.' })).toMatchObject({ text: 'Upload behind.', tone: 'warning' });
    expect(lines({ state: 'error', cause: null })).toMatchObject({ text: 'The device stopped.', tone: 'error' });
    expect(statusLines(clientGone(status))).toMatchObject({ text: CLIENT_GONE, tone: 'error', owner: null });
  });
});
