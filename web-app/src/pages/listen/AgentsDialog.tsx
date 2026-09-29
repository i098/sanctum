// stand-in: replaced by the interfaces slice at integration
import { Dialog } from './Dialog.tsx';

export function AgentsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog title="Agents" open={open} onClose={onClose}>
      <p className="listen-panel">Agent connections unavailable: agent management is not connected yet.</p>
    </Dialog>
  );
}
