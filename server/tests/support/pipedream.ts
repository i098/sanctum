/**
 * In-memory Pipedream Connect double for tests: a catalog of fixture actions behind the
 * production `PipedreamClient` interface, recording every call. Never used by the application.
 */
import { Effect, Layer } from 'effect';
import { type ActionComponent, type ActionProp, IntegrationFailure, type OptionChoice, PipedreamClient, type PipedreamService, type ProxyRequest } from '../../src/providers/pipedream.ts';

/** Test catalog entry: a component plus fixture-only behavior. */
export interface FixtureAction extends ActionComponent {
  /** Remote options per prop name. */
  readonly options?: Readonly<Record<string, ReadonlyArray<OptionChoice>>>;
  /** Props added by `reloadProps` once the configured props are known (dynamic schema). */
  readonly dynamicProps?: (configured: Readonly<Record<string, unknown>>) => ReadonlyArray<ActionProp>;
  readonly ret?: unknown;
}

type Operation = Exclude<keyof PipedreamService, 'configured'>;

/** One recorded fixture call, typed by operation. */
type FixtureCall = { [K in Operation]: { readonly operation: K; readonly request: Parameters<PipedreamService[K]>[0] } }[Operation];

export interface PipedreamFixture {
  readonly layer: Layer.Layer<PipedreamClient>;
  /** Mutable catalog by key: replace an entry to simulate a version bump. */
  readonly actions: Map<string, FixtureAction>;
  readonly calls: ReadonlyArray<FixtureCall>;
  /** The next call of `operation` fails with `error`. */
  readonly failNext: (operation: Operation, error: IntegrationFailure) => void;
  /** JSON body the fixture proxy answers with. */
  readonly respondToProxy: (respond: (request: ProxyRequest) => unknown) => void;
}

/** Upstream page size of fixture remote options. */
const FIXTURE_OPTIONS_PAGE = 50;

const words = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/**
 * In-memory Pipedream for tests and local development without credentials: a mutable catalog,
 * recorded calls, and one-shot failures.
 */
export const fixturePipedream = (catalog: ReadonlyArray<FixtureAction>): PipedreamFixture => {
  const actions = new Map(catalog.map(action => [action.key, action]));
  const calls: Array<FixtureCall> = [];
  const failures = new Map<Operation, IntegrationFailure>();
  let proxyResponse: (request: ProxyRequest) => unknown = () => ({});

  const call = <K extends Operation, A>(operation: K, request: Parameters<PipedreamService[K]>[0], run: () => A): Effect.Effect<A, IntegrationFailure> =>
    Effect.suspend(() => {
      // TypeScript cannot correlate `operation` and `request` through the generic `K`.
      const recorded = { operation, request } as FixtureCall;
      calls.push(recorded);
      const failed = failures.get(operation);
      failures.delete(operation);
      return failed ? Effect.fail(failed) : Effect.sync(run);
    });

  const found = (key: string) => {
    const action = actions.get(key);
    if (!action) throw new Error(`fixture action ${key} is missing`);
    return action;
  };

  const service: PipedreamService = {
    configured: true,
    searchActions: query =>
      call('searchActions', query, () => {
        const terms = words(query.q);
        const scored = [...actions.values()]
          .filter(action => action.configurable_props.some(prop => prop.type === 'app' && prop.app === query.app))
          .map(action => {
            const text = new Set(words(`${action.key} ${action.name} ${action.description ?? ''}`));
            return { action, score: terms.filter(term => text.has(term)).length };
          })
          .filter(entry => entry.score > 0);
        scored.sort((a, b) => b.score - a.score || a.action.key.localeCompare(b.action.key));
        return scored.slice(0, query.limit).map(entry => entry.action);
      }),
    getAction: key => call('getAction', key, () => actions.get(key) ?? null),
    reloadProps: request =>
      call('reloadProps', request, () => {
        const action = found(request.id);
        const props = [...action.configurable_props, ...(action.dynamicProps?.(request.configured_props) ?? [])];
        return { id: `dyn_${props.map(prop => prop.name).join('_')}`, props };
      }),
    configureProp: request =>
      call('configureProp', request, () => {
        const all = found(request.id).options?.[request.prop_name] ?? [];
        const start = request.page * FIXTURE_OPTIONS_PAGE;
        const more = start + FIXTURE_OPTIONS_PAGE < all.length;
        return { options: all.slice(start, start + FIXTURE_OPTIONS_PAGE), context: more ? { page: request.page + 1 } : null };
      }),
    runAction: request => call('runAction', request, () => ({ exports: { $summary: `ran ${request.id}` }, ret: found(request.id).ret ?? null })),
    proxy: request => call('proxy', request, () => new TextEncoder().encode(JSON.stringify(proxyResponse(request)))),
    createConnectToken: user => call('createConnectToken', user, () => ({ connect_link_url: 'https://pipedream.com/_static/connect.html?token=ctok_fixture&connectLink=true' })),
    listAccounts: user => call('listAccounts', user, () => []),
    deleteAccount: account => call('deleteAccount', account, () => undefined),
  };

  return {
    layer: Layer.succeed(PipedreamClient, service),
    actions,
    calls,
    failNext: (operation, error) => {
      failures.set(operation, error);
    },
    respondToProxy: respond => {
      proxyResponse = respond;
    },
  };
};
