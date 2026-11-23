/**
 * The small-screen kiosk a device shows while it listens (shared spec D10, section 2.4). The device
 * client serves this page on loopback and owns the microphone; the page only renders its `/events`.
 */
import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { LevelSource, ListenerState } from '../../lib/capture/view.ts';
import { startWaveform } from '../listen/waveform.ts';
import { type KioskStatus, statusLines, subscribeStatus } from './status-source.ts';
import './kiosk.css';

/** The waveform's slots read 33 bands; each of the device's 8 bands feeds its share of them. */
const WAVE_BANDS = 33;

const START: KioskStatus = { state: 'starting', bands: [], code: null, verification_uri: null, name: '', cause: null, saved_through: null, owner: null };

/** The approved waveform, fed from the latest event; mounted only while the state draws a line. */
function Wave({ status }: { status: KioskStatus & { state: ListenerState } }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const latest = useRef(status);
  latest.current = status;
  useEffect(() => {
    const levels: LevelSource = {
      bandCount: WAVE_BANDS,
      read(out) {
        const { bands } = latest.current;
        for (let i = 0; i < WAVE_BANDS; i++) out[i] = bands[Math.floor((i * 8) / WAVE_BANDS)] ?? 0;
        return 0;
      },
    };
    return startWaveform(canvas.current!, levels, () => latest.current.state);
  }, []);
  return <canvas ref={canvas} className="kiosk-wave" aria-hidden="true" />;
}

function Pairing({ status }: { status: KioskStatus }) {
  return (
    <section className="kiosk-pair" aria-live="polite">
      <p className="kiosk-state">unpaired</p>
      {status.name && <p>{status.name}</p>}
      <p className="kiosk-code" aria-label="Pairing code">{status.code ?? '----'}</p>
      {status.verification_uri && <p className="kiosk-uri">Enter the code at <span>{status.verification_uri}</span></p>}
    </section>
  );
}

function Status({ status }: { status: KioskStatus }) {
  const { owner, text, tone, saved } = statusLines(status);
  return (
    <>
      {owner && <p className="kiosk-owner">{owner}</p>}
      <section className="kiosk-status" aria-live="polite">
        <p className="kiosk-state">{status.state}</p>
        {text && <p className="kiosk-line" data-tone={tone}>{text}</p>}
        {saved && <p className="kiosk-line kiosk-saved">{saved}</p>}
      </section>
    </>
  );
}

function Kiosk() {
  const [status, setStatus] = useState(START);
  useEffect(() => subscribeStatus(setStatus), []);
  if (status.state === 'unpaired') return <main className="kiosk"><Pairing status={status} /></main>;
  return (
    <main className="kiosk" data-state={status.state}>
      {status.state !== 'error' && <Wave status={{ ...status, state: status.state }} />}
      <Status status={status} />
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><Kiosk /></StrictMode>);
