/**
 * Settings > Devices: the hardware listeners this person approved (an admin sees the workspace's),
 * with their last use, and Remove, which revokes the device's credential.
 */
import type { Device } from '@sanctum/contracts';
import { useCallback, useEffect, useState } from 'react';
import { makeDevicesClient, type Refusal } from '../../lib/devices.ts';

const devices = makeDevicesClient();
const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function DeviceRow({ device, onRemove }: { device: Device; onRemove: (device: Device) => void }) {
  return (
    <div>
      <dt>{device.name}</dt>
      <dd>
        <span className="tabular-nums">
          {device.status} · {device.last_used_at === null ? 'never used' : `last used ${when.format(new Date(device.last_used_at))}`}
        </span>
        {device.status === 'approved' && (
          <span className="listen-signin-actions"><button type="button" data-danger onClick={() => onRemove(device)}>Remove</button></span>
        )}
      </dd>
    </div>
  );
}

function DeviceList({ list, onRemove }: { list: ReadonlyArray<Device>; onRemove: (device: Device) => void }) {
  return (
    <dl className="listen-panel listen-settings">
      {list.length === 0 && (
        <div>
          <dt>None yet</dt>
          <dd>
            <span>Type the code a device shows</span>
            <span className="listen-signin-actions"><a href="/pair" data-primary>Pair a device</a></span>
          </dd>
        </div>
      )}
      {list.map(device => <DeviceRow key={device.id} device={device} onRemove={onRemove} />)}
    </dl>
  );
}

export function DevicesSection() {
  const [list, setList] = useState<ReadonlyArray<Device> | Refusal | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const refresh = useCallback(() => devices.list().then(answer => setList(typeof answer === 'string' ? answer : answer.items)), []);
  useEffect(() => void refresh(), [refresh]);

  const remove = (device: Device) => {
    if (!window.confirm(`Remove ${device.name}? It stops recording and must be paired again.`)) return;
    setFailure(null);
    void devices.revoke(device.id).then(answer => (answer === undefined ? refresh() : setFailure('The device was not removed. Try again.')));
  };

  if (list === null) return <p>Loading…</p>;
  if (typeof list === 'string') return <p role="alert" className="listen-local-gap">Devices could not be read.</p>;
  return (
    <>
      <DeviceList list={list} onRemove={remove} />
      {failure && <p role="alert" className="listen-local-gap">{failure}</p>}
    </>
  );
}
