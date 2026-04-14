import { AgentInfoSchema } from './types.js';
import type { AgentInfo, Registry, GitHubVariablesClient } from './types.js';

/**
 * Creates a Registry backed by a GitHubVariablesClient.
 * All three backends (org, profile, repo) share this implementation —
 * the only difference is the URL path prefix baked into the client.
 */
export function createRegistry(
  client: GitHubVariablesClient,
  project: string,
): Registry {
  const prefix = `${project.toUpperCase()}_AGENT_`;

  function variableName(agentName: string): string {
    return `${prefix}${agentName}`;
  }

  return {
    async register(name: string, info: AgentInfo): Promise<void> {
      const value = JSON.stringify(info);
      await client.writeVariable(variableName(name), value);
    },

    async get(name: string): Promise<AgentInfo | null> {
      const value = await client.readVariable(variableName(name));
      if (value === null) return null;

      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        return null;
      }

      const result = AgentInfoSchema.safeParse(parsed);
      if (!result.success) return null;
      return result.data;
    },

    async list(
      filterPrefix: string,
    ): Promise<ReadonlyArray<{ readonly name: string; readonly info: AgentInfo }>> {
      const allVars = await client.listVariables();
      const fullPrefix = `${prefix}${filterPrefix}`;
      const results: Array<{ name: string; info: AgentInfo }> = [];

      for (const v of allVars) {
        if (!v.name.startsWith(fullPrefix)) continue;

        let parsed: unknown;
        try {
          parsed = JSON.parse(v.value);
        } catch {
          continue;
        }

        const result = AgentInfoSchema.safeParse(parsed);
        if (!result.success) continue;

        const agentName = v.name.slice(prefix.length);
        results.push({ name: agentName, info: result.data });
      }

      return results;
    },

    async remove(name: string): Promise<void> {
      await client.deleteVariable(variableName(name));
    },
  };
}
