// `pingAgent` is the plugin-facing name for the shared mTLS health
// ping. Implementation lives in `src/mtls-health-ping.ts` since it's
// shared with `src/cli/commands/status.ts` — see ultrareview finding
// A3 for the dedup rationale.
export { pingAgentHealth as pingAgent } from '../../mtls-health-ping.js';
