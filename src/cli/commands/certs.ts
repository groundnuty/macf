import { existsSync, mkdirSync } from 'node:fs';
import {
  readAgentConfig, agentCertPath, agentKeyPath,
  caCertPath as caCertPathFor, caKeyPath as caKeyPathFor, caDir,
  tokenSourceFromConfig,
} from '../config.js';
import { createCA, backupCAKey, recoverCAKey, loadCA } from '../../certs/ca.js';
import { generateAgentCert } from '../../certs/agent-cert.js';
import { createClientFromConfig } from '../registry-helper.js';
import { generateToken } from '../../token.js';
import { promptPassword, PromptCancelled } from '../prompt.js';

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
  console.log(`  CA cert uploaded to registry as ${config.project.toUpperCase()}_CA_CERT`);

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

  console.log(`  Encrypted CA key backed up to registry as ${config.project.toUpperCase()}_CA_KEY_ENCRYPTED`);
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

  console.log(`Rotating certificate for "${config.agent_name}"...`);

  await generateAgentCert({
    agentName: config.agent_name,
    caCertPem: ca.certPem,
    caKeyPem: ca.keyPem,
    certPath: certP,
    keyPath: keyP,
  });

  console.log(`  Cert: ${certP}`);
  console.log(`  Key:  ${keyP}`);
  console.log('Rotation complete.');
}
