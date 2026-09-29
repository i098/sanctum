/**
 * Real-browser capture harness: Chromium's fake microphone feeds the real AudioWorklet, IndexedDB
 * buffer, uploader and live socket, while `page.route`/`routeWebSocket` stand in for the media
 * slice's listener API.
 */
import { createHash } from 'node:crypto';
import { test, type Page } from '@playwright/test';
import type * as Buffer from '../src/lib/capture/buffer.ts';
import type * as Controller from '../src/lib/capture/controller.ts';
import type { CaptureSnapshot, CaptureView } from '../src/lib/capture/view.ts';

type ControllerModule = typeof Controller;
type BufferModule = typeof Buffer;
type Manifest = { chunk_id: string; epoch_id: string; sample_start: number; sample_count: number; sample_rate: number; byte_length: number; sha256: string };
declare global {
  interface Window {
    capture: CaptureView;
  }
}

export const LISTENER = '7d3b1f0e-2a4c-4e8b-9f1d-5c6a7b8c9d01';
/** The session opener's script-readable CSRF cookie; the server rejects cookie mutations without it as `x-csrf-token`. */
const CSRF = 'csrf-e2e-token';

interface FakeServer {
  uploads: Array<{ manifest: Manifest; body: globalThis.Buffer }>;
  starts: Array<Record<string, unknown>>;
  frames: number;
  failUploads: boolean;
}

export async function fakeServer(page: Page, failUploads = false): Promise<FakeServer> {
  const server: FakeServer = { uploads: [], starts: [], frames: 0, failUploads };
  await page.context().addCookies([{ name: 'sanctum_csrf', value: CSRF, url: test.info().project.use.baseURL!, sameSite: 'Strict' }]);
  await page.route(/\/api\/v1\/listeners(\/|$)/, (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'GET' && request.headers()['x-csrf-token'] !== CSRF) {
      return route.fulfill({ status: 403, json: { _tag: 'Forbidden', code: 'forbidden', retryable: false, message: 'CSRF token is missing or invalid' } });
    }
    if (path === '/api/v1/listeners') {
      const listener = { id: LISTENER, workspace_id: LISTENER, name: 'Browser listener', mode: 'laptop', state: 'stopped', lease_generation: 1 };
      return route.fulfill({ status: 201, json: { ...listener, lease_expires_at: null, current_epoch_id: null, last_heartbeat_at: null } });
    }
    if (path.endsWith('/heartbeat')) return route.fulfill({ json: { lease_generation: 1, lease_expires_at: '2026-09-29T09:00:45Z', owner: true } });
    if (server.failUploads) return route.fulfill({ status: 503, json: { _tag: 'Unavailable', code: 'unavailable', retryable: true, message: 'offline' } });
    const manifest = JSON.parse(request.headers()['x-sanctum-manifest']!) as Manifest;
    const body = request.postDataBuffer()!;
    server.uploads.push({ manifest, body });
    const sha256 = createHash('sha256').update(body).digest('hex');
    return route.fulfill({ json: { chunk_id: manifest.chunk_id, object_key: `audio/${manifest.chunk_id}.wav`, sha256, byte_length: body.length, committed_at: '2026-09-29T09:00:00Z' } });
  });
  await page.routeWebSocket(/\/api\/v1\/listeners\/[^/]+\/stream$/, (ws) => {
    ws.onMessage((message) => {
      if (typeof message !== 'string') return void server.frames++;
      const start = JSON.parse(message) as Record<string, unknown>;
      server.starts.push(start);
      if (start['_tag'] === 'start') ws.send(JSON.stringify({ _tag: 'accepted', epoch_id: start['epoch_id'], resume_from_sample: 0, max_frame_bytes: 19_224 }));
    });
  });
  return server;
}

/** Inert page engine, so the test's own controller is the only one holding the tab's capture lock. */
const INERT_ENGINE = `
import { createCaptureStore } from '/src/lib/capture/view.ts';
const idle = async () => {};
const engine = { ...createCaptureStore().view, levels: { bandCount: 33, read: bands => (bands.fill(0), 0) }, start: idle, pause: idle, resume: idle };
export const getCaptureEngine = () => engine;
`;

/** Creates a controller with short chunks in the page; `capBytes` shrinks the recovery buffer. */
export async function capture(page: Page, options: { start: boolean; chunkSeconds: number; capBytes?: number }): Promise<void> {
  if (page.url() === 'about:blank') {
    await page.route('**/src/pages/listen/engine.ts*', route => route.fulfill({ contentType: 'text/javascript', body: INERT_ENGINE }));
    await page.goto('/');
    // The Vite dev server reloads the page once when it first optimizes the capture dependencies.
    await page.evaluate(() => import('/src/lib/capture/controller.ts' as string)).catch(() => page.waitForLoadState('load'));
  }
  await page.evaluate(async ({ start, chunkSeconds, capBytes }) => {
    const { createCaptureController } = (await import('/src/lib/capture/controller.ts' as string)) as ControllerModule;
    const { RecoveryBuffer } = (await import('/src/lib/capture/buffer.ts' as string)) as BufferModule;
    const timing = { chunkSeconds, commitSeconds: 0.5 };
    window.capture = createCaptureController(capBytes === 0 ? { timing } : { timing, openBuffer: () => RecoveryBuffer.open({ capBytes }) });
    if (start) await window.capture.start();
  }, { start: options.start, chunkSeconds: options.chunkSeconds, capBytes: options.capBytes ?? 0 });
}

export const snapshot = (page: Page): Promise<CaptureSnapshot> => page.evaluate(() => window.capture.getSnapshot());
