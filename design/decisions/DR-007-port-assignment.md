# DR-007: Dynamic Port Assignment

**Status:** Accepted
**Date:** 2026-03-28

## Context

Multiple agents on the same VM need different ports. How are ports assigned?

## Decision

Random port selection with OS-level collision retry.

## Options Considered

| Option | Pros | Cons |
|---|---|---|
| Hardcoded per agent | Predictable | Manual, breaks if two projects use same port |
| Base port + offset | Predictable, auto | Needs shared offset registry |
| **Random + EADDRINUSE retry** | **Zero coordination, OS handles conflicts** | **Port not predictable** |
| Dynamic (port 0, OS assigns) | Guaranteed unique | Same as random from discovery perspective |

## Rationale

The OS is the ultimate arbiter of port conflicts. Two processes can't bind the same port — `EADDRINUSE` is deterministic and immediate. No distributed coordination needed.

Cross-VM collisions can't happen (different port spaces). Same-VM collisions are resolved by the OS.

The "unpredictable port" concern is addressed by registration: the agent writes its actual port to the GitHub variable immediately after binding. Anyone who needs the port reads the variable, not a config file.

## Implementation

```typescript
const server = createServer(handler);
for (let attempt = 0; attempt < 10; attempt++) {
  const port = 8800 + Math.floor(Math.random() * 1000);
  try {
    server.listen(port, tailscaleIp);
    break;
  } catch (e) {
    if (e.code !== 'EADDRINUSE') throw e;
  }
}
```

`/macf-status` displays the actual port and verifies it matches the registration.
