import type { CaptureView, PermissionState } from '../../lib/capture/view.ts';
import { Dialog } from './Dialog.tsx';
import { LocalRecordings } from './LocalRecordings.tsx';

const MICROPHONE: Record<PermissionState, string> = {
  unknown: 'Not requested yet',
  prompt: 'The browser will ask when listening starts',
  pending: 'Waiting for your permission',
  granted: 'Allowed',
  denied: 'Blocked in browser settings',
  unsupported: 'Not supported by this browser',
};

interface SettingsProps {
  open: boolean;
  onClose: () => void;
  permission: PermissionState;
  engine: CaptureView;
}

/** Settings overlay: real device facts, and the unselected policies stated as unselected. */
export function SettingsDialog({ open, onClose, permission, engine }: SettingsProps) {
  const rows: ReadonlyArray<readonly [string, string]> = [
    ['Sign-in', 'Not configured: no sign-in provider has been selected'],
    ['Workspace', 'Unavailable until sign-in is configured'],
    ['Timezone', Intl.DateTimeFormat().resolvedOptions().timeZone],
    ['Microphone', MICROPHONE[permission]],
    ['Integrations', 'Unavailable: integrations are not connected yet'],
    ['Retention', 'Not selected: nothing is deleted automatically'],
  ];
  return (
    <Dialog title="Settings" open={open} onClose={onClose}>
      <dl className="listen-panel listen-settings">
        {rows.map(([term, value]) => (
          <div key={term}>
            <dt>{term}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <LocalRecordings engine={engine} />
    </Dialog>
  );
}
