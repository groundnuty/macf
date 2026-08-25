/**
 * Tests for `manifest-flow-server.ts`'s gate-2 interstitial — the CSS-class
 * split (groundnuty/macf#1179, operator-reported font/wrap regression) and
 * the two new operator controls ("check again" / "cancel this identity",
 * also #1179). Fully offline: `startInstallInterstitial` binds a REAL
 * 127.0.0.1 ephemeral listener (no network beyond loopback), driven with
 * `fetch`.
 */
import { describe, it, expect } from 'vitest';
import {
  renderInstallInterstitial,
  startInstallInterstitial,
  type InstallInterstitialOptions,
} from '../../../src/cli/bootstrap/manifest-flow-server.js';

const BASE_OPTS: InstallInterstitialOptions = {
  role: 'code-agent',
  appName: 'demo-fleet-code-agent',
  installUrl: 'https://github.com/apps/demo-fleet-code-agent/installations/new',
  messageLines: ['on the page that opens, choose "Only select repositories" — NOT "All repositories".', 'select exactly: groundnuty/demo-code'],
  repoNames: ['demo-code'],
  gateNumber: 2,
  gateTotal: 2,
};

/** Extracts a named CSS rule's body from the page's `<style>` block — e.g. `extractRule(html, '.macf-instructions')`. */
function extractRule(html: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`);
  const match = re.exec(html);
  expect(match, `selector ${selector} not found in <style>`).not.toBeNull();
  return match?.[1] ?? '';
}

describe('renderInstallInterstitial — CSS class split (groundnuty/macf#1179)', () => {
  it('the two <pre> blocks carry DISTINCT classes, not a shared bare `pre` restyle', () => {
    const html = renderInstallInterstitial(BASE_OPTS);
    expect(html).toContain('<pre class="macf-repos">');
    expect(html).toContain('<pre class="macf-instructions">');
    // Decisive: a future edit that collapses the two back onto one selector
    // would make this assertion fail — the classes must differ.
    expect(html).not.toMatch(/<pre>[^<]/); // no unclassed <pre> remains
  });

  it('the instruction (prose) rule wraps and uses a smaller font than the repo (payload) rule', () => {
    const html = renderInstallInterstitial(BASE_OPTS);
    const instructionsRule = extractRule(html, '.macf-instructions');
    const reposRule = extractRule(html, '.macf-repos');

    // The operator's reported defect: too-big font + horizontal scroll
    // instead of wrapping. Assert the FIX, not just "a rule exists".
    expect(instructionsRule).toMatch(/white-space:\s*pre-wrap/);
    expect(instructionsRule).not.toMatch(/overflow-x:\s*auto/);

    // The payload block must NOT have shrunk or gained wrapping — it stays
    // exactly as prominent/selectable as before this issue.
    expect(reposRule).toMatch(/overflow-x:\s*auto/);
    expect(reposRule).not.toMatch(/white-space:\s*pre-wrap/);

    const instructionFontMatch = /font-size:\s*([\d.]+)rem/.exec(instructionsRule);
    const repoFontMatch = /font-size:\s*([\d.]+)rem/.exec(reposRule);
    expect(instructionFontMatch).not.toBeNull();
    expect(repoFontMatch).not.toBeNull();
    expect(Number(instructionFontMatch?.[1])).toBeLessThan(Number(repoFontMatch?.[1]));
  });

  it('the two rules are independently editable — mutating one selector\'s font-size cannot silently also change the other\'s', () => {
    const html = renderInstallInterstitial(BASE_OPTS);
    const instructionsRule = extractRule(html, '.macf-instructions');
    const reposRule = extractRule(html, '.macf-repos');
    expect(instructionsRule).not.toEqual(reposRule);
  });
});

describe('renderInstallInterstitial — gate-2 controls (groundnuty/macf#1179)', () => {
  it('carries a "check again" form (POST /check-again) and a "cancel this identity" form (POST /cancel)', () => {
    const html = renderInstallInterstitial(BASE_OPTS);
    expect(html).toMatch(/<form method="post" action="\/check-again"/);
    expect(html).toContain("I've updated the install — check again");
    expect(html).toMatch(/<form method="post" action="\/cancel"/);
    expect(html).toContain('Cancel this identity');
  });

  it('the "Continue to GitHub" link has no target="_blank" — WHY-comment pin: navigating away is the success path, so close-as-cancel is not implemented', () => {
    const html = renderInstallInterstitial(BASE_OPTS);
    const linkMatch = /<a class="button" href="[^"]*">Continue to GitHub to install<\/a>/.exec(html);
    expect(linkMatch).not.toBeNull();
    expect(linkMatch?.[0]).not.toContain('target=');
  });
});

describe('startInstallInterstitial — check-again / cancel wiring (groundnuty/macf#1179)', () => {
  it('GET / serves the rendered page', async () => {
    const handles = await startInstallInterstitial(BASE_OPTS);
    try {
      const res = await fetch(handles.startUrl);
      const body = await res.text();
      expect(res.status).toBe(200);
      expect(body).toContain('demo-fleet-code-agent');
    } finally {
      await handles.close();
    }
  });

  it('POST /check-again resolves waitForCheckAgain() and the click is observable even if the click arrives BEFORE anything is awaiting it (lost-wakeup guard)', async () => {
    const handles = await startInstallInterstitial(BASE_OPTS);
    try {
      // Click FIRST — nobody is awaiting `waitForCheckAgain()` yet.
      const postRes = await fetch(new URL('/check-again', handles.startUrl), { method: 'POST' });
      expect(postRes.status).toBe(200);
      expect(await postRes.text()).toContain('Checking again');

      // THEN await — must resolve immediately (the generation counter, not
      // a single reusable Promise, is what makes this safe).
      await expect(Promise.race([
        handles.waitForCheckAgain?.(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timed out — click was lost')), 2000)),
      ])).resolves.toBeUndefined();
    } finally {
      await handles.close();
    }
  });

  it('POST /check-again can be observed MULTIPLE times — awaiting again after a resolved click waits for the NEXT one', async () => {
    const handles = await startInstallInterstitial(BASE_OPTS);
    try {
      await fetch(new URL('/check-again', handles.startUrl), { method: 'POST' });
      await handles.waitForCheckAgain?.(); // consumes click #1

      const second = handles.waitForCheckAgain?.();
      let secondResolved = false;
      second?.then(() => { secondResolved = true; });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(secondResolved).toBe(false); // no NEW click yet — must still be pending

      await fetch(new URL('/check-again', handles.startUrl), { method: 'POST' }); // click #2
      await expect(second).resolves.toBeUndefined();
    } finally {
      await handles.close();
    }
  });

  it('POST /cancel resolves waitForCancel(), and stays resolved for any later call', async () => {
    const handles = await startInstallInterstitial(BASE_OPTS);
    try {
      const postRes = await fetch(new URL('/cancel', handles.startUrl), { method: 'POST' });
      expect(postRes.status).toBe(200);
      expect(await postRes.text()).toContain('Cancelled');

      await expect(handles.waitForCancel?.()).resolves.toBeUndefined();
      // Calling again after the fact resolves immediately — cancel never un-fires.
      await expect(handles.waitForCancel?.()).resolves.toBeUndefined();
    } finally {
      await handles.close();
    }
  });

  it('updateContent re-renders subsequent GETs with the narrowed messageLines/repoNames — WITHOUT tearing down the listener', async () => {
    const handles = await startInstallInterstitial(BASE_OPTS);
    try {
      const before = await (await fetch(handles.startUrl)).text();
      expect(before).toContain('select exactly: groundnuty/demo-code');

      handles.updateContent?.(['still missing: groundnuty/other-repo — add it under Repository access, then click Save.'], ['other-repo']);

      const after = await (await fetch(handles.startUrl)).text();
      expect(after).toContain('still missing: groundnuty/other-repo');
      expect(after).not.toContain('select exactly: groundnuty/demo-code');
      expect(after).toContain('<pre class="macf-repos">other-repo</pre>');
    } finally {
      await handles.close();
    }
  });
});
