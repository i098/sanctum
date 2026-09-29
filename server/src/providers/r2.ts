// stand-in: replaced by the media slice at integration
/** Private recording storage on Cloudflare R2; until the media slice lands every call fails visibly. */
import { Effect, Layer } from 'effect';
import { ObjectStore, ObjectStoreError } from '../object-store.ts';

const unconfigured = (operation: ObjectStoreError['operation']) => (key: string) =>
  Effect.fail(new ObjectStoreError({ operation, key, ambiguous: false, message: 'R2 object storage is not configured' }));

export const R2ObjectStoreLive = Layer.succeed(ObjectStore, {
  put: unconfigured('put'),
  head: unconfigured('head'),
  get: unconfigured('get'),
  presignGet: unconfigured('presign'),
});
