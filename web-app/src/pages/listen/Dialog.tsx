// stand-in: replaced by the listen-ui slice at integration
/** Modal dialog on the native `<dialog>`: focus is contained, Escape closes, focus returns to the opener. */
import { type ReactNode, useEffect, useId, useRef } from 'react';

export function Dialog({ title, open, onClose, children }: { title: string; open: boolean; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (open && !dialog?.open) dialog?.showModal();
    if (!open && dialog?.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={event => (event.preventDefault(), onClose())}
      className="m-auto w-[min(40rem,92vw)] rounded-lg bg-overlay p-6 text-ink backdrop:bg-black/60"
    >
      <h2 id={titleId} className="mb-4 text-lg font-medium">
        {title}
      </h2>
      {open && children}
    </dialog>
  );
}
