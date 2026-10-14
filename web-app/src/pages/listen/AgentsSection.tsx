import type { SanctumClient } from '@sanctum/sdk';
import { useState } from 'react';
import { AccessTokens } from './AccessTokens.tsx';
import { AgentWork } from './AgentWork.tsx';

const TABS = ['Work', 'Access tokens'] as const;

/** Agents: what agents did (Work, first) and the credentials that let SDK and MCP clients act (Access tokens). */
export function AgentsSection({ client }: { client: SanctumClient }) {
  const [tab, setTab] = useState<(typeof TABS)[number]>('Work');
  return (
    <>
      <div role="tablist" aria-label="Agents sections" className="listen-tabs">
        {TABS.map(name => (
          <button key={name} type="button" role="tab" aria-selected={name === tab} onClick={() => setTab(name)}>
            {name}
          </button>
        ))}
      </div>
      <div role="tabpanel" aria-label={tab}>
        {tab === 'Work' ? <AgentWork client={client} /> : <AccessTokens client={client} />}
      </div>
    </>
  );
}
