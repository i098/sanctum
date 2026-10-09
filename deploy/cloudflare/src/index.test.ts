import { describe, expect, it, vi } from 'vitest';
import worker from './index.ts';

const forwarded = vi.hoisted((): Request[] => []);
vi.mock('@cloudflare/containers', () => ({
  Container: class {},
  getContainer: () => ({ fetch: async (request: Request) => (forwarded.push(request), new Response('app')) }),
}));

describe('Worker routing', () => {
  it('sends the removed login link path to the app and sets no cookie', async () => {
    const env = { LOGIN_TOKEN: 'link-token', SESSION_TOKEN: 'session-token', CSRF_TOKEN: 'csrf-token' };
    for (const path of ['/__login/link-token', '/__login/anything']) {
      const response = await worker.fetch(new Request(`https://sanctum.example${path}`), env as never);
      expect(await response.text()).toBe('app');
      expect(response.headers.getSetCookie()).toEqual([]);
    }
    expect(forwarded.map(request => new URL(request.url).pathname)).toEqual(['/__login/link-token', '/__login/anything']);
  });

  it('sends every apex request to the same path and query on the app host', async () => {
    forwarded.length = 0;
    for (const path of ['/listen', '/api/v1/session?x=1', '/mcp']) {
      const response = await worker.fetch(new Request(`https://sanctum.42nights.dev${path}`), {} as never);
      expect(response.status).toBe(308);
      expect(response.headers.get('location')).toBe(`https://app.sanctum.42nights.dev${path}`);
    }
    expect(forwarded).toEqual([]);
  });

  it('serves an app host request from the API container', async () => {
    forwarded.length = 0;
    const response = await worker.fetch(new Request('https://app.sanctum.42nights.dev/api/v1/session?x=1'), {} as never);
    expect(await response.text()).toBe('app');
    expect(forwarded.map(request => request.url)).toEqual(['https://app.sanctum.42nights.dev/api/v1/session?x=1']);
  });

  it('does not treat lookalike hosts as the apex', async () => {
    forwarded.length = 0;
    const urls = ['https://evil.sanctum.42nights.dev/mcp', 'https://sanctum.42nights.dev.evil.com/listen?x=1'];
    for (const url of urls) {
      const response = await worker.fetch(new Request(url), {} as never);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('app');
    }
    expect(forwarded.map(request => request.url)).toEqual(urls);
  });
});
