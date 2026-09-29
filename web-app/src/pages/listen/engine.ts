// stand-in: replaced by the capture slice at integration
import { createCaptureStore, type CaptureView } from '../../lib/capture/view.ts';

const unavailable = (): Promise<void> => Promise.reject(new Error('Microphone capture is not available in this build.'));

const engine: CaptureView = {
  ...createCaptureStore().view,
  levels: { bandCount: 33, read: bands => (bands.fill(0), 0) },
  start: unavailable,
  pause: unavailable,
  resume: unavailable,
};

export function getCaptureEngine(): CaptureView {
  return engine;
}
