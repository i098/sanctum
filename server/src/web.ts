/**
 * Built website assets behind the API routes (plan section 04, "One application image") and
 * the browser security policy every response carries: microphone limited to this origin,
 * a CSP that allows only same-origin scripts/connections, and Secure session cookies.
 * HTTPS and HSTS are terminated by the reverse proxy (Caddyfile).
 */
import { readdirSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { Cookies, HttpApiBuilder, HttpApp, HttpMiddleware, HttpServerError, HttpServerRequest, HttpServerResponse } from '@effect/platform';
import { Effect } from 'effect';

export const securityHeaders = {
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    // Signed recording URLs point at private R2 objects.
    "media-src 'self' blob: https://*.r2.cloudflarestorage.com",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
  'permissions-policy': 'microphone=(self), screen-wake-lock=(self), camera=(), geolocation=(), display-capture=()',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'cross-origin-opener-policy': 'same-origin',
} as const;

/**
 * Adds `securityHeaders` to every response, including API errors and 404s, and forces `Secure`
 * (and HttpOnly/SameSite defaults) on every cookie; only an explicit `httpOnly: false`, such as a
 * double-submit CSRF cookie, stays readable by scripts. Serve middleware runs after the response is
 * written, so this installs a pre-response handler instead of mapping the response.
 */
export const secureResponses = HttpMiddleware.make(
  HttpApp.withPreResponseHandler((_request, response) =>
    Effect.succeed(
      HttpServerResponse.setHeaders(response, securityHeaders).pipe(
        HttpServerResponse.updateCookies(cookies =>
          Cookies.fromIterable(
            Object.values(cookies.cookies).map(cookie =>
              Cookies.unsafeMakeCookie(cookie.name, cookie.value, {
                ...cookie.options,
                secure: true,
                httpOnly: cookie.options?.httpOnly ?? true,
                sameSite: cookie.options?.sameSite ?? 'lax',
              }),
            ),
          ),
        ),
      ),
    ),
  ),
);

/** Paths the website never answers, so API clients get a real 404 instead of the app shell. */
const SERVER_PATHS = /^\/(?:api|mcp|healthz|readyz)(?:\/|$)/;

const IMMUTABLE = 'public, max-age=31536000, immutable';

/**
 * Serves only files present in `root` at startup (no path is ever resolved from the request),
 * hashed `assets/` with immutable caching, and `index.html` for extensionless deep links such
 * as `/meetings/<id>`.
 */
export const webAssetsLive = (root: string) => {
  const files = new Set(
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => relative(root, join(entry.parentPath, entry.name)).split(sep).join('/')),
  );
  return HttpApiBuilder.Router.use(router =>
    router.get(
      '*',
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const path = yield* Effect.try(() => decodeURIComponent(new URL(request.url, 'http://local').pathname)).pipe(Effect.option);
        if (path._tag === 'None' || SERVER_PATHS.test(path.value)) return yield* new HttpServerError.RouteNotFound({ request });
        const requested = path.value.slice(1);
        const file = files.has(requested) ? requested : extname(requested) === '' && files.has('index.html') ? 'index.html' : null;
        if (file === null) return yield* new HttpServerError.RouteNotFound({ request });
        return yield* HttpServerResponse.file(join(root, file), { headers: { 'cache-control': file.startsWith('assets/') ? IMMUTABLE : 'no-cache' } });
      }),
    ),
  );
};
