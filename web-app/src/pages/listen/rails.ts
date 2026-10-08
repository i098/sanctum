/**
 * Side live updates: the earlier Sanctum kiosk's transcript log (left rail) and agent-work feed
 * (right rail) from 42nights/sanctum web-app/src/pages/kiosk, ported one-to-one on explicit
 * request. Rows are plain DOM, like the waveform; motion uses the Web Animations API with the
 * kiosk's GSAP durations and eases, and is skipped under reduced motion.
 */
import type { ActionState, ActionUpdateMessage, TranscriptSegment } from '@sanctum/contracts';

type SubscribeTranscript = (listener: (segment: TranscriptSegment) => void) => () => void;
type SubscribeActions = (listener: (message: ActionUpdateMessage) => void) => () => void;
type FeedAction = ActionUpdateMessage['actions'][number];

/** GSAP eases as CSS cubic-béziers: power1.out (GSAP's default), power2.out, power3.out. */
const POWER1_OUT = 'cubic-bezier(0.25, 0.46, 0.45, 0.94)';
const POWER2_OUT = 'cubic-bezier(0.215, 0.61, 0.355, 1)';
const POWER3_OUT = 'cubic-bezier(0.165, 0.84, 0.44, 1)';

const TRANSCRIPT_MAX = 10;
/** The newest lines keep the brighter tier; older ones step down to the muted colour, never dimmer. */
const TRANSCRIPT_FRESH = 3;
/** Same as contracts' `ACTION_FEED_ROWS`, which caps each `action_update`. */
const FEED_MAX = 5;

function animate(element: Element, keyframes: Keyframe[], duration: number, easing: string, fill: FillMode = 'backwards'): Animation {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  return element.animate(keyframes, { duration: reduced ? 0 : duration, easing, fill });
}

/** Fades `element` out while its height and top margin shrink to 0, then removes it. */
function collapse(element: HTMLElement, duration: number): void {
  const { opacity, height, marginTop } = getComputedStyle(element);
  const remove = (): void => element.remove();
  animate(element, [{ opacity, height, marginTop }, { opacity: 0, height: '0px', marginTop: '0px' }], duration, POWER1_OUT, 'forwards').finished.then(remove, remove);
}

/** Items of a bottom-anchored `container` whose top is cut off by its upper edge. */
function cutOff(container: HTMLElement, items: ReadonlyArray<HTMLElement>): ReadonlyArray<HTMLElement> {
  const edge = container.getBoundingClientRect().top;
  return items.filter(item => item.getBoundingClientRect().top < edge);
}

/** One rail line, sliding up into place. Live ASR labels speakers 0, 1, …; the kiosk showed them as S0, S1. */
function appendLine(lines: HTMLElement, segment: TranscriptSegment): void {
  const line = document.createElement('div');
  line.className = 'tline';
  line.textContent = segment.speaker_label === null ? segment.text.trim() : `S${segment.speaker_label}: ${segment.text.trim()}`;
  lines.append(line);
  animate(line, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], 200, POWER2_OUT);
}

/** Past ten lines, or once the band is full, the oldest collapse away so no line ever shows half. */
function trimLines(lines: HTMLElement): void {
  const current = [...lines.querySelectorAll<HTMLElement>('.tline:not(.bye)')];
  const drop = Math.max(current.length - TRANSCRIPT_MAX, cutOff(lines, current).length);
  for (const old of current.splice(0, drop)) {
    old.classList.add('bye');
    collapse(old, 300);
  }
  current.forEach((element, index) => element.classList.toggle('old', index < current.length - TRANSCRIPT_FRESH));
}

/**
 * Appends every final live transcript line to `lines`, newest at the bottom. A band that narrows
 * (on phones the feed shares it) trims at once instead of cutting a line. Returns the cleanup.
 */
export function startTranscriptRail(lines: HTMLElement, subscribeTranscript: SubscribeTranscript): () => void {
  const resized = new ResizeObserver(() => trimLines(lines));
  resized.observe(lines);
  const unsubscribe = subscribeTranscript(segment => {
    if (segment.status !== 'final' || segment.text.trim() === '') return;
    appendLine(lines, segment);
    trimLines(lines);
  });
  return () => {
    resized.disconnect();
    unsubscribe();
  };
}

/** Row tone (the kiosk's status classes) and status label per action state. */
const STATUS: Record<ActionState, readonly [tone: string, label: string]> = {
  proposed: ['proposed', '○ proposed'],
  awaiting_authorization: ['proposed', '○ awaiting permission'],
  queued: ['proposed', '○ queued'],
  running: ['in_flight', '● executing…'],
  succeeded: ['done', 'done ✓'],
  failed: ['failed', 'failed'],
  unknown: ['unknown', '? outcome unknown'],
  cancelled: ['cancelled', 'cancelled'],
};

const SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">';
const CALENDAR = `${SVG}<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`;
const EMAIL = `${SVG}<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/></svg>`;
/** The kiosk's fallback icon for any other action. */
const RESEARCH = `${SVG}<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>`;

function fillRow(row: HTMLElement, action: FeedAction): void {
  const [tone, label] = STATUS[action.state];
  const icon = action.action_key.includes('calendar') ? CALENDAR : action.action_key.includes('mail') ? EMAIL : RESEARCH;
  row.className = `frow ${tone}`;
  row.dataset['state'] = action.state;
  row.innerHTML = `<span class="fedge"></span><span class="fic">${icon}</span><span class="ftitle"></span><span class="fstat ${tone}"></span>`;
  row.querySelector('.ftitle')!.textContent = action.title;
  row.title = action.title;
  row.querySelector('.fstat')!.textContent = label;
}

/**
 * Keeps the five latest actions of the listener's open meeting as feed rows, from the live
 * socket's `action_update` messages: new rows slide in from the right, the oldest beyond five
 * collapses away, rows past the newest two rest at 40%, and a row turning done flashes its edge.
 * Rows the band cannot fit whole stay hidden. A dropped socket keeps the rows already shown until
 * the reconnect's snapshot brings them up to date.
 */
export function startActionFeed(feed: HTMLElement, subscribeActions: SubscribeActions): () => void {
  const rows = new Map<string, HTMLElement>();
  let owner: string | null | undefined;

  const add = (action: FeedAction): void => {
    const row = document.createElement('div');
    fillRow(row, action);
    feed.append(row);
    rows.set(action.action_id, row);
    animate(row, [{ opacity: 0, transform: 'translateX(24px)' }, { opacity: 1, transform: 'none' }], 500, POWER3_OUT);
    while (rows.size > FEED_MAX) {
      const [id, old] = rows.entries().next().value!;
      rows.delete(id);
      collapse(old, 400);
    }
  };
  const update = (row: HTMLElement, action: FeedAction): void => {
    const wasDone = row.classList.contains('done');
    fillRow(row, action);
    if (action.state === 'succeeded' && !wasDone) animate(row.querySelector('.fedge')!, [{ transform: 'scaleY(0.15)' }, { transform: 'scaleY(1)' }], 500, POWER2_OUT);
  };
  const upsert = (action: FeedAction): void => {
    const row = rows.get(action.action_id);
    if (row === undefined) add(action);
    else if (row.dataset['state'] !== action.state) update(row, action);
  };
  const hideCut = (): void => cutOff(feed, [...rows.values()]).forEach(row => (row.hidden = true));
  /** Rows past the newest two rest at 40%; rows the band cannot fit whole are hidden. */
  const settle = (): void => {
    const shown = [...rows.values()];
    shown.forEach((row, index) => {
      row.hidden = false;
      row.style.opacity = index < shown.length - 2 ? '0.4' : '';
    });
    hideCut();
  };
  const resized = new ResizeObserver(hideCut);
  resized.observe(feed);

  /** Rows belong to one meeting: an update for any other meeting, or for none, clears them. */
  const claim = (meetingId: string | null): void => {
    if (meetingId === owner) return;
    rows.forEach(row => collapse(row, 400));
    rows.clear();
    owner = meetingId;
  };
  const unsubscribe = subscribeActions(({ meeting_id, actions }) => {
    claim(meeting_id);
    actions.forEach(upsert);
    settle();
  });
  return () => {
    unsubscribe();
    resized.disconnect();
  };
}
