import type { SanctumClient } from '@sanctum/sdk';
import type { ReactNode } from 'react';
import { Dialog } from './Dialog.tsx';
import { type MenuCommand, MenuSearch } from './MenuSearch.tsx';

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
  client: SanctumClient;
  /** Fixed commands the search box runs, besides opening each section. */
  commands: ReadonlyArray<MenuCommand>;
  /** A search result opens this meeting in Review. */
  onMeeting: (id: string) => void;
}

/** The one central overlay for everything beyond listening: a search box over a section rail beside the active section's body. */
export function MenuPanel({ open, onClose, sections, active, onSelect, client, commands, onMeeting }: MenuPanelProps) {
  const current = sections.find(section => section.id === active) ?? sections[0]!;
  return (
    <Dialog title="Menu" open={open} onClose={onClose} className="listen-menu">
      <MenuSearch client={client} sections={sections} commands={commands} onSection={onSelect} onMeeting={onMeeting} onClose={onClose}>
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
      </MenuSearch>
    </Dialog>
  );
}
