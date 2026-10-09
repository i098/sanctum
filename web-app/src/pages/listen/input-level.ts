import { useEffect, useState } from 'react';
import { acquireMicrophone, deadRun, deviceIssue, SILENT_SECONDS } from '../../lib/capture/microphone.ts';
import type { CaptureIssue } from '../../lib/capture/view.ts';

export interface InputLevel {
  /** Peak level, 0..1, in steps of 0.01. */
  readonly level: number;
  /** `checking` until the input sends sound or stays dead for `SILENT_SECONDS`. */
  readonly state: 'checking' | 'sound' | 'silent';
  /** Why the input could not open, else null. */
  readonly issue: CaptureIssue | null;
}

const CHECKING: InputLevel = { level: 0, state: 'checking', issue: null };
/** The level is shown at this pace; a change of state shows at once. */
const LEVEL_MS = 100;

/** Verdict for one frame: sound once heard, silent after a long enough dead run, else still checking. */
function inputState(heard: boolean, dead: number): InputLevel['state'] {
  if (dead >= SILENT_SECONDS * 1000) return 'silent';
  return heard ? 'sound' : 'checking';
}

/** A new level shows only when `full`; a change of state shows at once. */
function nextInput(prev: InputLevel, peak: number, state: InputLevel['state'], full: boolean): InputLevel {
  const level = full ? Math.round((peak / 0x8000) * 100) / 100 : prev.level;
  return prev.level === level && prev.state === state ? prev : { level, state, issue: null };
}

/**
 * Live level of one input (`deviceId` null: the default one) and whether it sends exact digital zero, with the
 * capture engine's floor and threshold. It opens its own stream, so use it only while capture is not running.
 */
export function useInputLevel(deviceId: string | null): InputLevel {
  const [input, setInput] = useState(CHECKING);
  useEffect(() => {
    let closed = false;
    let frame = 0;
    let stop = (): void => {};
    setInput(CHECKING);
    acquireMicrophone(navigator.mediaDevices, deviceId).then((stream) => {
      const context = new AudioContext();
      void context.resume();
      stop = () => {
        cancelAnimationFrame(frame);
        stream.getTracks().forEach(track => track.stop());
        void context.close();
      };
      if (closed) return stop();
      const analyser = new AnalyserNode(context, { fftSize: 2048 });
      context.createMediaStreamSource(stream).connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      let heard = false;
      let dead = 0;
      let last = performance.now();
      let shown = -LEVEL_MS;
      const tick = (now: number): void => {
        if (context.state !== 'running') {
          last = now;
          frame = requestAnimationFrame(tick);
          return;
        }
        analyser.getFloatTimeDomainData(samples);
        const peak = samples.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0) * 0x8000;
        dead = deadRun(dead, peak, now - last);
        last = now;
        heard ||= dead === 0;
        const full = now - shown >= LEVEL_MS;
        if (full) shown = now;
        const state = inputState(heard, dead);
        setInput(prev => nextInput(prev, peak, state, full));
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    }, (error: unknown) => !closed && setInput({ ...CHECKING, issue: deviceIssue(error) }));
    return () => {
      closed = true;
      stop();
    };
  }, [deviceId]);
  return input;
}
