import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';

interface DialogProps {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}

/**
 * Keeps Tab and Shift+Tab cycling inside the dialog. `showModal()` alone makes the page inert but
 * still lets Tab leave for the browser chrome (the listen-overlays focus test fails without this).
 */
function wrapFocus(event: KeyboardEvent<HTMLDialogElement>): void {
  if (event.key !== 'Tab') return;
  const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]')]
    .filter(element => element.tabIndex >= 0 && !element.matches(':disabled'));
  const [first, last] = [focusable[0], focusable.at(-1)];
  const [edge, wrapTo] = event.shiftKey ? [first, last] : [last, first];
  if (document.activeElement !== edge) return;
  event.preventDefault();
  wrapTo!.focus();
}

/**
 * Secondary overlay on the native modal `<dialog>`: the page behind is inert, Tab wraps inside,
 * Escape closes it, and closing returns focus to the control that opened it.
 */
export function Dialog({ title, open, onClose, children }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || dialog.open === open) return;
    if (open) dialog.showModal();
    else dialog.close();
  }, [open]);
  return (
    <dialog ref={ref} className="listen-dialog" aria-labelledby={titleId} onClose={onClose} onKeyDown={wrapFocus}>
      <header className="listen-dialog-header">
        <h2 id={titleId}>{title}</h2>
        <button type="button" onClick={onClose}>Close</button>
      </header>
      {open && children}
    </dialog>
  );
}
