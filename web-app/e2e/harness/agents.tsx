/** Test-only page: the Agents section against same-origin v1 routes that the spec intercepts. */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/styles.css';
import { AgentsSection } from '../../src/pages/listen/AgentsSection.tsx';
import { Dialog } from '../../src/pages/listen/Dialog.tsx';
import { sessionClient } from '../../src/lib/session.ts';

const client = sessionClient();

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <main>
      <button type="button" onClick={() => setOpen(true)}>
        Agents
      </button>
      <Dialog title="Agents" open={open} onClose={() => setOpen(false)}>
        <AgentsSection client={client} />
      </Dialog>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
