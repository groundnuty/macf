# DR-009: Worker Pool Identity

**Status:** Accepted
**Date:** 2026-03-28

## Context

Ephemeral worker agents spawn fast (5 workers in 10 seconds). Each needs a first-class GitHub identity. But GitHub Apps require manual UI creation — can't create 50 apps.

## Decision

One GitHub App per worker pool. All workers share the bot identity, differentiate via tags in comments.

## How It Works

```
Permanent agents (unique identity):
  macf-science-agent[bot]    ← own GitHub App
  macf-code-agent[bot]       ← own GitHub App
  macf-writing-agent[bot]    ← own GitHub App

Worker pool (shared identity):
  macf-worker[bot]           ← ONE GitHub App, shared by all workers
    worker_a8f3c2: port 8832  ← own channel, own variable
    worker_b7d1e9: port 8847  ← own channel, own variable
```

Workers differentiate in comments:

```
[worker_a8f3c2] Starting work on this.
[worker_a8f3c2] @macf-science-agent[bot] PR #42 is ready for review.
```

## Registration

Each worker has a unique variable name using its instance ID:

```
MACF_AGENT_worker_a8f3c2 = {"host":"...","port":8832,"type":"worker"}
MACF_AGENT_worker_b7d1e9 = {"host":"...","port":8847,"type":"worker"}
```

## Cleanup

The spawner (harness script or orchestrator agent) is responsible for deleting worker variables when the worker exits or crashes.
