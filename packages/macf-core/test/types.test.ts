import { describe, it, expect } from 'vitest';
import {
  NotifyPayloadSchema, NotifyTypeSchema, HealthResponseSchema,
  CiCompletionPayloadSchema, CheckSuiteConclusionSchema,
  PeerNotificationPayloadSchema, PrReviewStatePayloadSchema,
} from '../src/types.js';

describe('NotifyTypeSchema', () => {
  it('accepts valid types', () => {
    expect(NotifyTypeSchema.parse('issue_routed')).toBe('issue_routed');
    expect(NotifyTypeSchema.parse('mention')).toBe('mention');
    expect(NotifyTypeSchema.parse('startup_check')).toBe('startup_check');
    expect(NotifyTypeSchema.parse('ci_completion')).toBe('ci_completion');
    expect(NotifyTypeSchema.parse('peer_notification')).toBe('peer_notification');
    // macf-actions#39 (v3.3.0)
    expect(NotifyTypeSchema.parse('pr_review_state')).toBe('pr_review_state');
  });

  it('rejects unknown types', () => {
    expect(() => NotifyTypeSchema.parse('unknown')).toThrow();
  });
});

describe('NotifyPayloadSchema', () => {
  it('accepts minimal payload', () => {
    // `startup_check` carries no required anchor (unlike `mention` post-macf#616).
    const result = NotifyPayloadSchema.parse({ type: 'startup_check' });
    expect(result.type).toBe('startup_check');
    expect(result.issue_number).toBeUndefined();
  });

  it('accepts full payload', () => {
    const result = NotifyPayloadSchema.parse({
      type: 'issue_routed',
      issue_number: 42,
      title: 'Fix bug',
      source: 'agent-router',
      message: 'Routed to you',
    });
    expect(result.type).toBe('issue_routed');
    expect(result.issue_number).toBe(42);
    expect(result.title).toBe('Fix bug');
    expect(result.source).toBe('agent-router');
    expect(result.message).toBe('Routed to you');
  });

  it('rejects missing type', () => {
    expect(() => NotifyPayloadSchema.parse({ issue_number: 1 })).toThrow();
  });

  it('rejects invalid issue_number', () => {
    expect(() => NotifyPayloadSchema.parse({ type: 'mention', issue_number: -1 })).toThrow();
    expect(() => NotifyPayloadSchema.parse({ type: 'mention', issue_number: 0 })).toThrow();
    expect(() => NotifyPayloadSchema.parse({ type: 'mention', issue_number: 1.5 })).toThrow();
  });
});

describe('NotifyPayloadSchema — reply_to (macf#790 Gap 2)', () => {
  it('accepts an optional reply_to slug', () => {
    const result = NotifyPayloadSchema.parse({
      type: 'peer_notification',
      source: 'science-agent',
      event: 'custom',
      reply_to: 'icsoc-2026/science-agent',
    });
    expect(result.reply_to).toBe('icsoc-2026/science-agent');
  });

  it('is absent by default — back-compat with pre-#790 senders', () => {
    const result = NotifyPayloadSchema.parse({
      type: 'peer_notification',
      source: 'science-agent',
      event: 'custom',
    });
    expect(result.reply_to).toBeUndefined();
  });

  it('rejects a non-string reply_to', () => {
    expect(() => NotifyPayloadSchema.parse({
      type: 'peer_notification',
      source: 'a',
      event: 'custom',
      reply_to: 42,
    })).toThrow();
  });
});

describe('NotifyPayloadSchema — mention anchor invariant (macf#616)', () => {
  it('rejects a message-less, anchorless type:mention (the stranding hazard)', () => {
    const result = NotifyPayloadSchema.safeParse({ type: 'mention' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.issues.map((i) => i.message).join(' ');
      expect(msg).toContain('message or an issue_number/pr_number');
      expect(msg).toContain('macf#616');
    }
  });

  it('accepts a message-bearing anchorless type:mention (macf#629)', () => {
    // A message IS actionable content — a message-bearing mention is not
    // context-free, so it does not strand the recipient. (macf#616 over-rejected
    // these by requiring an anchor; #629 corrects the invariant to message-or-anchor.)
    const result = NotifyPayloadSchema.safeParse({
      type: 'mention',
      message: 'please take a look',
    });
    expect(result.success).toBe(true);
  });

  it('accepts the fleet-doctor --inject payload shape (macf#629)', () => {
    // `fleet-doctor-inject.ts` POSTs a message-bearing, anchorless, non-diagnostic
    // type:mention as the invasive Processed-proof probe. Pre-#629 the macf#616
    // refine 400-rejected it (anchor-only); it must now parse.
    const result = NotifyPayloadSchema.safeParse({
      type: 'mention',
      source: 'fleet-doctor',
      message:
        'fleet-doctor --inject probe (run_id=abc) — no action needed; this verifies '
        + 'delivery is processed end-to-end. [macf-route:abc:code-agent]',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a type:mention anchored by issue_number', () => {
    const result = NotifyPayloadSchema.safeParse({ type: 'mention', issue_number: 7 });
    expect(result.success).toBe(true);
  });

  it('accepts a type:mention anchored by pr_number', () => {
    const result = NotifyPayloadSchema.safeParse({ type: 'mention', pr_number: 12 });
    expect(result.success).toBe(true);
  });

  it('exempts a diagnostic probe (diagnostic:true) from the anchor requirement', () => {
    // DR-030 §6 probes deliberately POST an anchorless type:mention; they
    // short-circuit before delivery and are never surfaced to a recipient.
    const result = NotifyPayloadSchema.safeParse({ type: 'mention', diagnostic: true });
    expect(result.success).toBe(true);
  });

  it('does NOT exempt an explicit diagnostic:false anchorless mention', () => {
    const result = NotifyPayloadSchema.safeParse({ type: 'mention', diagnostic: false });
    expect(result.success).toBe(false);
  });

  it('leaves the anchor optional for non-mention notify types', () => {
    // The invariant is scoped to `mention` — other types still parse without
    // an issue_number/pr_number anchor (back-compat).
    expect(NotifyPayloadSchema.safeParse({ type: 'startup_check' }).success).toBe(true);
    expect(NotifyPayloadSchema.safeParse({ type: 'issue_routed' }).success).toBe(true);
    expect(
      NotifyPayloadSchema.safeParse({
        type: 'peer_notification',
        source: 'macf-science-agent',
        event: 'custom',
      }).success,
    ).toBe(true);
  });
});

describe('NotifyPayloadSchema — DR-030 §6 diagnostic discriminator (macf#568)', () => {
  it('accepts diagnostic + correlation_token', () => {
    const result = NotifyPayloadSchema.parse({
      type: 'mention',
      diagnostic: true,
      correlation_token: 'probe-abc-123',
    });
    expect(result.diagnostic).toBe(true);
    expect(result.correlation_token).toBe('probe-abc-123');
  });

  it('accepts diagnostic without correlation_token', () => {
    const result = NotifyPayloadSchema.parse({ type: 'mention', diagnostic: true });
    expect(result.diagnostic).toBe(true);
    expect(result.correlation_token).toBeUndefined();
  });

  it('both fields are optional → back-compat (a payload without them is unchanged)', () => {
    // `startup_check` needs no anchor (macf#616); this test is about the
    // diagnostic/correlation_token defaults, not the mention invariant.
    const result = NotifyPayloadSchema.parse({ type: 'startup_check' });
    expect(result.diagnostic).toBeUndefined();
    expect(result.correlation_token).toBeUndefined();
  });

  it('rejects a non-boolean diagnostic / non-string correlation_token', () => {
    expect(() => NotifyPayloadSchema.parse({ type: 'mention', diagnostic: 'yes' })).toThrow();
    expect(() => NotifyPayloadSchema.parse({ type: 'mention', correlation_token: 42 })).toThrow();
  });
});

describe('PeerNotificationPayloadSchema (macf#256, DR-023 UC-1)', () => {
  it('accepts minimal valid payload', () => {
    const result = PeerNotificationPayloadSchema.parse({
      type: 'peer_notification',
      source: 'macf-tester-1-agent',
      event: 'session-end',
    });
    expect(result.type).toBe('peer_notification');
    expect(result.source).toBe('macf-tester-1-agent');
    expect(result.event).toBe('session-end');
  });

  it('accepts full payload with optional fields', () => {
    const result = PeerNotificationPayloadSchema.parse({
      type: 'peer_notification',
      source: 'macf-tester-1-agent',
      event: 'turn-complete',
      message: 'wrapped up issue #42',
      context: { issue_number: 42 },
    });
    expect(result.message).toBe('wrapped up issue #42');
    expect(result.context).toEqual({ issue_number: 42 });
  });

  it('accepts all five event values', () => {
    for (const event of ['session-end', 'session-compact', 'turn-complete', 'error', 'custom'] as const) {
      const result = PeerNotificationPayloadSchema.parse({
        type: 'peer_notification', source: 'a', event,
      });
      expect(result.event).toBe(event);
    }
  });

  it('rejects unknown event', () => {
    expect(() => PeerNotificationPayloadSchema.parse({
      type: 'peer_notification', source: 'a', event: 'unknown-event',
    })).toThrow();
  });

  it('rejects missing source', () => {
    expect(() => PeerNotificationPayloadSchema.parse({
      type: 'peer_notification', event: 'session-end',
    })).toThrow();
  });

  it('parses cleanly via wider NotifyPayloadSchema discriminator', () => {
    // Receivers parse via wider schema + discriminate on type. This
    // mirrors the channel server's /notify dispatch path.
    const wide = NotifyPayloadSchema.parse({
      type: 'peer_notification',
      source: 'macf-tester-1-agent',
      event: 'session-end',
      message: 'bye',
    });
    expect(wide.type).toBe('peer_notification');
    expect(wide.source).toBe('macf-tester-1-agent');
    expect(wide.event).toBe('session-end');
  });

  // macf#355 source-level invariant: PeerNotificationPayloadSchema must NOT
  // declare a `wake` field. Wake-decision logic is keyed off `event` at the
  // receiver alone (per `wake-decision.ts:decideWake`). Re-introducing
  // `wake` would leak Pattern E loop-prevention logic back into the
  // sender-side API surface. Catches regressions at unit-test time.
  it('does NOT declare a `wake` field (macf#355 — receiver discriminates by event)', () => {
    // Zod v4 schemas expose `.shape` for ZodObject; the field set is
    // the keys of that record. `wake` MUST NOT be present.
    const shape = PeerNotificationPayloadSchema.shape;
    expect(Object.keys(shape)).not.toContain('wake');
  });

  it('drops a wake key from the parse result (macf#355 — field not in data model)', () => {
    // Defensive: zod's default for ZodObject silently strips unknown keys.
    // After macf#355, `wake` is NOT a known key — so a parse result must
    // not surface it on the typed object regardless of what the wire
    // sender did. Guards downstream code from accidentally observing a
    // ghost `wake` value via `result.wake` (TypeScript would catch the
    // direct read at compile time, but bracket-access via `as never` or
    // dynamic dispatch can route around the type — this asserts the
    // runtime stripping holds).
    const result = PeerNotificationPayloadSchema.parse({
      type: 'peer_notification',
      source: 'operator',
      event: 'custom',
      wake: true,
    } as never);
    expect('wake' in result).toBe(false);
  });

  it('NotifyPayloadSchema (wider) also has no `wake` field (macf#355)', () => {
    // The wider variant covers all NotifyTypes' optional fields; it
    // should NOT carry `wake` either. Sister-invariant to the narrower
    // schema check above; both schemas are sources of truth in different
    // call paths (receivers parse the wide one; producers validate the
    // narrow one).
    const shape = NotifyPayloadSchema.shape;
    expect(Object.keys(shape)).not.toContain('wake');
  });
});

describe('PrReviewStatePayloadSchema (macf-actions#39, v3.3.0)', () => {
  it('accepts minimal valid payload (approved review)', () => {
    const result = PrReviewStatePayloadSchema.parse({
      type: 'pr_review_state',
      review_state: 'approved',
      reviewer_login: 'cv-architect[bot]',
      pr_number: 42,
      pr_url: 'https://github.com/groundnuty/academic-resume/pull/42',
    });
    expect(result.type).toBe('pr_review_state');
    expect(result.review_state).toBe('approved');
    expect(result.reviewer_login).toBe('cv-architect[bot]');
    expect(result.pr_number).toBe(42);
  });

  it('accepts changes_requested state', () => {
    const result = PrReviewStatePayloadSchema.parse({
      type: 'pr_review_state',
      review_state: 'changes_requested',
      reviewer_login: 'cv-architect[bot]',
      pr_number: 42,
      pr_url: 'https://github.com/groundnuty/academic-resume/pull/42',
    });
    expect(result.review_state).toBe('changes_requested');
  });

  it('accepts optional review_url for deep-linking', () => {
    const result = PrReviewStatePayloadSchema.parse({
      type: 'pr_review_state',
      review_state: 'approved',
      reviewer_login: 'cv-architect[bot]',
      pr_number: 42,
      pr_url: 'https://github.com/groundnuty/academic-resume/pull/42',
      review_url: 'https://github.com/groundnuty/academic-resume/pull/42#pullrequestreview-12345',
    });
    expect(result.review_url).toBe(
      'https://github.com/groundnuty/academic-resume/pull/42#pullrequestreview-12345',
    );
  });

  it('rejects unknown review_state (e.g., commented or dismissed)', () => {
    // commented + dismissed are out-of-scope for v3.3.0 routing per the
    // design Q3 disposition on macf-actions#39. Schema enforces this so
    // future extension is an explicit choice (add to the enum), not a
    // silent accept.
    expect(() =>
      PrReviewStatePayloadSchema.parse({
        type: 'pr_review_state',
        review_state: 'commented',
        reviewer_login: 'cv-architect[bot]',
        pr_number: 42,
        pr_url: 'https://github.com/g/r/pull/42',
      }),
    ).toThrow();
    expect(() =>
      PrReviewStatePayloadSchema.parse({
        type: 'pr_review_state',
        review_state: 'dismissed',
        reviewer_login: 'cv-architect[bot]',
        pr_number: 42,
        pr_url: 'https://github.com/g/r/pull/42',
      }),
    ).toThrow();
  });

  it('rejects missing required fields', () => {
    // No reviewer_login
    expect(() =>
      PrReviewStatePayloadSchema.parse({
        type: 'pr_review_state',
        review_state: 'approved',
        pr_number: 42,
        pr_url: 'https://github.com/g/r/pull/42',
      }),
    ).toThrow();
    // No pr_number
    expect(() =>
      PrReviewStatePayloadSchema.parse({
        type: 'pr_review_state',
        review_state: 'approved',
        reviewer_login: 'cv-architect[bot]',
        pr_url: 'https://github.com/g/r/pull/42',
      }),
    ).toThrow();
    // No pr_url
    expect(() =>
      PrReviewStatePayloadSchema.parse({
        type: 'pr_review_state',
        review_state: 'approved',
        reviewer_login: 'cv-architect[bot]',
        pr_number: 42,
      }),
    ).toThrow();
  });

  it('rejects invalid pr_url (not a URL)', () => {
    expect(() =>
      PrReviewStatePayloadSchema.parse({
        type: 'pr_review_state',
        review_state: 'approved',
        reviewer_login: 'cv-architect[bot]',
        pr_number: 42,
        pr_url: 'not-a-url',
      }),
    ).toThrow();
  });

  it('parses cleanly via wider NotifyPayloadSchema discriminator', () => {
    // Receivers parse via wider schema + discriminate on type. Mirrors
    // channel-server's /notify dispatch path; ensures the wider schema
    // accepts the v3.3.0 payload shape backward-compat.
    const wide = NotifyPayloadSchema.parse({
      type: 'pr_review_state',
      review_state: 'approved',
      reviewer_login: 'cv-architect[bot]',
      pr_number: 42,
      pr_url: 'https://github.com/groundnuty/academic-resume/pull/42',
    });
    expect(wide.type).toBe('pr_review_state');
    expect(wide.review_state).toBe('approved');
    expect(wide.reviewer_login).toBe('cv-architect[bot]');
    expect(wide.pr_number).toBe(42);
  });
});

describe('HealthResponseSchema', () => {
  it('accepts valid health response', () => {
    const data = {
      agent: 'code-agent',
      status: 'online' as const,
      type: 'permanent',
      uptime_seconds: 3600,
      current_issue: null,
      version: '0.1.0',
      last_notification: null,
    };
    const result = HealthResponseSchema.parse(data);
    expect(result.agent).toBe('code-agent');
    expect(result.status).toBe('online');
  });

  it('accepts health with current issue', () => {
    const data = {
      agent: 'code-agent',
      status: 'online' as const,
      type: 'worker',
      uptime_seconds: 0,
      current_issue: 42,
      version: '0.1.0',
      last_notification: '2026-03-28T18:01:00Z',
    };
    const result = HealthResponseSchema.parse(data);
    expect(result.current_issue).toBe(42);
    expect(result.last_notification).toBe('2026-03-28T18:01:00Z');
  });

  it('rejects negative uptime', () => {
    expect(() => HealthResponseSchema.parse({
      agent: 'test',
      status: 'online',
      type: 'permanent',
      uptime_seconds: -1,
      current_issue: null,
      version: '0.1.0',
      last_notification: null,
    })).toThrow();
  });
});

describe('CheckSuiteConclusionSchema', () => {
  it('accepts all four actionable conclusions', () => {
    for (const v of ['success', 'failure', 'timed_out', 'action_required']) {
      expect(CheckSuiteConclusionSchema.parse(v)).toBe(v);
    }
  });

  it('rejects non-actionable conclusions', () => {
    for (const v of ['neutral', 'cancelled', 'skipped', 'stale', 'unknown']) {
      expect(() => CheckSuiteConclusionSchema.parse(v), v).toThrow();
    }
  });
});

describe('CiCompletionPayloadSchema (#122)', () => {
  const base = {
    type: 'ci_completion' as const,
    source: 'ci_completion' as const,
    pr_number: 42,
    pr_title: 'fix: do a thing',
    pr_url: 'https://github.com/owner/repo/pull/42',
    conclusion: 'success' as const,
    failing_check_name: null,
    message: 'PR #42: CI SUCCESS. ...',
  };

  it('accepts a success payload with failing_check_name null', () => {
    const result = CiCompletionPayloadSchema.parse(base);
    expect(result.conclusion).toBe('success');
    expect(result.failing_check_name).toBeNull();
  });

  it('accepts a failure payload with failing_check_name string', () => {
    const result = CiCompletionPayloadSchema.parse({
      ...base,
      conclusion: 'failure',
      failing_check_name: 'check / build',
      message: 'PR #42: CI FAILED. First failing check: \'check / build\'. ...',
    });
    expect(result.conclusion).toBe('failure');
    expect(result.failing_check_name).toBe('check / build');
  });

  it('accepts timed_out and action_required conclusions', () => {
    expect(CiCompletionPayloadSchema.parse({ ...base, conclusion: 'timed_out' }).conclusion)
      .toBe('timed_out');
    expect(CiCompletionPayloadSchema.parse({ ...base, conclusion: 'action_required' }).conclusion)
      .toBe('action_required');
  });

  it('rejects wrong literal type', () => {
    expect(() => CiCompletionPayloadSchema.parse({ ...base, type: 'mention' })).toThrow();
  });

  it('rejects wrong literal source', () => {
    expect(() => CiCompletionPayloadSchema.parse({ ...base, source: 'label' })).toThrow();
  });

  it('rejects missing pr_number', () => {
    const { pr_number: _pn, ...withoutPrNumber } = base;
    void _pn;
    expect(() => CiCompletionPayloadSchema.parse(withoutPrNumber)).toThrow();
  });

  it('rejects non-URL pr_url', () => {
    expect(() => CiCompletionPayloadSchema.parse({ ...base, pr_url: 'not a url' })).toThrow();
  });

  it('rejects non-actionable conclusion (cancelled, neutral, etc.)', () => {
    expect(() => CiCompletionPayloadSchema.parse({ ...base, conclusion: 'cancelled' })).toThrow();
  });

  it('rejects undefined failing_check_name (must be null or string, not omitted)', () => {
    const { failing_check_name: _fcn, ...withoutFcn } = base;
    void _fcn;
    expect(() => CiCompletionPayloadSchema.parse(withoutFcn)).toThrow();
  });

  it('also round-trips through the wider NotifyPayloadSchema (backward-compat)', () => {
    // Receivers parse against NotifyPayloadSchema (backward-compat
    // across variants) and narrow via type discriminator — verify
    // that a valid CiCompletionPayload also parses cleanly through
    // the wider schema.
    const result = NotifyPayloadSchema.parse(base);
    expect(result.type).toBe('ci_completion');
    expect(result.pr_number).toBe(42);
    expect(result.conclusion).toBe('success');
    expect(result.failing_check_name).toBeNull();
  });
});

describe('NotifyPayloadSchema (#122 additions)', () => {
  it('accepts ci_completion type', () => {
    const result = NotifyPayloadSchema.parse({
      type: 'ci_completion',
      pr_number: 99,
      conclusion: 'success',
    });
    expect(result.type).toBe('ci_completion');
  });

  it('rejects bad conclusion even on the wider schema', () => {
    expect(() => NotifyPayloadSchema.parse({
      type: 'ci_completion',
      conclusion: 'junk',
    })).toThrow();
  });

  it('rejects malformed pr_url even on the wider schema', () => {
    expect(() => NotifyPayloadSchema.parse({
      type: 'ci_completion',
      pr_url: 'not a url',
    })).toThrow();
  });
});
