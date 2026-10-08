import { describe, expect, it } from 'vitest';
import { containerEnv } from '../src/settings.ts';

describe('container environment', () => {
  it('forwards a provider key the Worker has, and omits one it lacks', () => {
    expect(containerEnv({ DEEPGRAM_API_KEY: 'deepgram-key', MYSQL_HOST: 'db' })).toEqual({ DEEPGRAM_API_KEY: 'deepgram-key', MYSQL_HOST: 'db' });
    expect(containerEnv({ MYSQL_HOST: 'db' })).not.toHaveProperty('DEEPGRAM_API_KEY');
  });

  it('forwards the hosted seat limit to the container', () => {
    expect(containerEnv({ SANCTUM_DEFAULT_SEAT_LIMIT: '5' })).toEqual({ SANCTUM_DEFAULT_SEAT_LIMIT: '5' });
  });

  it('keeps the login tokens in the Worker', () => {
    const worker = { LOGIN_TOKEN: 'link', SESSION_TOKEN: 'session', CSRF_TOKEN: 'csrf', MYSQL_HOST: 'db' };
    expect(containerEnv(worker)).toEqual({ MYSQL_HOST: 'db' });
  });
});
