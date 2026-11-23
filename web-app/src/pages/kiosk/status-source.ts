/**
 * The device client's status feed: same-origin `GET /events` server-sent events (shared spec section 2.6).
 * The page holds no session and no microphone; it shows only what the device client reports.
 */
import type { DeviceState } from '@sanctum/contracts';

export interface KioskStatus {
  readonly state: DeviceState;
  /** Eight 0..1 band levels. */
  readonly bands: ReadonlyArray<number>;
  readonly code: string | null;
  readonly verification_uri: string | null;
  readonly name: string;
  readonly cause: string | null;
  readonly saved_through: string | null;
  readonly owner: { readonly approved_by_name: string; readonly workspace_name: string } | null;
}

/** The client sends at least one event each second; three silent seconds mean it is gone. */
const STALE_MS = 3000;
export const CLIENT_GONE = 'Device client not running.';
const RECONNECT_MS = 1000;

const STATES: Record<DeviceState, true> = {
  unpaired: true, stopped: true, starting: true, listening: true, reconnecting: true, degraded: true, paused: true, error: true,
};

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const unit = (value: unknown): number => (typeof value === 'number' && value >= 0 && value <= 1 ? value : 0);

/** One event's data, or null when it is not a status: a malformed event never changes the screen. */
export function parseStatus(data: string): KioskStatus | null {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const event = raw as Record<string, unknown>;
  if (typeof event['state'] !== 'string' || !Object.hasOwn(STATES, event['state'])) return null;
  const owner = event['owner'] as Record<string, unknown> | null | undefined;
  const approvedBy = text(owner?.['approved_by_name']);
  const workspace = text(owner?.['workspace_name']);
  return {
    state: event['state'] as DeviceState,
    bands: Array.isArray(event['bands']) ? event['bands'].slice(0, 8).map(unit) : [],
    code: text(event['code']),
    verification_uri: text(event['verification_uri']),
    name: text(event['name']) ?? '',
    cause: text(event['cause']),
    saved_through: text(event['saved_through']),
    owner: approvedBy !== null && workspace !== null ? { approved_by_name: approvedBy, workspace_name: workspace } : null,
  };
}

/** What the screen shows once the feed is silent: an error, never the last state, so old data never claims listening. */
export function clientGone(last: KioskStatus | null): KioskStatus {
  return {
    state: 'error', bands: [], code: null, verification_uri: null,
    name: last?.name ?? '', cause: CLIENT_GONE, saved_through: null, owner: null,
  };
}

/** The line under the state word: a quiet helper, or a warning that shows the device's cause when it sends one. */
const LINE: Record<DeviceState, { text: string | null; tone?: 'warning' | 'error'; cause?: true }> = {
  unpaired: { text: null },
  stopped: { text: 'Not listening.' },
  paused: { text: 'Paused. The microphone is off.' },
  starting: { text: null },
  listening: { text: 'Recording.' },
  reconnecting: { text: 'Recording on this device. Server not reachable.', tone: 'warning' },
  degraded: { text: 'Recording with a problem.', tone: 'warning', cause: true },
  error: { text: 'The device stopped.', tone: 'error', cause: true },
};

interface StatusLines {
  /** Whom the device records for (spec E6). */
  readonly owner: string | null;
  readonly text: string | null;
  readonly tone: 'warning' | 'error' | undefined;
  /** Listening only: the local time through which the audio is saved. */
  readonly saved: string | null;
}

export function statusLines(status: KioskStatus): StatusLines {
  const line = LINE[status.state];
  const saved = status.state === 'listening' && status.saved_through ? Date.parse(status.saved_through) : Number.NaN;
  return {
    owner: status.owner && `For ${status.owner.approved_by_name} · ${status.owner.workspace_name}`,
    text: (line.cause && status.cause) || line.text,
    tone: line.tone,
    saved: Number.isNaN(saved) ? null : `Saved through ${new Date(saved).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
  };
}

/** Calls `onStatus` with each event and with `clientGone` after STALE_MS of silence; returns the cleanup. */
export function subscribeStatus(onStatus: (status: KioskStatus) => void): () => void {
  let last: KioskStatus | null = null;
  let source: EventSource | null = null;
  let stale = 0;
  let retry = 0;
  const arm = (): void => {
    clearTimeout(stale);
    stale = window.setTimeout(() => onStatus(clientGone(last)), STALE_MS);
  };
  const open = (): void => {
    source = new EventSource('/events');
    source.onmessage = event => {
      const status = parseStatus(String(event.data));
      if (status === null) return;
      last = status;
      onStatus(status);
      arm();
    };
    // The browser retries a dropped stream itself; an HTTP error closes it for good, so open it again.
    source.onerror = () => {
      if (source?.readyState !== EventSource.CLOSED) return;
      clearTimeout(retry);
      retry = window.setTimeout(open, RECONNECT_MS);
    };
  };
  open();
  arm();
  return () => {
    clearTimeout(stale);
    clearTimeout(retry);
    source?.close();
  };
}
