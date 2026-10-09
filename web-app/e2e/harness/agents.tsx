/** Test-only page: the Agents dialog against same-origin v1 routes that the spec intercepts. */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/styles.css';
import { AgentsDialog } from '../../src/pages/listen/AgentsDialog.tsx';
import { sessionClient } from '../../src/lib/session.ts';

const client = sessionClient();

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <main>
      <button type="button" onClick={() => setOpen(true)}>
        Agents
      </button>
      <AgentsDialog client={client} open={open} onClose={() => setOpen(false)} />
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
