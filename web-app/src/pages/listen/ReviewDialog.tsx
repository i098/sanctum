import type { SanctumClient } from '@sanctum/sdk';
import { useEffect, useState, type KeyboardEvent } from 'react';
import { Dialog } from './Dialog.tsx';
import { loadReview, type ReviewState } from './review-data.ts';
import { ReviewPanel, type Seek, show, TABS } from './ReviewPanels.tsx';

/**
 * Review overlay over the most recent readable meeting: six tabs, each truthful about its own
 * source. A note or item's source time opens its transcript segment; the segment's Play opens
 * authorized playback at that point. Opening or closing it never touches capture.
 */
export function ReviewDialog({ client, open, onClose }: { client: SanctumClient; open: boolean; onClose: () => void }) {
  const [selected, setSelected] = useState(0);
  const [review, setReview] = useState<ReviewState>({ status: 'loading' });
  const [focus, setFocus] = useState<string | null>(null);
  const [seek, setSeek] = useState<Seek | null>(null);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setReview({ status: 'loading' });
    setFocus(null);
    setSeek(null);
    void loadReview(client, controller.signal, state => controller.signal.aborted || setReview(state));
    return () => controller.abort();
  }, [client, open]);
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
  };
  const tab = TABS[selected]!;
  return (
    <Dialog title="Review" open={open} onClose={onClose}>
      {review.status === 'ok' && (
        <p className="listen-source">
          {review.data.meeting.title ?? 'Untitled meeting'} · {review.data.meeting.state} · started {new Date(review.data.meeting.started_at).toLocaleString([], { timeZone: review.data.meeting.timezone })}
        </p>
      )}
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
        {review.status === 'empty' ? <p>No meetings yet.</p> : show(tab, review, data => <ReviewPanel tab={tab} review={data} navigation={navigation} />)}
      </div>
    </Dialog>
  );
}
