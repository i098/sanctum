import type { ReactNode } from 'react';
import { Dialog } from './Dialog.tsx';

interface MenuSection {
  id: string;
  label: string;
  /** Mounted only while the section is shown, so it loads on open and forgets its state on leaving. */
  body: ReactNode;
}

interface MenuPanelProps {
  open: boolean;
  onClose: () => void;
  /** The rail, in order: a new section is one more entry here. */
  sections: ReadonlyArray<MenuSection>;
  active: string;
  onSelect: (id: string) => void;
  /** What listening is doing behind the panel; the phone sheet covers the whole page, so it says so at the foot. */
  status: { text: string; tone: string };
}

/** The one central overlay for everything beyond listening: a section rail beside the active section's body. */
export function MenuPanel({ open, onClose, sections, active, onSelect, status }: MenuPanelProps) {
  const current = sections.find(section => section.id === active) ?? sections[0]!;
  return (
    <Dialog title="Menu" open={open} onClose={onClose} className="listen-menu">
      <nav aria-label="Menu sections" className="listen-menu-rail">
        {sections.map(({ id, label }) => (
          <button key={id} type="button" aria-current={id === current.id ? 'page' : undefined} onClick={() => onSelect(id)}>
            {label}
          </button>
        ))}
      </nav>
      <section aria-label={current.label} className="listen-menu-body">
        {current.body}
      </section>
      <p className="listen-menu-status" data-tone={status.tone}>{status.text} · tap close to return</p>
    </Dialog>
  );
}
