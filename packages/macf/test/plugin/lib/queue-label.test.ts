import { describe, expect, it } from 'vitest';
import { resolveQueueLabel } from '../../../src/plugin/lib/queue-label.js';

describe('resolveQueueLabel (groundnuty/macf#1488)', () => {
  it("uses the agent's routing label, not a code-agent default", () => {
    expect(resolveQueueLabel({ MACF_ROUTING_LABEL: 'writing-agent' })).toBe('writing-agent');
  });

  it('lets an explicit MACF_AGENT_LABEL override the routing label', () => {
    expect(resolveQueueLabel({ MACF_ROUTING_LABEL: 'writing-agent', MACF_AGENT_LABEL: 'docs' })).toBe('docs');
  });

  it('fails loudly, naming the variable, when no label is set', () => {
    expect(() => resolveQueueLabel({})).toThrow(/MACF_ROUTING_LABEL/);
    expect(() => resolveQueueLabel({ MACF_ROUTING_LABEL: '  ' })).toThrow(/MACF_ROUTING_LABEL/);
  });
});
