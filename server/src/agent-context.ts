import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The AI agent (MCP client) a request is being made by, if any. requireAuth runs the rest of the
 * request inside this context, so code deep in a handler (posting a message, writing the timeline)
 * can record that an agent did it, and room control (`canControl`) is always refused for agents.
 * Kept free of app imports so anything can use it without import cycles.
 */
export type AgentScope = 'read' | 'write' | 'investigate';

export interface AgentContext {
  grantId: string;
  /** Shown next to what the agent does: "Claude (for Alice)". */
  name: string;
  userId: string;
  /** Only this incident, or null for every incident the person can open. */
  incidentId: string | null;
  scopes: AgentScope[];
}

export const agentStore = new AsyncLocalStorage<AgentContext>();
export const currentAgent = () => agentStore.getStore() ?? null;
