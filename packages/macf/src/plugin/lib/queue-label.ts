/**
 * The label whose issues make up this agent's work queue.
 *
 * `MACF_ROUTING_LABEL` is the label the router keys on and every workspace's
 * env.identity exports; `MACF_AGENT_LABEL` stays as an explicit override. With
 * neither set this throws rather than guess, because a guessed label silently
 * shows the agent another agent's queue (groundnuty/macf#1488).
 */
export function resolveQueueLabel(env: Readonly<Record<string, string | undefined>>): string {
  const override = env['MACF_AGENT_LABEL']?.trim();
  if (override) return override;
  const routing = env['MACF_ROUTING_LABEL']?.trim();
  if (routing) return routing;
  throw new Error(
    "can't tell which issues are this agent's: neither MACF_ROUTING_LABEL nor MACF_AGENT_LABEL is set. " +
      'Launch the agent with ./claude.sh, which exports MACF_ROUTING_LABEL from .claude/.macf/env.identity.',
  );
}
