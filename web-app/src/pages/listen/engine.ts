/**
 * The page's single capture engine. It lives above every overlay and router lifecycle, so
 * opening or closing Review, Agents or Settings never recreates the microphone stream.
 */
import { createCaptureController } from '../../lib/capture/controller.ts';
import type { CaptureView } from '../../lib/capture/view.ts';

let engine: CaptureView | null = null;

export function getCaptureEngine(): CaptureView {
  engine ??= createCaptureController();
  return engine;
}
