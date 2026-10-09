import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker from './index.ts';

const forwarded = vi.hoisted((): Request[] => []);
vi.mock('@cloudflare/containers', () => ({
  Container: class {},
  getContainer: () => ({ fetch: async (request: Request) => (forwarded.push(request), new Response('app')) }),
}));

/** Static assets binding over a two-file landing build: 304 on a matching ETag, 404 for anything else, as the platform answers. */
const LANDING_FILES: Record<string, string> = { '/': '<!doctype html><title>Sanctum</title>', '/assets/index.js': 'start()' };
const LANDING = {
  fetch: async (request: Request) => {
    const body = LANDING_FILES[new URL(request.url).pathname];
    if (body === undefined) return new Response(null, { status: 404 });
    if (request.headers.get('if-none-match') === '"landing"') return new Response(null, { status: 304 });
    return new Response(body, { headers: { etag: '"landing"' } });
  },
};

const env = { LANDING } as never;

beforeEach(() => {
  forwarded.length = 0;
});

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

  it('serves the landing page and its assets on the apex under a same-origin, unframeable policy', async () => {
    const page = await worker.fetch(new Request('https://sanctum.42nights.dev/'), env);
    expect(page.status).toBe(200);
    expect(await page.text()).toBe(LANDING_FILES['/']);
    const policy = page.headers.get('content-security-policy');
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(page.headers.get('etag')).toBe('"landing"');

    const asset = await worker.fetch(new Request('https://sanctum.42nights.dev/assets/index.js'), env);
    expect(await asset.text()).toBe('start()');
    // A browser revalidating its cached copy stays on the landing page.
    const revalidated = await worker.fetch(new Request('https://sanctum.42nights.dev/', { headers: { 'if-none-match': '"landing"' } }), env);
    expect(revalidated.status).toBe(304);
    expect(forwarded).toEqual([]);
  });

  it('sends every other apex request, including a non-GET at the landing path, to the same path and query on the app host', async () => {
    for (const [method, path] of [
      ['GET', '/listen'],
      ['GET', '/api/v1/session?x=1'],
      ['GET', '/invite/abc?from=mail'],
      ['POST', '/mcp'],
      ['POST', '/'],
    ] as const) {
      const response = await worker.fetch(new Request(`https://sanctum.42nights.dev${path}`, { method }), env);
      expect(response.status).toBe(308);
      expect(response.headers.get('location')).toBe(`https://app.sanctum.42nights.dev${path}`);
      expect(response.headers.get('content-security-policy')).toBeNull();
    }
    expect(forwarded).toEqual([]);
  });

  it('serves an app host request from the API container', async () => {
    const response = await worker.fetch(new Request('https://app.sanctum.42nights.dev/api/v1/session?x=1'), env);
    expect(await response.text()).toBe('app');
    expect(forwarded.map(request => request.url)).toEqual(['https://app.sanctum.42nights.dev/api/v1/session?x=1']);
  });

  it('does not treat lookalike hosts as the apex', async () => {
    const urls = ['https://evil.sanctum.42nights.dev/mcp', 'https://sanctum.42nights.dev.evil.com/listen?x=1'];
    for (const url of urls) {
      const response = await worker.fetch(new Request(url), env);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('app');
    }
    expect(forwarded.map(request => request.url)).toEqual(urls);
  });
});
