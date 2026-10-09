import { useEffect, useState } from 'react';
import { acquireMicrophone, deviceIssue, SILENT_PEAK, SILENT_SECONDS } from '../../lib/capture/microphone.ts';
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
      let soundAt = performance.now();
      const tick = (now: number): void => {
        analyser.getFloatTimeDomainData(samples);
        const peak = samples.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0);
        if (peak * 0x8000 > SILENT_PEAK) [heard, soundAt] = [true, now];
        const state = now - soundAt >= SILENT_SECONDS * 1000 ? 'silent' : heard ? 'sound' : 'checking';
        const level = Math.round(peak * 100) / 100;
        setInput(last => (last.level === level && last.state === state ? last : { level, state, issue: null }));
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
