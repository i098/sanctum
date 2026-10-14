import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { CaptureView, ListenerState, PermissionState } from '../../lib/capture/view.ts';
import { type InputLevel, useInputLevel } from './input-level.ts';

/** Chrome names its default-input entry and that input's track "Default - <device label>". */
export const deviceName = (label: string): string => label.replace(/^Default - /, '');

/** The input check opens its own stream, so it runs only while capture holds none. */
const IDLE: ReadonlyArray<ListenerState> = ['stopped', 'paused'];

const CHECK: Record<InputLevel['state'], string> = {
  checking: 'Checking this input…',
  sound: 'This input is sending sound.',
  silent: 'This input is sending no sound.',
};
const BUILT_IN = /built-in|macbook/i;

function Hint({ input }: { input: InputLevel }) {
  const closed = input.state === 'silent' && !input.issue && BUILT_IN.test(input.label);
  return closed ? <span className="listen-input-hint">If your laptop is closed, choose another microphone.</span> : null;
}

/** Whether the input hears anything, from one `useInputLevel` reading; the welcome draws its level from the same reading. */
export function InputCheckText({ input }: { input: InputLevel }) {
  return (
    <>
      <span className="listen-input-check" data-state={input.issue ? 'silent' : input.state}>
        {input.issue ? 'This input cannot be opened.' : CHECK[input.state]}
      </span>
      <Hint input={input} />
    </>
  );
}

/** Before listening, says whether the chosen input hears anything, so a dead one is found before a meeting. */
function Probe({ deviceId }: { deviceId: string | null }) {
  return <InputCheckText input={useInputLevel(deviceId)} />;
}

function InputCheck({ deviceId, listener }: { deviceId: string | null; listener: ListenerState }) {
  return IDLE.includes(listener) ? <Probe deviceId={deviceId} /> : null;
}

/** Chrome lists the default input as its own `default` entry; other browsers do not, so the option names no device there. */
function defaultLabel(inputs: readonly MediaDeviceInfo[]): string {
  const system = inputs.find(device => device.deviceId === 'default');
  return system ? `System default (${deviceName(system.label)})` : 'System default';
}

/** Audio inputs with labels, which browsers give once permission is granted or capture opens an input; read again as devices come and go. */
function useLabelledInputs(permission: PermissionState, inputLabel: string | null): [MediaDeviceInfo[], () => void] {
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
  const read = useCallback((): void => {
    const media = navigator.mediaDevices;
    if (media?.enumerateDevices === undefined) return;
    void media.enumerateDevices().then(all => setInputs(all.filter(device => device.kind === 'audioinput' && device.label !== '')), () => {});
  }, []);
  useEffect(() => {
    read();
    const media = navigator.mediaDevices;
    media?.addEventListener('devicechange', read);
    return () => media?.removeEventListener('devicechange', read);
  }, [permission, inputLabel, read]);
  return [inputs, read];
}

/**
 * The microphone choice: inputs by their own labels, so nothing shows before microphone permission.
 * The empty value is the browser's default input. With `check`, while capture is not running, it also checks the chosen input for sound.
 */
export function InputPicker({ engine, check = false }: { engine: CaptureView; check?: boolean }) {
  const { inputId, inputLabel, permission, listener } = useSyncExternalStore(engine.subscribe, engine.getSnapshot);
  const [inputs, refresh] = useLabelledInputs(permission, inputLabel);
  if (inputs.length === 0) return null;
  return (
    <span className="listen-input-picker">
      <span className="listen-input-row">
        <select className="listen-input" aria-label="Microphone" value={inputId ?? ''} onChange={event => void engine.chooseInput(event.target.value || null)}>
          <option value="">{defaultLabel(inputs)}</option>
          {inputs.filter(device => device.deviceId !== 'default').map(device => <option key={device.deviceId} value={device.deviceId}>{device.label}</option>)}
        </select>
        <button type="button" className="listen-input-refresh" onClick={refresh}>Refresh</button>
      </span>
      {check && <InputCheck deviceId={inputId} listener={listener} />}
    </span>
  );
}
