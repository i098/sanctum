/**
 * HTTP composition: every group of `SanctumApi` (packages/contracts/src/api.ts) gets its
 * handler layer here. Register a slice with one line in `groups` below.
 */
import { HttpApiBuilder } from '@effect/platform';
import { CurrentAccess } from '@sanctum/contracts';
import { SanctumApi } from '@sanctum/contracts/api';
import { Layer } from 'effect';
import { AgentsLive } from './agents.ts';
import { AuthenticatedLive } from './auth.ts';
import { HealthLive } from './health.ts';
import { MeetingsLive } from './meetings-api.ts';
import type { Migration } from './migrate.ts';

/** `GET /api/v1/session` returns the caller's resolved access. Kept here so auth.ts stays below the HTTP contract. */
const SessionLive = HttpApiBuilder.group(SanctumApi, 'session', handlers => handlers.handle('getSession', () => CurrentAccess));

export const ApiLive = (migrations: ReadonlyArray<Migration>) =>
  HttpApiBuilder.api(SanctumApi).pipe(
    Layer.provide([
      HealthLive(migrations),
      SessionLive,
      // Slice handler layers: one line each.
      MeetingsLive,
      AgentsLive,
    ]),
    Layer.provide(AuthenticatedLive),
  );
