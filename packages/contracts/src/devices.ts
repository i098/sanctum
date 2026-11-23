import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from '@effect/platform';
import { Schema } from 'effect';
import { Authenticated, Principal } from './auth.ts';
import { UtcTimestamp, WorkspaceId } from './common.ts';
import { NotFound, Unavailable } from './errors.ts';

export const DeviceCapabilities = Schema.Struct({
  mic: Schema.Literal(true),
  screen: Schema.Boolean,
  light: Schema.Literal('none', 'mono', 'pwm', 'rgb'),
  speaker: Schema.Boolean,
}).pipe(Schema.filter(c => c.screen || c.light !== 'none' || 'a device needs a screen or a light'));
export type DeviceCapabilities = typeof DeviceCapabilities.Type;

export const DeviceState = Schema.Literal('unpaired', 'stopped', 'starting', 'listening', 'reconnecting', 'degraded', 'paused', 'error');
export type DeviceState = typeof DeviceState.Type;

export const DeviceId = Schema.UUID.pipe(Schema.brand('DeviceId'));
export type DeviceId = typeof DeviceId.Type;

const deviceDescription = {
  name: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(200)),
  capabilities: DeviceCapabilities,
};
const userCode = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(200));
const deviceCode = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9_-]{43}$/));
const deviceId = HttpApiSchema.param('device_id', DeviceId);

export const Device = Schema.Struct({
  id: DeviceId,
  ...deviceDescription,
  status: Schema.Literal('pending', 'approved', 'denied', 'revoked'),
  approved_by: Schema.NullOr(Principal),
  created_at: UtcTimestamp,
  approved_at: Schema.NullOr(UtcTimestamp),
  last_used_at: Schema.NullOr(UtcTimestamp),
  revoked_at: Schema.NullOr(UtcTimestamp),
});
export type Device = typeof Device.Type;

export const DeviceAuthorization = Schema.Struct({
  device_code: deviceCode,
  user_code: Schema.String.pipe(Schema.pattern(/^\d{4}-\d{4}$/)),
  verification_uri: Schema.String,
  verification_uri_complete: Schema.String,
  expires_in: Schema.Literal(600),
  interval: Schema.Literal(5),
});
export type DeviceAuthorization = typeof DeviceAuthorization.Type;

export const DeviceToken = Schema.Struct({
  access_token: Schema.String,
  token_type: Schema.Literal('Bearer'),
  device_id: DeviceId,
  workspace_id: WorkspaceId,
});
export type DeviceToken = typeof DeviceToken.Type;

export const DeviceTokenError = Schema.Struct({
  error: Schema.Literal('authorization_pending', 'slow_down', 'access_denied', 'expired_token', 'invalid_grant'),
});
export type DeviceTokenError = typeof DeviceTokenError.Type;

export class DevicesApi extends HttpApiGroup.make('devices')
  .add(HttpApiEndpoint.post('authorizeDevice', '/device/authorize')
    .setPayload(Schema.Struct(deviceDescription)).addSuccess(DeviceAuthorization).addError(Unavailable))
  .add(HttpApiEndpoint.post('deviceToken', '/device/token')
    .setPayload(Schema.Struct({
      grant_type: Schema.Literal('urn:ietf:params:oauth:grant-type:device_code'),
      device_code: Schema.String.pipe(Schema.maxLength(200)),
    })).addSuccess(DeviceToken).addError(DeviceTokenError, { status: 400 }))
  .add(HttpApiEndpoint.get('pendingDevice', '/device/pending')
    .setUrlParams(Schema.Struct({ user_code: userCode }))
    .addSuccess(Schema.Struct({ ...deviceDescription, expires_at: UtcTimestamp }))
    .addError(NotFound).middleware(Authenticated))
  .add(HttpApiEndpoint.post('approveDevice', '/device/approve')
    .setPayload(Schema.Struct({ user_code: userCode, approve: Schema.Boolean }))
    .addSuccess(Device).addError(NotFound).middleware(Authenticated))
  .add(HttpApiEndpoint.get('listDevices', '/devices')
    .addSuccess(Schema.Struct({ items: Schema.Array(Device) })).middleware(Authenticated))
  .add(HttpApiEndpoint.del('revokeDevice')`/devices/${deviceId}`.addError(NotFound).middleware(Authenticated))
  .prefix('/api/v1') {}
