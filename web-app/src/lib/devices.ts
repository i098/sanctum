/** Browser client of `DevicesApi`, derived from the shared contract so paths and schemas cannot drift. */
import { FetchHttpClient, HttpApi, HttpApiClient, HttpClient, HttpClientRequest } from '@effect/platform';
import { DEVICE_PAIR_LOCKOUT, type Device, type DeviceCapabilities, type DeviceId, DevicesApi, Forbidden, NotFound, Unauthenticated, Unavailable, type UtcTimestamp } from '@sanctum/contracts';
import { Effect } from 'effect';
import { csrfToken } from './session.ts';

/** The devices group with the API-wide error envelope `SanctumApi` serves. */
class PairApi extends HttpApi.make('sanctum').add(DevicesApi).addError(Unauthenticated).addError(Forbidden).addError(NotFound).addError(Unavailable) {}

/** Why a call gave no answer: `locked` is the 403 after too many wrong codes (the server counts them, not the page). */
export type Refusal = 'signed_out' | 'not_found' | 'locked' | 'failed';

const REFUSALS: Partial<Record<string, Refusal>> = { Unauthenticated: 'signed_out', NotFound: 'not_found' };

/** A device waiting for approval, as `GET /device/pending` describes it. */
export interface PendingDevice {
  readonly name: string;
  readonly capabilities: DeviceCapabilities;
  readonly expires_at: UtcTimestamp;
}

export interface DevicesClient {
  pending(userCode: string): Promise<PendingDevice | Refusal>;
  approve(userCode: string, approve: boolean): Promise<Device | Refusal>;
  list(): Promise<{ readonly items: ReadonlyArray<Device> } | Refusal>;
  revoke(deviceId: DeviceId): Promise<void | Refusal>;
}

// Every failure, network and decode included, carries a `_tag`; it settles to a refusal the page can name.
const settle = <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E>): Promise<A | Refusal> =>
  Effect.runPromise(effect.pipe(Effect.catchAll(error => Effect.succeed(
    error._tag === 'Forbidden' && 'message' in error && error.message === DEVICE_PAIR_LOCKOUT ? 'locked' : REFUSALS[error._tag] ?? 'failed',
  ))));

/** Same-origin by default: the session cookie authenticates every call, and mutations carry the CSRF header. */
export function makeDevicesClient(baseUrl = globalThis.location?.origin ?? ''): DevicesClient {
  const transformClient = HttpClient.mapRequest(request => {
    const token = csrfToken();
    return token === undefined ? request : HttpClientRequest.setHeader(request, 'x-csrf-token', decodeURIComponent(token));
  });
  const api = Effect.runSync(HttpApiClient.make(PairApi, { baseUrl, transformClient }).pipe(Effect.provide(FetchHttpClient.layer))).devices;
  return {
    pending: user_code => settle(api.pendingDevice({ urlParams: { user_code } })),
    approve: (user_code, approve) => settle(api.approveDevice({ payload: { user_code, approve } })),
    list: () => settle(api.listDevices()),
    revoke: device_id => settle(api.revokeDevice({ path: { device_id } })),
  };
}

/** The 8 digits of a pairing code typed with any hyphens or spaces, else null. */
export const codeDigits = (input: string): string | null => {
  const digits = input.replace(/[\s-]/g, '');
  return /^\d{8}$/.test(digits) ? digits : null;
};

/** Typed input as the device shows its code: up to 8 digits, a hyphen after the fourth (`1234-5678`). */
export const formatCode = (input: string): string => {
  const digits = input.replace(/\D/g, '').slice(0, 8);
  return digits.length > 4 ? `${digits.slice(0, 4)}-${digits.slice(4)}` : digits;
};
