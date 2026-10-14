import type { Meeting, SanctumClient } from '@sanctum/sdk';
import { useEffect, useState, type KeyboardEvent } from 'react';
import { loadReview, type ReviewState } from './review-data.ts';
import { ReviewPanel, type Seek, show, TABS } from './ReviewPanels.tsx';

/**
 * The Review of one chosen meeting: six tabs, each truthful about its own
 * source. A note or item's source time opens its transcript segment; the segment's Play opens
 * authorized playback at that point. Opening or closing it never touches capture.
 */
export function ReviewSection({ client, meeting }: { client: SanctumClient; meeting: Meeting }) {
  const [selected, setSelected] = useState(0);
  const [review, setReview] = useState<ReviewState | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [seek, setSeek] = useState<Seek | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void loadReview(client, meeting, controller.signal, state => controller.signal.aborted || setReview(state));
    return () => controller.abort();
  }, [client, meeting]);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const move = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (move === undefined) return;
    const next = (selected + move + TABS.length) % TABS.length;
    setSelected(next);
    event.currentTarget.querySelectorAll('button')[next]?.focus();
  };
  const navigation = {
    focus,
    seek,
    onSource: (segment_id: string) => {
      setFocus(segment_id);
      setSelected(TABS.indexOf('Transcript'));
    },
    onPlay: (seconds: number) => {
      setSeek({ seconds });
      setSelected(TABS.indexOf('Recording'));
    },
    onSeeked: () => setSeek(null),
  };
  const tab = TABS[selected]!;
  return (
    <>
      <p className="listen-source">
        {meeting.title ?? 'Untitled meeting'} · {meeting.state} · started {new Date(meeting.started_at).toLocaleString([], { timeZone: meeting.timezone })}
      </p>
      <div role="tablist" aria-label="Review sections" className="listen-tabs" onKeyDown={onKeyDown}>
        {TABS.map((name, index) => (
          <button
            key={name}
            type="button"
            role="tab"
            id={`review-tab-${index}`}
            aria-selected={index === selected}
            aria-controls="review-panel"
            tabIndex={index === selected ? 0 : -1}
            onClick={() => setSelected(index)}
          >
            {name}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="review-panel" aria-labelledby={`review-tab-${selected}`} className="listen-panel">
        {show(tab, review ?? { status: 'loading' }, data => <ReviewPanel tab={tab} review={data} navigation={navigation} />)}
      </div>
    </>
  );
}
