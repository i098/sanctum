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
});
