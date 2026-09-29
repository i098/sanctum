import { HttpApp, HttpServerResponse } from '@effect/platform';
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { secureResponses, securityHeaders } from '../src/web.ts';
import { SHELL, builtWebsite, rawRequest, serveApi } from './http-server.ts';

describe('website serving', () => {
  it.scoped('serves the shell and hashed assets with the browser security policy', () =>
    Effect.gen(function* () {
      const base = yield* serveApi({ webRoot: yield* builtWebsite });

      const shell = yield* rawRequest(base, '/');
      expect(shell).toMatchObject({ status: 200, body: SHELL });
      expect(shell.headers['content-type']).toMatch(/^text\/html/);
      expect(shell.headers['cache-control']).toBe('no-cache');
      expect(shell.headers).toMatchObject(securityHeaders);
      expect(shell.headers['permissions-policy']).toContain('microphone=(self)');
      expect(shell.headers['content-security-policy']).toContain("script-src 'self';");

      const asset = yield* rawRequest(base, '/assets/index-abc123.js');
      expect(asset).toMatchObject({ status: 200, body: 'console.log("listening")' });
      expect(asset.headers['content-type']).toMatch(/javascript/);
      expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    }),
  );

  it.scoped('keeps API routes ahead of the website and never answers them with the shell', () =>
    Effect.gen(function* () {
      const base = yield* serveApi({ webRoot: yield* builtWebsite });

      const health = yield* rawRequest(base, '/healthz');
      expect(health).toMatchObject({ status: 200, body: '{"status":"ok"}' });
      const session = yield* rawRequest(base, '/api/v1/session');
      expect(session.status).toBe(401);
      expect(session.headers).toMatchObject(securityHeaders);
      for (const path of ['/api/v1/not-a-route', '/api', '/mcp/anything', '/readyz/extra']) {
        const response = yield* rawRequest(base, path);
        expect(response.status, path).toBe(404);
        expect(response.body, path).not.toContain('<!doctype html>');
        expect(response.headers, path).toMatchObject(securityHeaders);
      }
    }),
  );

  it.scoped('serves only files inside the build, whatever the request path encodes', () =>
    Effect.gen(function* () {
      const base = yield* serveApi({ webRoot: yield* builtWebsite });
      for (const path of ['/../outside.txt', '/%2e%2e/outside.txt', '/assets/..%2f..%2foutside.txt', '/assets/missing.js', '/%E0%A4%A']) {
        const response = yield* rawRequest(base, path);
        expect(response.status, path).toBe(404);
        expect(response.body, path).not.toContain('outside the web root');
      }
    }),
  );

  it('marks every cookie Secure and defaults HttpOnly and SameSite without dropping other attributes', async () => {
    const app = HttpServerResponse.text('ok').pipe(
      HttpServerResponse.setCookie('sanctum_session', 'opaque', { path: '/' }),
      Effect.flatMap(HttpServerResponse.setCookie('sanctum_csrf', 'token', { httpOnly: false, sameSite: 'strict' })),
    );
    const response = await HttpApp.toWebHandler(app, secureResponses)(new Request('http://localhost/'));
    expect(response.headers.getSetCookie()).toEqual([
      'sanctum_session=opaque; Path=/; HttpOnly; Secure; SameSite=Lax',
      'sanctum_csrf=token; Secure; SameSite=Strict',
    ]);
    expect(response.headers.get('permissions-policy')).toBe(securityHeaders['permissions-policy']);
  });
});
