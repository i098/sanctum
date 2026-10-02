import { describe, expect, it } from 'vitest';
import { loginResponse } from '../src/login.ts';

const secrets = { LOGIN_TOKEN: 'link-token', SESSION_TOKEN: 'session-token', CSRF_TOKEN: 'csrf-token' };
const at = (path: string) => new URL(path, 'https://sanctum.example');

describe('secret login link', () => {
  it('sets the owner session and CSRF cookies and redirects home', () => {
    const response = loginResponse(at('/__login/link-token'), secrets)!;
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/');
    expect(response.headers.getSetCookie()).toEqual([
      'sanctum_session=session-token; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax',
      'sanctum_csrf=csrf-token; Path=/; Max-Age=31536000; Secure; SameSite=Strict',
    ]);
  });

  it('leaves every other request, and a deployment missing a secret, to the app', () => {
    for (const path of ['/', '/__login/wrong', '/__login/link-token/extra', '/__login/']) expect(loginResponse(at(path), secrets)).toBeUndefined();
    expect(loginResponse(at('/__login/'), { ...secrets, LOGIN_TOKEN: '' })).toBeUndefined();
    expect(loginResponse(at('/__login/undefined'), { SESSION_TOKEN: 'session-token', CSRF_TOKEN: 'csrf-token' })).toBeUndefined();
  });
});
