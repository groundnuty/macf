import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  readAgentConfig, agentCertPath, agentKeyPath,
  caCertPath as caCertPathFor, caKeyPath as caKeyPathFor, caDir,
  tokenSourceFromConfig,
} from '../config.js';
import { createCA, backupCAKey, recoverCAKey, loadCA } from '@groundnuty/macf-core';
import { generateAgentCert, generateClientCert } from '@groundnuty/macf-core';
import { createClientFromConfig } from '../registry-helper.js';
import { createRegistryFromConfig } from '@groundnuty/macf-core';
import { generateToken } from '@groundnuty/macf-core';
import { promptPassword, PromptCancelled } from '../prompt.js';
import { toVariableSegment } from '@groundnuty/macf-core';

const ROUTING_CLIENT_CN = 'routing-action';
const DEFAULT_VALIDITY_DAYS = 365;
const VALIDITY_WARN_DAYS = 730;

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

  const result = await generateClientCert({
    commonName: ROUTING_CLIENT_CN,
    validityDays,
    caCertPem: ca.certPem,
    caKeyPem: ca.keyPem,
  });

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
