import { fileURLToPath } from 'node:url';
import { unstable_readConfig } from 'wrangler';
import { describe, expect, it } from 'vitest';

const config = unstable_readConfig({ config: fileURLToPath(new URL('../wrangler.jsonc', import.meta.url).href) });

describe('hosted deployment', () => {
  it('signs in and authorizes MCP on the app host, and serves the apex too', () => {
    expect(config.vars).toMatchObject({
      SANCTUM_OIDC_REDIRECT_URI: 'https://app.sanctum.42nights.dev/auth/callback',
      SANCTUM_MCP_RESOURCE: 'https://app.sanctum.42nights.dev/mcp',
    });
    expect(config.routes).toEqual([
      { pattern: 'app.sanctum.42nights.dev', custom_domain: true },
      { pattern: 'sanctum.42nights.dev', custom_domain: true },
    ]);
  });
});
