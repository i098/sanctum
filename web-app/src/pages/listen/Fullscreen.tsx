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

const TYPING = 'input, select, textarea, [contenteditable]';

/** An unmodified F that is not typed into a field. */
const MODIFIERS = ['metaKey', 'ctrlKey', 'altKey', 'repeat'] as const;
const typingInto = ({ target }: Event): boolean => target instanceof HTMLElement && target.closest(TYPING) !== null;
const isFullscreenKey = (event: KeyboardEvent): boolean => event.key.toLowerCase() === 'f' && !MODIFIERS.some(modifier => event[modifier]) && !typingInto(event);

/** F switches fullscreen, as the Display row does. */
export function useFullscreenKey(toggle: () => void): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (isFullscreenKey(event)) toggle();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggle]);
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
