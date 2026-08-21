import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  readAgentConfig, agentCertPath, agentKeyPath,
  caCertPath as caCertPathFor, caKeyPath as caKeyPathFor, caDir,
  tokenSourceFromConfig,
} from '../config.js';
import { createCA, backupCAKey, recoverCAKey, loadCA, caCertFingerprint } from '@groundnuty/macf-core';
import { generateAgentCert, generateClientCert } from '@groundnuty/macf-core';
import { createClientFromConfig } from '../registry-helper.js';
import { createRegistryFromConfig } from '@groundnuty/macf-core';
import { generateToken } from '@groundnuty/macf-core';
import { promptPassword, PromptCancelled } from '../prompt.js';
import { toVariableSegment } from '@groundnuty/macf-core';

/**
 * Exported (groundnuty/macf#920) so `bootstrap/apply-routing-client.ts` can
 * mint the SAME identity `macf certs issue-routing-client` mints, via the
 * SAME {@link mintRoutingClientCert} primitive below — never a second
 * hand-rolled `generateClientCert` call with its own copy of this CN.
 */
export const ROUTING_CLIENT_CN = 'routing-action';
export const DEFAULT_ROUTING_CLIENT_VALIDITY_DAYS = 365;
const DEFAULT_VALIDITY_DAYS = DEFAULT_ROUTING_CLIENT_VALIDITY_DAYS;
const VALIDITY_WARN_DAYS = 730;

/**
 * The routing-client cert-minting primitive (groundnuty/macf#920) — factored
 * out of {@link issueRoutingClient} so `macf bootstrap apply` can issue the
 * identical CN=`routing-action` client identity from CA material it holds
 * IN MEMORY (a freshly-minted or vault-decrypted CA key/cert PEM pair),
 * without needing a local `macf-agent.json` workspace or CA files on disk
 * the way the interactive CLI command requires. Pure pass-through to
 * `@groundnuty/macf-core::generateClientCert` — no crypto logic lives here,
 * only the CN + default-validity convention every caller must share.
 */
export async function mintRoutingClientCert(
  caCertPem: string,
  caKeyPem: string,
  validityDays: number = DEFAULT_ROUTING_CLIENT_VALIDITY_DAYS,
): Promise<{ readonly certPem: string; readonly keyPem: string }> {
  return generateClientCert({
    commonName: ROUTING_CLIENT_CN,
    validityDays,
    caCertPem,
    caKeyPem,
  });
}

/** Registry variable recording the routing-client cert's issuer fingerprint + mint
 *  time (macf#800). `macf routing doctor` diffs this against the CURRENT CA's
 *  fingerprint to detect an orphaned routing-client cert without ever reading the
 *  write-only deployed secret. See `evaluateRoutingClientCertIssuer` in
 *  `routing-doctor.ts` for the read side. */
function routingClientCertIssuerVarName(project: string): string {
  return `${toVariableSegment(project)}_ROUTING_CLIENT_CERT_ISSUER`;
}

/**
 * Loud, unmissable blast-radius warning printed at the end of `certs init`
 * (on re-init over an existing CA) and `certs rotate` (macf#800, DR-010
 * amendment / silent-fallback-hazards.md Instance 16).
 *
 * A CA (re-)issue re-signs the LOCAL/registry CA material + the in-workspace
 * agent cert — but it CANNOT reach artifacts that live OUT-OF-BAND as GitHub
 * Actions secrets/variables on caller repos (agents can't write GitHub
 * secrets — DR-019). Those artifacts are now potentially signed by / naming
 * the OLD CA and will silently break routing until an operator re-syncs them.
 * We warn loudly; we never auto-write.
 */
function printCaRotationBlastRadiusWarning(project: string): void {
  const seg = toVariableSegment(project);
  console.log('');
  console.log('================================================================');
  console.log('⚠️  CA (re-)issued — OUT-OF-BAND blast radius');
  console.log('================================================================');
  console.log('This command re-issued the CA + in-workspace agent cert, but it CANNOT');
  console.log("reach artifacts that live out-of-band as GitHub Actions secrets/variables");
  console.log("on your caller/agent repos (agents can't write GitHub secrets).");
  console.log('Those artifacts may now be silently ORPHANED (signed by / naming the OLD');
  console.log('CA) — see silent-fallback-hazards.md Instance 16. On EVERY caller/agent');
  console.log("repo in this project's App install-set:");
  console.log('');
  console.log('  1. ROUTING_CLIENT_CERT / ROUTING_CLIENT_KEY (GitHub Actions secrets) —');
  console.log("     the macf-actions router's mTLS client cert, presented on every");
  console.log('     route-by-label POST. Re-mint + re-set:');
  console.log('       macf certs issue-routing-client --out-dir <dir>');
  console.log('       gh secret set ROUTING_CLIENT_CERT --repo <owner>/<repo> < <dir>/routing-action-cert.pem');
  console.log('       gh secret set ROUTING_CLIENT_KEY  --repo <owner>/<repo> < <dir>/routing-action-key.pem');
  console.log('');
  console.log(`  2. ${seg}_CA_CERT (a GitHub Actions repo VARIABLE, not the registry) —`);
  console.log("     the v3 router's CA trust anchor. Re-set:");
  console.log(`       gh variable set ${seg}_CA_CERT --repo <owner>/<repo> < <path-to-new-ca-cert.pem>`);
  console.log('');
  console.log("This command cannot enumerate your exact caller-repo list — check the");
  console.log("App's install-set (`macf routing doctor` or `gh api /installation/repositories`)");
  console.log('and apply BOTH commands above to every repo running the agent-router workflow.');
  console.log('================================================================');
  console.log('');
}

async function promptPassphrase(message: string): Promise<string> {
  try {
    return await promptPassword({ message });
  } catch (err) {
    if (err instanceof PromptCancelled) {
      console.error('\nCancelled.');
      process.exit(130); // 128 + SIGINT
    }
    throw err;
  }
}

function getVariablesClient(config: ReturnType<typeof readAgentConfig>, token: string) {
  if (!config) throw new Error('No macf-agent.json found. Run `macf init` first.');
  return createClientFromConfig(config.registry, token);
}

/**
 * macf certs init: create CA, upload cert + encrypted key to registry
 */
export async function certsInit(projectDir: string): Promise<void> {
  const config = readAgentConfig(projectDir);
  if (!config) {
    console.error('No macf-agent.json found. Run `macf init` first.');
    process.exitCode = 1;
    return;
  }

  const token = await generateToken(tokenSourceFromConfig(projectDir, config));
  const client = getVariablesClient(config, token);

  // Per-project CA paths. mkdir with 0o700 — CA key is the most sensitive secret.
  const projectCaDir = caDir(config.project);
  mkdirSync(projectCaDir, { recursive: true, mode: 0o700 });
  const caCertP = caCertPathFor(config.project);
  const caKeyP = caKeyPathFor(config.project);

  // macf#800: a re-init over an EXISTING CA is the same out-of-band-orphan
  // hazard as `certs rotate` — the fresh CA re-signs the in-workspace agent
  // cert but silently orphans any out-of-band artifact (routing-client cert,
  // caller-repo CA_CERT variable) signed by / naming the OLD CA. A genuine
  // first-time init has no orphans yet (nothing was signed by a CA that
  // didn't exist), so we only warn on reinit — checked BEFORE createCA
  // overwrites the files on disk.
  const isReinit = existsSync(caCertP);

  console.log(`Creating CA for project "${config.project}"...`);

  const ca = await createCA({
    project: config.project,
    certPath: caCertP,
    keyPath: caKeyP,
    client,
  });

  console.log(`  CA cert: ${caCertP}`);
  console.log(`  CA key:  ${caKeyP}`);
  console.log(`  CA cert uploaded to registry as ${toVariableSegment(config.project)}_CA_CERT`);

  // Encrypted backup
  const passphrase = await promptPassphrase('Enter passphrase for CA key backup: ');
  if (!passphrase) {
    console.warn('No passphrase provided — skipping encrypted backup.');
    if (isReinit) printCaRotationBlastRadiusWarning(config.project);
    return;
  }

  await backupCAKey({
    project: config.project,
    keyPem: ca.keyPem,
    passphrase,
    client,
  });

  console.log(`  Encrypted CA key backed up to registry as ${toVariableSegment(config.project)}_CA_KEY_ENCRYPTED`);
  console.log('\nCA initialization complete.');
  if (isReinit) printCaRotationBlastRadiusWarning(config.project);
}

/**
 * macf certs recover: download and decrypt CA key from registry
 */
export async function certsRecover(projectDir: string): Promise<void> {
  const config = readAgentConfig(projectDir);
  if (!config) {
    console.error('No macf-agent.json found. Run `macf init` first.');
    process.exitCode = 1;
    return;
  }

  const token = await generateToken(tokenSourceFromConfig(projectDir, config));
  const client = getVariablesClient(config, token);

  const passphrase = await promptPassphrase('Enter passphrase for CA key recovery: ');
  if (!passphrase) {
    console.error('Passphrase is required for recovery.');
    process.exitCode = 1;
    return;
  }

  // Per-project CA paths. mkdir with 0o700.
  mkdirSync(caDir(config.project), { recursive: true, mode: 0o700 });
  const caKeyP = caKeyPathFor(config.project);

  console.log('Recovering CA key from registry...');

  await recoverCAKey({
    project: config.project,
    passphrase,
    keyPath: caKeyP,
    client,
  });

  console.log(`  CA key recovered to: ${caKeyP}`);
  console.log('Recovery complete.');
}

/**
 * macf certs rotate: regenerate agent cert with existing CA
 */
export async function certsRotate(projectDir: string): Promise<void> {
  const config = readAgentConfig(projectDir);
  if (!config) {
    console.error('No macf-agent.json found. Run `macf init` first.');
    process.exitCode = 1;
    return;
  }

  const caCertP = caCertPathFor(config.project);
  const caKeyP = caKeyPathFor(config.project);
  if (!existsSync(caCertP) || !existsSync(caKeyP)) {
    console.error('CA cert or key not found. Run `macf certs init` or `macf certs recover` first.');
    process.exitCode = 1;
    return;
  }

  const ca = loadCA(caCertP, caKeyP);

  const certP = agentCertPath(projectDir);
  const keyP = agentKeyPath(projectDir);

  // macf#545: the cert CN is the ROUTING identity (registry key), not the OTEL
  // bot-name — mTLS validates the CN against the slot the router resolved.
  // Defaults to agent_name (back-compat; inert when routing_label is unset).
  const certCn = config.routing_label ?? config.agent_name;
  console.log(`Rotating certificate for "${certCn}"...`);

  await generateAgentCert({
    agentName: certCn,
    caCertPem: ca.certPem,
    caKeyPem: ca.keyPem,
    // Flow the advertised host into the cert SAN so TLS hostname
    // verification succeeds when an off-box consumer (routing Action,
    // sibling agent) connects over the network. macf#178 Gap 3.
    ...(config.advertise_host !== undefined ? { advertiseHost: config.advertise_host } : {}),
    certPath: certP,
    keyPath: keyP,
  });

  console.log(`  Cert: ${certP}`);
  console.log(`  Key:  ${keyP}`);
  console.log('Rotation complete.');

  // macf#800: warn unconditionally. `certs rotate` re-signs the in-workspace
  // agent cert against the CA on disk; an operator can't tell FROM HERE
  // whether that CA is itself the same one out-of-band artifacts were signed
  // against (e.g. after a `certs init` reinit swapped it), so the safe
  // default is to always surface the blast-radius reminder rather than try
  // to detect "did the CA actually change" and risk a false negative.
  printCaRotationBlastRadiusWarning(config.project);
}

export interface IssueRoutingClientOptions {
  readonly outDir?: string;
  readonly validityDays?: number;
}

/**
 * macf certs issue-routing-client: mint a CA-signed client cert with
 * CN=routing-action for use by the macf-actions routing workflow
 * (mTLS variant, macf-actions#8). The routing Action presents this
 * cert when POSTing to each agent's /notify endpoint.
 *
 * Requires the CA key on disk — this command is local-only, never
 * driven from the registry-encrypted backup. The resulting cert/key
 * is meant to be pasted into the consumer repo's GHA secrets; the
 * operator is expected to handle the paste securely (not commit it).
 *
 * If --out-dir is omitted, both PEMs are printed to stdout along with
 * single-line base64 blobs for easy GHA-secret paste. If --out-dir
 * is provided, files are written to disk at 0o600 / 0o644.
 */
export async function issueRoutingClient(
  projectDir: string,
  opts: IssueRoutingClientOptions = {},
): Promise<void> {
  const config = readAgentConfig(projectDir);
  if (!config) {
    console.error('No macf-agent.json found. Run `macf init` first.');
    process.exitCode = 1;
    return;
  }

  const validityDays = opts.validityDays ?? DEFAULT_VALIDITY_DAYS;
  if (!Number.isInteger(validityDays) || validityDays < 1) {
    console.error(`--validity-days must be a positive integer (got "${opts.validityDays}")`);
    process.exitCode = 1;
    return;
  }
  if (validityDays > VALIDITY_WARN_DAYS) {
    console.warn(
      `Warning: validity of ${validityDays} days exceeds ${VALIDITY_WARN_DAYS} days. ` +
      `Long-lived client certs increase blast radius if the key leaks; ` +
      `consider a shorter rotation cadence.`,
    );
  }

  const caCertP = caCertPathFor(config.project);
  const caKeyP = caKeyPathFor(config.project);
  if (!existsSync(caCertP) || !existsSync(caKeyP)) {
    console.error(
      'CA cert or key not found on disk. This command requires a local CA key — ' +
      'run `macf certs init` (first time) or `macf certs recover` (if CA lives in registry only).',
    );
    process.exitCode = 1;
    return;
  }
  const ca = loadCA(caCertP, caKeyP);

  // Collision guard: refuse if an existing agent is registered under
  // the routing-client CN. Prevents accidental overlap with a real
  // agent named `routing-action`.
  const token = await generateToken(tokenSourceFromConfig(projectDir, config));
  const registry = createRegistryFromConfig(config.registry, config.project, token);
  const existing = await registry.get(ROUTING_CLIENT_CN);
  if (existing !== null) {
    console.error(
      `An agent named "${ROUTING_CLIENT_CN}" is already registered. ` +
      `Rename or remove that agent before issuing the routing-client cert, or ` +
      `coordinate CN separation via a follow-up issue.`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(`Issuing routing-client cert for project "${config.project}"...`);
  console.log(`  CN:             ${ROUTING_CLIENT_CN}`);
  console.log(`  Validity:       ${validityDays} days`);

  const result = await mintRoutingClientCert(ca.certPem, ca.keyPem, validityDays);

  // macf#800: record the issuer fingerprint + mint time so `macf routing
  // doctor` can detect this cert going ORPHANED after a future CA rotation
  // — a GitHub secret is write-only, so this registry variable (same scope
  // as the CA material itself, DR-006) is the only way to check without
  // reading the deployed secret. Best-effort: a write failure here doesn't
  // block the operator from getting their cert — the doctor's "absent"
  // state for a missing variable is informational, not fatal (see
  // `evaluateRoutingClientCertIssuer` in routing-doctor.ts).
  const issuerVarName = routingClientCertIssuerVarName(config.project);
  try {
    const client = getVariablesClient(config, token);
    const issuerFingerprint = caCertFingerprint(ca.certPem);
    const mintedAt = new Date().toISOString();
    await client.writeVariable(
      issuerVarName,
      JSON.stringify({ issuer_fingerprint: issuerFingerprint, minted_at: mintedAt }),
    );
    console.log(`  Issuer recorded: ${issuerVarName} (baseline for \`macf routing doctor\`'s orphan check)`);
  } catch (err) {
    console.warn(
      `Warning: failed to record the routing-client cert issuer in ${issuerVarName} — ` +
      `\`macf routing doctor\`'s orphan-detection check will show "absent" until this ` +
      `succeeds (${err instanceof Error ? err.message : String(err)}).`,
    );
  }

  if (opts.outDir) {
    mkdirSync(opts.outDir, { recursive: true, mode: 0o700 });
    const certOut = join(opts.outDir, 'routing-action-cert.pem');
    const keyOut = join(opts.outDir, 'routing-action-key.pem');
    writeFileSync(certOut, result.certPem, { mode: 0o644 });
    writeFileSync(keyOut, result.keyPem, { mode: 0o600 });
    console.log(`  Cert written:   ${certOut}`);
    console.log(`  Key written:    ${keyOut}`);
    console.log('');
    console.log('GHA-secret paste format (for your consumer repo):');
    console.log('  ROUTING_CLIENT_CERT = ' + Buffer.from(result.certPem).toString('base64'));
    console.log('  ROUTING_CLIENT_KEY  = ' + Buffer.from(result.keyPem).toString('base64'));
  } else {
    console.log('');
    console.log('─── routing-action cert (PEM) ───');
    console.log(result.certPem);
    console.log('─── routing-action key (PEM, KEEP SECRET) ───');
    console.log(result.keyPem);
    console.log('─── GHA-secret paste format ───');
    console.log('ROUTING_CLIENT_CERT = ' + Buffer.from(result.certPem).toString('base64'));
    console.log('ROUTING_CLIENT_KEY  = ' + Buffer.from(result.keyPem).toString('base64'));
  }

  console.log('');
  console.log('Next steps (consumer Stage-3 wiring — see groundnuty/macf-actions CHANGELOG, "Migration for consumers"):');
  console.log('  1. Paste ROUTING_CLIENT_CERT and ROUTING_CLIENT_KEY into your consumer repo\'s GHA secrets');
  console.log('  2. Set the other v3 router secrets: TS_OAUTH_CLIENT_ID/SECRET + MACF_ROUTING_APP_ID/KEY (a dedicated variables:read-only App)');
  console.log('  3. Point the caller workflow at macf-actions/.github/workflows/agent-router.yml@v3 (with: { project }, secrets: inherit)');
}
