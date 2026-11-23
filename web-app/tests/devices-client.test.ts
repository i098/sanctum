import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DeviceId } from '@sanctum/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { codeDigits, formatCode, makeDevicesClient } from '../src/lib/devices.ts';

const DEVICE = '0b7a2c55-8a8e-4f35-9d5e-3c6b2f1d0a10' as DeviceId;
const PENDING = { name: 'Kitchen Pi', capabilities: { mic: true, screen: false, light: 'mono', speaker: false }, expires_at: '2026-11-23T10:10:00.000Z' };
const envelope = (tag: string, code: string) => ({ _tag: tag, code, message: tag, retryable: false });

/** The server's answer for each user code; every request is recorded. */
const ANSWERS: Record<string, [number, unknown]> = {
  '12345678': [200, PENDING],
  '00000000': [404, envelope('NotFound', 'not_found')],
  '99999999': [403, envelope('Forbidden', 'forbidden')],
  '11111111': [401, envelope('Unauthenticated', 'unauthenticated')],
};
const requests: Array<{ method: string; url: string; headers: IncomingHttpHeaders; body: string }> = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', chunk => (body += chunk));
  req.on('end', () => {
    requests.push({ method: req.method!, url: req.url!, headers: req.headers, body });
    const url = new URL(req.url!, 'http://x');
    const [status, json] = url.pathname === '/api/v1/device/pending' ? ANSWERS[url.searchParams.get('user_code')!]! : [204, null];
    res.writeHead(status, { 'content-type': 'application/json' }).end(json === null ? undefined : JSON.stringify(json));
  });
});
let base = '';

beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  vi.unstubAllGlobals();
  server.close();
});

describe('pairing code input', () => {
  it('keeps 8 digits typed with hyphens or spaces and refuses anything else', () => {
    expect(codeDigits('1234-5678')).toBe('12345678');
    expect(codeDigits(' 1234 5678 ')).toBe('12345678');
    expect(codeDigits('1234-567')).toBeNull();
    expect(codeDigits('1234-567a')).toBeNull();
  });

  it('shows typed input as the device does', () => {
    expect(formatCode('12345678')).toBe('1234-5678');
    expect(formatCode('12a3-4567890')).toBe('1234-5678');
    expect(formatCode('123')).toBe('123');
  });
});

describe('devices client', () => {
  it('decodes a pending device and names each refusal the page shows', async () => {
    const client = makeDevicesClient(base);
    expect(await client.pending('12345678')).toEqual(PENDING);
    expect(await client.pending('00000000')).toBe('not_found');
    expect(await client.pending('99999999')).toBe('locked');
    expect(await client.pending('11111111')).toBe('signed_out');
    expect(await makeDevicesClient('http://127.0.0.1:1').list()).toBe('failed');
  });

  it('sends the CSRF cookie back as a header on a revoke', async () => {
    vi.stubGlobal('document', { cookie: 'other=1; sanctum_csrf=csrf%2Btoken' });
    expect(await makeDevicesClient(base).revoke(DEVICE)).toBeUndefined();
    expect(requests.at(-1)).toMatchObject({ method: 'DELETE', url: `/api/v1/devices/${DEVICE}`, headers: { 'x-csrf-token': 'csrf+token' } });
  });
});
