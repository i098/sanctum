/**
 * Plain-fetch client for the WorkOS REST API calls the hosted organization glue needs
 * (org-sync.ts): organizations, organization memberships and the Events API.
 * Providers never import application modules; org-sync.ts passes the key and timeout.
 */
import { Data, Effect, Option, Redacted, Schema } from 'effect';

class WorkosFailure extends Data.TaggedError('WorkosFailure')<{
  readonly message: string;
  /** Upstream HTTP status, or null when no response arrived. */
  readonly status: number | null;
}> {}

const Organization = Schema.Struct({ id: Schema.String, name: Schema.String });
type Organization = typeof Organization.Type;

const OrganizationMembership = Schema.Struct({
  user_id: Schema.String,
  organization_id: Schema.String,
  status: Schema.Literal('active', 'inactive', 'pending'),
  role: Schema.optional(Schema.NullOr(Schema.Struct({ slug: Schema.String }))),
});
export type OrganizationMembership = typeof OrganizationMembership.Type;

const MEMBERSHIP_EVENTS = ['organization_membership.created', 'organization_membership.updated', 'organization_membership.deleted'] as const;

/** The event types org-sync.ts follows; `data.id` is the organization or user id for deletions. */
const WorkosEvent = Schema.Union(
  Schema.Struct({ id: Schema.String, event: Schema.Literal(...MEMBERSHIP_EVENTS), data: OrganizationMembership }),
  Schema.Struct({ id: Schema.String, event: Schema.Literal('organization.deleted'), data: Schema.Struct({ id: Schema.String }) }),
  Schema.Struct({ id: Schema.String, event: Schema.Literal('user.deleted'), data: Schema.Struct({ id: Schema.String }) }),
);
export type WorkosEvent = typeof WorkosEvent.Type;

/** List pages hold at most 100 items; an absent `after` marks the end. */
export const PAGE_LIMIT = 100;
const page = <A, I>(item: Schema.Schema<A, I>) =>
  Schema.Struct({ data: Schema.Array(item), list_metadata: Schema.Struct({ after: Schema.optional(Schema.NullOr(Schema.String)) }) });

export interface WorkosOptions {
  readonly apiKey: Redacted.Redacted;
  readonly timeoutMs: number;
  /** Replaces the network (tests); production uses the global fetch. */
  readonly fetch?: typeof fetch;
}

/** The WorkOS calls the organization glue makes; every failure is a `WorkosFailure`. */
export interface WorkosClient {
  readonly organizationByExternalId: (externalId: string) => Effect.Effect<Option.Option<Organization>, WorkosFailure>;
  readonly createOrganization: (input: { readonly name: string; readonly external_id: string }) => Effect.Effect<Organization, WorkosFailure>;
  /** Creates an active membership, or reactivates an inactive one with this role. */
  readonly createMembership: (input: { readonly user_id: string; readonly organization_id: string; readonly role_slug: string }) => Effect.Effect<OrganizationMembership, WorkosFailure>;
  /** Every membership of the user in any status, all pages. */
  readonly listMemberships: (userId: string) => Effect.Effect<ReadonlyArray<OrganizationMembership>, WorkosFailure>;
  /** One page of followed events in creation order, after the given event id (from the oldest retained event when null). */
  readonly listEvents: (after: string | null) => Effect.Effect<ReadonlyArray<WorkosEvent>, WorkosFailure>;
}

export const makeWorkosClient = (options: WorkosOptions): WorkosClient => {
  const send = (method: 'GET' | 'POST', path: string, body?: unknown) =>
    Effect.tryPromise({
      try: async signal => {
        const response = await (options.fetch ?? fetch)(`https://api.workos.com${path}`, {
          method,
          headers: { authorization: `Bearer ${Redacted.value(options.apiKey)}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs)]),
        });
        return { status: response.status, text: await response.text() };
      },
      catch: cause => new WorkosFailure({ message: `WorkOS request failed: ${String(cause)}`, status: null }),
    });
  const call = <A, I>(schema: Schema.Schema<A, I>, method: 'GET' | 'POST', path: string, body?: unknown) =>
    Effect.flatMap(send(method, path, body), ({ status, text }) =>
      status >= 200 && status < 300
        ? Schema.decodeUnknown(Schema.parseJson(schema))(text).pipe(
          Effect.mapError(error => new WorkosFailure({ message: `Unexpected WorkOS response to ${method} ${path.split('?')[0]}: ${error.message}`, status })),
        )
        : Effect.fail(new WorkosFailure({ message: `WorkOS responded ${status} to ${method} ${path.split('?')[0]}: ${text.slice(0, 300)}`, status })),
    );

  return {
    organizationByExternalId: (externalId: string) =>
      call(Organization, 'GET', `/organizations/external_id/${encodeURIComponent(externalId)}`).pipe(
        Effect.map(Option.some),
        Effect.catchIf(error => error.status === 404, () => Effect.succeed(Option.none())),
      ),
    createOrganization: (input: { readonly name: string; readonly external_id: string }) => call(Organization, 'POST', '/organizations', input),
    createMembership: (input: { readonly user_id: string; readonly organization_id: string; readonly role_slug: string }) =>
      call(OrganizationMembership, 'POST', '/user_management/organization_memberships', input),
    listMemberships: (userId: string) =>
      Effect.gen(function* () {
        const memberships: Array<OrganizationMembership> = [];
        let after: string | null | undefined;
        do {
          const query = new URLSearchParams({ user_id: userId, statuses: 'active,inactive,pending', limit: String(PAGE_LIMIT), ...(after ? { after } : {}) });
          const listed = yield* call(page(OrganizationMembership), 'GET', `/user_management/organization_memberships?${query}`);
          memberships.push(...listed.data);
          after = listed.list_metadata.after;
        } while (after);
        return memberships;
      }),
    listEvents: (after: string | null) => {
      const query = new URLSearchParams({ events: [...MEMBERSHIP_EVENTS, 'organization.deleted', 'user.deleted'].join(','), order: 'asc', limit: String(PAGE_LIMIT), ...(after ? { after } : {}) });
      return Effect.map(call(page(WorkosEvent), 'GET', `/events?${query}`), listed => listed.data);
    },
  };
};
