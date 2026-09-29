/**
 * HTTP composition: every group of `SanctumApi` (packages/contracts/src/api.ts) gets its
 * handler layer here. Register a slice with one line in `groups` below.
 */
import { HttpApiBuilder } from '@effect/platform';
import { SanctumApi } from '@sanctum/contracts';
import { Layer } from 'effect';
import { ActionsLive } from './actions.ts';
import { AuthenticatedLive, SessionLive } from './auth.ts';
import { HealthLive } from './health.ts';
import type { Migration } from './migrate.ts';

export const ApiLive = (migrations: ReadonlyArray<Migration>) =>
  HttpApiBuilder.api(SanctumApi).pipe(
    Layer.provide([
      HealthLive(migrations),
      SessionLive,
      // Slice handler layers: one line each.
      ActionsLive,
    ]),
    Layer.provide(AuthenticatedLive),
  );
