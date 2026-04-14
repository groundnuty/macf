import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpChannelError } from '../src/errors.js';

// Mock the MCP SDK before importing the module under test
const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockNotification = vi.fn().mockResolvedValue(undefined);

vi.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.connect = mockConnect;
    this.notification = mockNotification;
  }),
}));

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: vi.fn(),
}));

// Import after mock setup
const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
const { createMcpChannel } = await import('../src/mcp.js');

describe('createMcpChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates channel with correct server name', () => {
    createMcpChannel({ agentName: 'code-agent' });

    expect(Server).toHaveBeenCalledWith(
      { name: 'macf-code-agent', version: '0.1.0' },
      expect.objectContaining({
        capabilities: { experimental: { 'claude/channel': {} } },
        instructions: expect.stringContaining('issue_routed'),
      }),
    );
  });

  it('includes all three notification types in default instructions', () => {
    createMcpChannel({ agentName: 'test' });

    const callArgs = vi.mocked(Server).mock.calls[0]!;
    const options = callArgs[1] as { instructions: string };
    expect(options.instructions).toContain('issue_routed');
    expect(options.instructions).toContain('mention');
    expect(options.instructions).toContain('startup_check');
  });

  it('connects via StdioServerTransport', async () => {
    const channel = createMcpChannel({ agentName: 'code-agent' });
    await channel.connect();

    expect(mockConnect).toHaveBeenCalledOnce();
  });

  it('pushes notification with correct method and params', async () => {
    const channel = createMcpChannel({ agentName: 'code-agent' });

    await channel.pushNotification('Issue #42 was routed', {
      type: 'issue_routed',
      issue_number: '42',
    });

    expect(mockNotification).toHaveBeenCalledWith({
      method: 'notifications/claude/channel',
      params: {
        content: 'Issue #42 was routed',
        meta: { type: 'issue_routed', issue_number: '42' },
      },
    });
  });

  it('wraps notification errors in McpChannelError', async () => {
    mockNotification.mockRejectedValueOnce(new Error('transport closed'));

    const channel = createMcpChannel({ agentName: 'code-agent' });

    await expect(
      channel.pushNotification('test', {}),
    ).rejects.toThrow(McpChannelError);
  });

  it('accepts custom instructions', () => {
    createMcpChannel({
      agentName: 'test',
      instructions: 'Custom instructions',
    });

    const callArgs = vi.mocked(Server).mock.calls[0]!;
    const options = callArgs[1] as { instructions: string };
    expect(options.instructions).toBe('Custom instructions');
  });
});
