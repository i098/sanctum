import { useState, type KeyboardEvent } from 'react';
import { Dialog } from './Dialog.tsx';

const TABS = ['Notes', 'Transcript', 'Recording', 'Memory', 'Context', 'Activity'] as const;

/** Review overlay frame: six tabs with truthful unavailable states until meeting data is connected. */
export function ReviewDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [selected, setSelected] = useState(0);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const move = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (move === undefined) return;
    const next = (selected + move + TABS.length) % TABS.length;
    setSelected(next);
    event.currentTarget.querySelectorAll('button')[next]?.focus();
  };
  return (
    <Dialog title="Review" open={open} onClose={onClose}>
      <div role="tablist" aria-label="Review sections" className="listen-tabs" onKeyDown={onKeyDown}>
        {TABS.map((tab, index) => (
          <button
            key={tab}
            type="button"
            role="tab"
            id={`review-tab-${index}`}
            aria-selected={index === selected}
            aria-controls="review-panel"
            tabIndex={index === selected ? 0 : -1}
            onClick={() => setSelected(index)}
          >
            {tab}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="review-panel" aria-labelledby={`review-tab-${selected}`} className="listen-panel">
        <p>{TABS[selected]} unavailable: this listener is not connected to meeting data yet.</p>
      </div>
    </Dialog>
  );
}
