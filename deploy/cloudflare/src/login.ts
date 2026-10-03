/**
 * No sign-in issuer is selected yet (docs/DECISIONS.md), so a secret link hands the browser the
 * pre-seeded owner session; every other request reaches the app untouched and without a session.
 */
export interface LoginSecrets {
  readonly LOGIN_TOKEN?: string;
  readonly SESSION_TOKEN?: string;
  readonly CSRF_TOKEN?: string;
}

const YEAR_SECONDS = 31_536_000;

/** `/__login/<LOGIN_TOKEN>` sets `sanctum_session` (HttpOnly) and `sanctum_csrf` and redirects to `/`; anything else is `undefined`. */
export const loginResponse = (url: URL, secrets: LoginSecrets): Response | undefined => {
  const { LOGIN_TOKEN, SESSION_TOKEN, CSRF_TOKEN } = secrets;
  if (!LOGIN_TOKEN || !SESSION_TOKEN || !CSRF_TOKEN || url.pathname !== `/__login/${LOGIN_TOKEN}`) return undefined;
  const headers = new Headers({ location: '/' });
  headers.append('set-cookie', `sanctum_session=${SESSION_TOKEN}; Path=/; Max-Age=${YEAR_SECONDS}; HttpOnly; Secure; SameSite=Lax`);
  headers.append('set-cookie', `sanctum_csrf=${CSRF_TOKEN}; Path=/; Max-Age=${YEAR_SECONDS}; Secure; SameSite=Strict`);
  return new Response(null, { status: 302, headers });
};
