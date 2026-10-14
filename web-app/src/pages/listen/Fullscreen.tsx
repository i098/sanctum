import { useCallback, useEffect, useState } from 'react';

/** The page in fullscreen or not, and the one switch for it: the Display section and the F key both use it. */
export function useFullscreen(): [boolean, () => void] {
  const [fullscreen, setFullscreen] = useState(() => document.fullscreenElement !== null);
  useEffect(() => {
    const sync = (): void => setFullscreen(document.fullscreenElement !== null);
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);
  // A refused request (no user gesture, a policy) leaves the page as it was.
  const toggle = useCallback(() => {
    if (!document.fullscreenEnabled) return;
    void (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {});
  }, []);
  return [fullscreen, toggle];
}

/** True once `active` has seen no pointer, touch or key for `ms`; any of them wakes it. */
export function useIdle(active: boolean, ms: number): boolean {
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    if (!active) return;
    let timer = 0;
    const wake = (): void => {
      setIdle(false);
      clearTimeout(timer);
      timer = window.setTimeout(() => setIdle(true), ms);
    };
    const events = ['pointermove', 'pointerdown', 'keydown', 'touchstart'] as const;
    wake();
    for (const event of events) window.addEventListener(event, wake, { passive: true });
    return () => {
      clearTimeout(timer);
      for (const event of events) window.removeEventListener(event, wake);
    };
  }, [active, ms]);
  return active && idle;
}

/** Display section: Fullscreen, where the F key does the same. Entering it closes the panel, so the waveform shows. */
export function DisplaySection({ fullscreen, onToggle, onDone }: { fullscreen: boolean; onToggle: () => void; onDone: () => void }) {
  return (
    <dl className="listen-panel listen-settings">
      <div>
        <dt>Fullscreen</dt>
        <dd>
          {document.fullscreenEnabled
            ? (
              <>
                <span>Press F on the listening screen, or:</span>
                <button type="button" aria-pressed={fullscreen} onClick={() => { onToggle(); if (!fullscreen) onDone(); }}>
                  {fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
                </button>
              </>
            )
            : 'This browser does not allow fullscreen.'}
        </dd>
      </div>
    </dl>
  );
}
