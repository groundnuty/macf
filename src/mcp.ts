import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { McpChannelError } from './errors.js';
import type { McpChannel } from './types.js';

const CHANNEL_INSTRUCTIONS = `Events arrive as <channel source="macf-agent" type="..." ...>.

type="issue_routed": A GitHub issue was routed to you by the agent-router Action.
  Read the issue and work on it following your agent identity rules.

type="mention": You were @mentioned in an issue comment or PR review.
  Read the context and respond.

type="startup_check": Pending issues found at session startup.
  Review and pick up the most important one.`;

export function createMcpChannel(config: {
  readonly agentName: string;
  readonly instructions?: string;
}): McpChannel {
  const instructions = config.instructions ?? CHANNEL_INSTRUCTIONS;

  const server = new Server(
    { name: `macf-${config.agentName}`, version: '0.1.0' },
    {
      capabilities: {
        experimental: { 'claude/channel': {} },
      },
      instructions,
    },
  );

  return {
    async connect(): Promise<void> {
      const transport = new StdioServerTransport();
      await server.connect(transport);
    },

    async pushNotification(
      content: string,
      meta: Record<string, string>,
    ): Promise<void> {
      try {
        // notifications/claude/channel is a Claude Code extension not in MCP's
        // typed ServerNotification union, but Server.assertNotificationCapability
        // has no default case so unknown methods pass through at runtime.
        await (server.notification as (n: {
          readonly method: string;
          readonly params: {
            readonly content: string;
            readonly meta: Record<string, string>;
          };
        }) => Promise<void>)({
          method: 'notifications/claude/channel',
          params: { content, meta },
        });
      } catch (err) {
        throw new McpChannelError(
          `Failed to push notification: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}
