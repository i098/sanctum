import { describe, expect, it } from 'vitest';
import { containerEnv, retireStaleContainer } from '../src/settings.ts';

describe('container environment', () => {
  it('forwards a provider key the Worker has, and omits one it lacks', () => {
    expect(containerEnv({ WORKERS_AI_API_TOKEN: 'workers-ai-token', MYSQL_HOST: 'db' })).toEqual({ WORKERS_AI_API_TOKEN: 'workers-ai-token', MYSQL_HOST: 'db' });
    expect(containerEnv({ MYSQL_HOST: 'db' })).not.toHaveProperty('WORKERS_AI_API_TOKEN');
  });

  it('forwards the hosted seat limit to the container', () => {
    expect(containerEnv({ SANCTUM_DEFAULT_SEAT_LIMIT: '5' })).toEqual({ SANCTUM_DEFAULT_SEAT_LIMIT: '5' });
  });

  it('keeps the login tokens in the Worker', () => {
    const worker = { LOGIN_TOKEN: 'link', SESSION_TOKEN: 'session', CSRF_TOKEN: 'csrf', MYSQL_HOST: 'db' };
    expect(containerEnv(worker)).toEqual({ MYSQL_HOST: 'db' });
  });

  it('forwards the sign-in settings the Worker has and keeps the login tokens in the Worker', () => {
    const worker = { LOGIN_TOKEN: 'link', SESSION_TOKEN: 'session', CSRF_TOKEN: 'csrf', SANCTUM_OIDC_ISSUER: 'https://issuer.sanctum.test', MYSQL_HOST: 'db' };
    expect(containerEnv(worker)).toEqual({ SANCTUM_OIDC_ISSUER: 'https://issuer.sanctum.test', MYSQL_HOST: 'db' });
  });
});

/** A container Durable Object whose container the test starts, as the library does after the check. */
const containerObject = () => {
  const storage = new Map<string, string>();
  const object = {
    restarts: 0,
    storage: { get: async (key: string) => storage.get(key), put: async (key: string, value: string) => void storage.set(key, value) },
    stored: () => [...storage.values()],
    container: {
      running: false,
      destroy: async () => {
        object.restarts++;
        object.container.running = false;
      },
    },
    blockConcurrencyWhile: <T>(callback: () => Promise<T>) => callback(),
    /** One object instance: the check, then the start that passes `env`. */
    serve: async (env: Record<string, string>) => {
      await retireStaleContainer(object, env);
      object.container.running = true;
    },
  };
  return object;
};

describe('container start environment', () => {
  const started = { MYSQL_HOST: 'db', SANCTUM_OIDC_ISSUER: 'https://issuer.sanctum.test', SANCTUM_OIDC_CLIENT_SECRET: 'client-secret-1' };

  it('keeps a container that started with the current settings', async () => {
    const object = containerObject();
    await object.serve(started);
    await object.serve({ ...started });
    expect(object.restarts).toBe(0);
  });

  it('restarts exactly once after a var or a secret changes', async () => {
    for (const changed of [{ ...started, SANCTUM_OIDC_ISSUER: 'https://other.sanctum.test' }, { ...started, SANCTUM_OIDC_CLIENT_SECRET: 'client-secret-2' }]) {
      const object = containerObject();
      await object.serve(started);
      await object.serve(changed);
      await object.serve(changed);
      expect(object.restarts).toBe(1);
    }
  });

  it('restarts a container that started before its settings were recorded', async () => {
    const object = containerObject();
    object.container.running = true;
    await object.serve(started);
    await object.serve(started);
    expect(object.restarts).toBe(1);
  });

  it('tries one restart per settings hash even when the container stays running', async () => {
    const object = containerObject();
    object.container.running = true;
    object.container.destroy = async () => void object.restarts++;
    await object.serve(started);
    await object.serve({ ...started });
    await object.serve({ ...started });
    expect(object.restarts).toBe(1);
  });

  it('records a hash and no setting value', async () => {
    const object = containerObject();
    await object.serve(started);
    expect(object.stored()).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/)]);
    for (const value of Object.values(started)) expect(object.stored()[0]).not.toContain(value);
  });
});
