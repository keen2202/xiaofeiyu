#!/usr/bin/env node
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { AppError } from './src/errors.js';
import { createRuntime, HTTP_PREFIX, sanitizeErrorMessage } from './src/index.js';
import { loadConfigFile, redactConfig } from './src/config.js';
import { BackupPolicyService, BackupService, RecoveryService } from './src/backup-recovery.js';
import { HumanProofService, TtyHumanVerifier } from './src/identity.js';
import { jcsHash, randomId, truncateText } from './src/utils.js';

class CliUsageError extends AppError {
  constructor(message) {
    super('CONFIG_INVALID', message);
    this.usage = true;
  }
}

const BOOLEAN_FLAGS = ['dry', 'go', 'confirm', 'force', 'json', 'source-stopped'];

function parseArgs(argv) {
  const command = [];
  const flags = {};
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith('--')) {
      const [name, inline] = token.slice(2).split('=', 2);
      if (inline !== undefined) {
        flags[name] = inline;
        continue;
      }
      if (BOOLEAN_FLAGS.includes(name)) {
        flags[name] = true;
        continue;
      }
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[name] = true;
        continue;
      }
      flags[name] = next;
      index += 1;
    } else {
      command.push(token);
    }
  }
  return { command, flags, values };
}

function modeFrom(flags, { required = false } = {}) {
  if (flags.dry && flags.go) throw new CliUsageError('choose only one of --dry or --go');
  if (flags.dry) return 'dry';
  if (flags.go) return 'go';
  if (required) throw new CliUsageError('explicit --dry or --go is required');
  return null;
}

function requireConfirm(flags, action) {
  if (flags.confirm !== true) throw new CliUsageError(`${action} requires --confirm`);
}

async function readJsonArg(file) {
  if (!file || file === true) throw new CliUsageError('--file or --job is required');
  try {
    return JSON.parse(await fsp.readFile(path.resolve(file), 'utf8'));
  } catch (error) {
    throw new AppError('CONFIG_INVALID', `cannot read JSON file: ${error.message}`);
  }
}

function stableRequestId(action) {
  const slug = String(action || 'request').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '');
  return `cli-${slug}-${randomId('req').split('_').at(-1)}`;
}

async function dispatch(runtime, principal, action, input = {}, mode = 'dry', extra = {}) {
  const envelope = {
    schemaVersion: 1,
    requestId: stableRequestId(action),
    action,
    input,
    mode
  };
  return runtime.commandService.execute(envelope, principal, {
    trusted: true,
    sourceKind: 'cli',
    ...extra
  });
}

/** Read-only lookup of the local owner; only creates it when missing. */
async function localOwner(runtime, { createIfMissing = true } = {}) {
  const state = await runtime.store.getSnapshot();
  let found = null;
  if (typeof runtime.identity?.findLocalOwner === 'function') {
    found = runtime.identity.findLocalOwner(state);
  } else {
    found = Object.values(state.principals || {}).find(
      (principal) =>
        principal.kind === 'human' &&
        principal.role === 'owner' &&
        principal.sourceKind === 'local_cli' &&
        !principal.revokedAt
    ) || null;
  }
  if (found) return found;
  if (!createIfMissing) return null;
  return runtime.store.transaction(async (draft, tx) => runtime.identity.ensureLocalOwner(tx));
}

function shortValue(value) {
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'string') {
    const text = value.length > 80 ? `${value.slice(0, 77)}…` : value;
    return JSON.stringify(text);
  }
  if (typeof value === 'object') {
    const text = JSON.stringify(value);
    return text.length > 80 ? `${text.slice(0, 77)}…` : text;
  }
  return String(value);
}

const BINDING_LABELS = [
  ['action', 'Action'],
  ['taskId', 'Task'],
  ['approvalId', 'Approval'],
  ['operationId', 'Operation'],
  ['notificationId', 'Notification'],
  ['migrationId', 'Migration'],
  ['backupId', 'Backup'],
  ['recoveryId', 'Recovery'],
  ['holdId', 'Hold'],
  ['bindingId', 'IM binding'],
  ['recipientMid', 'Recipient'],
  ['to', 'Recipient'],
  ['platform', 'Platform'],
  ['targetInstanceId', 'Target instance'],
  ['dataDir', 'Data directory'],
  ['file', 'File'],
  ['role', 'Role'],
  ['kind', 'Kind'],
  ['note', 'Note'],
  ['reason', 'Reason'],
  ['mode', 'Mode'],
  ['patchHash', 'Config patch hash'],
  ['bindingHash', 'Binding hash'],
  ['evidenceHash', 'Evidence hash'],
  ['schemaVersion', 'Schema version']
];

/**
 * Human-readable description of the content bound into a human challenge.
 * The bound hash alone is not enough for a human to verify what is approved.
 */
export function describeBinding(binding = {}) {
  const lines = [];
  const source = binding && typeof binding === 'object' ? binding : {};
  for (const [key, label] of BINDING_LABELS) {
    if (source[key] === undefined || source[key] === null || source[key] === '') continue;
    lines.push(`${label}: ${shortValue(source[key])}`);
  }
  if (source.contentRef && typeof source.contentRef === 'object') {
    lines.push(`Content: ${shortValue(source.contentRef)}`);
  }
  if (source.text !== undefined) {
    const text = String(source.text);
    lines.push(`Text preview: ${JSON.stringify(text.length > 60 ? `${text.slice(0, 57)}…` : text)}`);
  }
  if (source.textHash) lines.push(`Text hash: ${shortValue(source.textHash)}`);
  return lines;
}

async function promptProofWithVerifier(verifier, binding, io = {}) {
  if (!verifier || typeof verifier.issue !== 'function') {
    throw new AppError('TRUST_UNAVAILABLE', 'interactive TTY human proof is unavailable');
  }
  const output = io.proofOutput || io.stdout || process.stdout;
  const summary = describeBinding(binding);
  if (summary.length > 0) {
    output.write(`\nHuman confirmation requested:\n  - ${summary.join('\n  - ')}\n`);
  }
  const challenge = verifier.issue(binding);
  if (typeof io.prompt === 'function') {
    return {
      challengeId: challenge.challengeId,
      response: String(await io.prompt(binding, challenge))
    };
  }
  const stdin = io.stdin || process.stdin;
  if (!stdin?.isTTY) {
    throw new AppError('TRUST_UNAVAILABLE', 'interactive TTY human proof is unavailable');
  }
  const rl = readline.createInterface({ input: stdin, output });
  try {
    return {
      challengeId: challenge.challengeId,
      response: await rl.question('Type the one-time phrase: ')
    };
  } finally {
    rl.close();
  }
}

async function humanContext(runtime, binding, { verifyNow = false, io = {} } = {}) {
  const principal = await localOwner(runtime, { createIfMissing: false });
  if (!principal) throw new AppError('TRUST_UNAVAILABLE', 'local owner is not initialized; run status first');
  const proof = await promptProofWithVerifier(runtime.humanProof?.verifier, binding, io);
  const context = { principal, proof };
  if (verifyNow) await runtime.humanProof.assert(context, binding);
  return context;
}

function print(json, value) {
  json.write(`${JSON.stringify(value, null, 2)}\n`);
}

function waitingFor(method) {
  return new AppError('DEPENDENCY_UNAVAILABLE', `${method} is not available yet; waiting for the owning module interface`, {
    details: { waitingFor: method, reason: 'optional_interface_missing' }
  });
}

function normalizeCancellationEvidence(evidence) {
  if (evidence === true) return { note: null, provenance: 'proven_undispatched', provenUndispatched: true };
  if (typeof evidence === 'string') {
    const text = evidence.trim();
    if (text === '') return null;
    return { note: truncateText(text, 500), provenance: 'local_human', provenUndispatched: false };
  }
  if (evidence && typeof evidence === 'object' && !Array.isArray(evidence)) {
    const note = evidence.note ?? evidence.reason ?? null;
    return {
      note: note === null || note === undefined ? null : truncateText(String(note), 500),
      provenance: evidence.provenance || evidence.kind || 'local_human',
      provenUndispatched: evidence.provenUndispatched === true
    };
  }
  return null;
}

function approvalProofBinding(approval) {
  return {
    approvalId: approval.id,
    taskId: approval.taskId,
    action: approval.action,
    inputHash: approval.inputHash,
    taskRevision: approval.taskRevision,
    bindingHash: jcsHash({ approvalId: approval.id, inputHash: approval.inputHash })
  };
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const { command, flags } = parseArgs(argv);
  const runtimeFactory = typeof io.createRuntime === 'function' ? io.createRuntime : createRuntime;
  if (command.length === 0 || flags.help) {
    stdout.write(
      [
        'dsh-bili-unified CLI',
        '',
        'node cli.mjs status | config validate | config update --file <json> --confirm',
        'node cli.mjs account verify | account resume --platform bilibili --note <note> --confirm',
        'node cli.mjs browse --dry|--go | diary --date <date> --scope <scope> [--force]',
        'node cli.mjs comment --draft <json> | approval decide <id> approve|reject --confirm --dry|--go',
        'node cli.mjs dm --to <mid> --text <text> --dry|--go',
        'node cli.mjs artifact import --file <path> --role <role> --confirm',
        'node cli.mjs production --job <json> --dry|--go | publish --job <json> --dry|--go',
        'node cli.mjs publish complete <id> --bvid <bv> --confirm --note <note>',
        'node cli.mjs publish void <task-id> --reason <text> --confirm',
        'node cli.mjs task get <id> | task cancel <id> --confirm | task resume <id> --confirm --dry|--go',
        'node cli.mjs operation resolve <id> confirmed|not_sent --receipt <json> [--evidence-ref <ref>] --note <note> --confirm',
        'node cli.mjs operation cancel <id> --reason <text> --confirm',
        'node cli.mjs outbox resolve <id> confirmed|not_sent --receipt <json> --note <note> --confirm',
        'node cli.mjs im bind --file <json> --confirm | im revoke <binding-id> --confirm',
        'node cli.mjs migration <prepare|export|release|import|validate|activate|status|abort|disable-target|rollback|release-hold> ...',
        '  prepare --target <instance> [--executor-stop-evidence <text>] --confirm; activate <id> --receipt <file> --source-stopped --confirm',
        '  release-hold <hold-id> --task <task-id> --note <note> --confirm',
        'node cli.mjs backup <policy|create|verify|status|record-restore|prune> ...',
        'node cli.mjs recovery <restore|inspect|reconcile|authorize|preserve> ...',
        '  preserve --data-dir <dir> --note <note> --confirm',
        '',
        'Global: --data-dir <dir> --config <file>. Sensitive actions require an interactive TTY.',
        ''
      ].join('\n')
    );
    return 0;
  }

  if (command[0] === 'config' && command[1] === 'validate') {
    const config = await loadConfigFile(
      flags.config ? path.resolve(flags.config) : flags['data-dir'] ? path.join(path.resolve(flags['data-dir']), 'config.json') : null,
      { env: process.env }
    );
    print(stdout, { valid: true, config: redactConfig(config) });
    return 0;
  }

  if (command[0] === 'migration' && command[1] === 'import') {
    requireConfirm(flags, 'migration import');
    const verifier = io.humanVerifier || new TtyHumanVerifier();
    const proofService = new HumanProofService({ verifier });
    const from = path.resolve(flags.from);
    const dataDir = path.resolve(flags['data-dir'] || flags.to);
    const binding = { action: 'migration.import', from, dataDir };
    const principal = syntheticLocalOwner();
    const proof = await promptProofWithVerifier(verifier, binding, io);
    const { MigrationService } = await import('./src/migration.js');
    const service = new MigrationService({ humanProof: proofService });
    print(stdout, await service.importPackage({ from, dataDir }, { principal, proof }));
    return 0;
  }
  if (command[0] === 'recovery' && command[1] === 'restore') {
    requireConfirm(flags, 'recovery restore');
    const verifier = io.humanVerifier || new TtyHumanVerifier();
    const proofService = new HumanProofService({ verifier });
    const from = path.resolve(flags.from);
    const to = path.resolve(flags.to);
    const requestId = flags.request || `cli-${Date.now()}`;
    const binding = { action: 'recovery.restore', requestId, from, to };
    const principal = syntheticLocalOwner();
    const proof = await promptProofWithVerifier(verifier, binding, io);
    let restoreRecorder = null;
    if (flags['data-dir']) {
      const sourceDataDir = path.resolve(flags['data-dir']);
      const policyFile = path.join(sourceDataDir, 'backup-policy.json');
      try {
        await fsp.access(policyFile);
        const policyService = new BackupPolicyService({ file: policyFile, dataDir: sourceDataDir, now: () => new Date() });
        const indexService = new BackupService({ policyService, now: () => new Date(), logger: { warn: () => {} } });
        restoreRecorder = (info) => indexService.noteRestoreTest(info);
      } catch {
        restoreRecorder = null;
      }
    }
    const { RecoveryService: Recovery } = await import('./src/backup-recovery.js');
    const standalone = new Recovery({
      recoveryDir: path.join(to, 'recovery'),
      humanProof: proofService,
      restoreRecorder
    });
    print(stdout, await standalone.restore({ from, to, requestId }, { principal, proof }));
    return 0;
  }
  if (command[0] === 'recovery' && command[1] === 'preserve') {
    requireConfirm(flags, 'recovery preserve');
    const sourceDir = path.resolve(flags['data-dir'] || flags.dir || '.');
    const verifier = io.humanVerifier || new TtyHumanVerifier();
    const proofService = new HumanProofService({ verifier });
    const binding = { action: 'recovery.preserve', dataDir: sourceDir };
    const principal = syntheticLocalOwner();
    const proof = await promptProofWithVerifier(verifier, binding, io);
    const { RecoveryService: Recovery } = await import('./src/backup-recovery.js');
    const standalone = new Recovery({
      recoveryDir: path.join(sourceDir, 'recovery'),
      humanProof: proofService
    });
    if (typeof standalone.preserveCorruptSource !== 'function') throw waitingFor('RecoveryService.preserveCorruptSource');
    print(stdout, await standalone.preserveCorruptSource({ dataDir: sourceDir, note: flags.note || '' }, { principal, proof }));
    return 0;
  }

  const runtime = await runtimeFactory({
    dataDir: flags['data-dir'] ? path.resolve(flags['data-dir']) : null,
    configFile: flags.config ? path.resolve(flags.config) : null,
    humanVerifier: new TtyHumanVerifier(),
    logger: { warn: (message, meta) => stderr.write(`${message} ${JSON.stringify(meta || {})}\n`), info: () => {} }
  });
  const principal = await localOwner(runtime);
  try {
    if (command[0] === 'status') {
      print(stdout, await runtime.status(principal));
      return 0;
    }
    if (command[0] === 'config' && command[1] === 'update') {
      requireConfirm(flags, 'config update');
      const patch = await readJsonArg(flags.file);
      await humanContext(runtime, { action: 'config.update', patchHash: jcsHash(patch) }, { verifyNow: true, io });
      const previous = runtime.configService.get();
      const updated = await runtime.configService.update(patch, { source: 'cli' });
      if (typeof runtime.awaitConfigRefresh === 'function') await runtime.awaitConfigRefresh();
      else await runtime.refreshConfig?.({ config: runtime.configService.get(), previous });
      print(stdout, { updated: true, config: updated });
      return 0;
    }
    if (command[0] === 'account' && command[1] === 'verify') {
      const result = await runtime.bindAccount({ principal });
      print(stdout, result);
      return 0;
    }
    if (command[0] === 'account' && command[1] === 'resume') {
      requireConfirm(flags, 'account resume');
      const platform = flags.platform || 'bilibili';
      if (platform !== 'bilibili') throw new CliUsageError('only the bilibili platform is supported');
      const note = flags.note || '';
      const context = await humanContext(runtime, { action: 'account.resume', platform, note }, { verifyNow: true, io });
      const clear = runtime.rateLimiter?.clearAuthPause || runtime.credentials?.clearAuthPause;
      if (typeof clear !== 'function') throw waitingFor('clearAuthPause');
      const state = await runtime.store.getSnapshot();
      if (!state.activeAccountRef) throw new AppError('CREDENTIAL_MISSING', 'no active account is bound');
      const key = `${state.activeAccountRef.platform}:${state.activeAccountRef.accountId}`;
      const result = await runtime.store.transaction(async (draft, tx) => {
        const cleared = await clear.call(runtime.rateLimiter || runtime.credentials, tx, key, {
          note,
          actor: context.principal.id,
          principalId: context.principal.id
        });
        return {
          resumed: true,
          accountRef: draft.activeAccountRef,
          cleared: cleared?.cleared === true
        };
      });
      print(stdout, result);
      return 0;
    }
    if (command[0] === 'browse') {
      const mode = modeFrom(flags, { required: true });
      print(stdout, await dispatch(runtime, principal, 'browse.run', {}, mode));
      return 0;
    }
    if (command[0] === 'diary') {
      if (!flags.date) throw new CliUsageError('--date is required');
      const state = await runtime.store.getSnapshot();
      print(stdout, await dispatch(runtime, principal, 'diary.generate', {
        date: flags.date,
        scope: flags.scope || `workspace/${state.workspaceId}`,
        book: flags.book || null,
        force: flags.force === true
      }, 'go'));
      return 0;
    }
    if (command[0] === 'comment' && flags.draft) {
      const draft = await readJsonArg(flags.draft);
      const candidate = draft.candidate || draft;
      print(stdout, await dispatch(runtime, principal, 'comment.draft', {
        contentRef: candidate.contentRef,
        title: candidate.title,
        author: candidate.author || null,
        text: draft.text || null,
        root: draft.root || candidate.root || 0,
        parent: draft.parent || candidate.parent || 0
      }, 'dry'));
      return 0;
    }
    if (command[0] === 'approval' && command[1] === 'decide') {
      const approvalId = command[2];
      const decision = command[3];
      if (!approvalId || !['approve', 'reject'].includes(decision)) {
        throw new CliUsageError('usage: approval decide <approval-id> approve|reject');
      }
      requireConfirm(flags, 'approval decide');
      const mode = modeFrom(flags, { required: true });
      if (mode === 'dry') {
        const result = await runtime.approvalService.decide(
          { approvalId, decision, nonce: '', mode: 'dry' },
          null
        );
        print(stdout, result);
        return 0;
      }
      const state = await runtime.store.getSnapshot();
      const approval = state.approvals[approvalId];
      if (!approval) throw new AppError('APPROVAL_STALE', 'approval not found');
      const context = await humanContext(runtime, approvalProofBinding(approval), { io });
      print(stdout, await dispatch(runtime, context.principal, 'approval.decide', {
        approvalId,
        decision,
        nonce: flags.nonce
      }, mode, { humanContext: context }));
      return 0;
    }
    if (command[0] === 'dm') {
      const mode = modeFrom(flags, { required: true });
      if (mode === 'go') await humanContext(runtime, { action: 'dm.send', to: flags.to, text: flags.text }, { verifyNow: true, io });
      print(stdout, await dispatch(runtime, principal, 'dm.send', {
        recipientMid: flags.to,
        text: flags.text,
        mode
      }, mode));
      return 0;
    }
    if (command[0] === 'artifact' && command[1] === 'import') {
      requireConfirm(flags, 'artifact import');
      const role = flags.role;
      const context = await humanContext(runtime, { action: 'artifact.import', file: flags.file, role }, { verifyNow: true, io });
      print(stdout, await runtime.artifactStore.importFile({
        sourcePath: path.resolve(flags.file),
        role,
        principal: context.principal
      }));
      return 0;
    }
    if (command[0] === 'production') {
      const mode = modeFrom(flags, { required: true });
      const job = await readJsonArg(flags.job);
      print(stdout, await dispatch(runtime, principal, 'production.create', { ...job }, mode));
      return 0;
    }
    if (command[0] === 'publish' && command[1] === 'complete') {
      requireConfirm(flags, 'publish complete');
      const taskId = command[2];
      const state = await runtime.store.getSnapshot();
      const task = state.tasks[taskId];
      if (!task || task.kind !== 'publish') throw new AppError('FORBIDDEN', 'publish task not found');
      const context = await humanContext(runtime, {
        action: 'publish.complete',
        taskId,
        inputHash: task.inputHash,
        bvid: String(flags.bvid),
        note: truncateText(flags.note || '', 500)
      }, { io });
      print(stdout, await runtime.publisher.complete(
        { taskId, bvid: flags.bvid, url: flags.url || null, note: flags.note || '' },
        context
      ));
      return 0;
    }
    if (command[0] === 'publish' && command[1] === 'void') {
      requireConfirm(flags, 'publish void');
      const taskId = command[2];
      if (!taskId) throw new CliUsageError('usage: publish void <task-id> --reason <text> --confirm');
      if (typeof runtime.publisher?.markNotPublished !== 'function') throw waitingFor('PublisherModule.markNotPublished');
      const state = await runtime.store.getSnapshot();
      const task = state.tasks[taskId];
      if (!task || task.kind !== 'publish') throw new AppError('FORBIDDEN', 'publish task not found');
      const reason = truncateText(flags.reason || '', 500);
      const note = truncateText(flags.note || '', 500);
      const context = await humanContext(runtime, {
        action: 'publish.void',
        taskId,
        inputHash: task.inputHash,
        reason,
        note
      }, { io });
      print(stdout, await runtime.publisher.markNotPublished(
        { taskId, reason, note },
        context
      ));
      return 0;
    }
    if (command[0] === 'publish') {
      const mode = modeFrom(flags, { required: true });
      const job = await readJsonArg(flags.job);
      print(stdout, await dispatch(runtime, principal, 'publish.create', { ...job }, mode));
      return 0;
    }
    if (command[0] === 'task' && command[1] === 'get') {
      print(stdout, await runtime.commandService.getTask(command[2], principal));
      return 0;
    }
    if (command[0] === 'task' && command[1] === 'cancel') {
      requireConfirm(flags, 'task cancel');
      await humanContext(runtime, { action: 'task.cancel', taskId: command[2] }, { verifyNow: true, io });
      print(stdout, await dispatch(runtime, principal, 'task.cancel', { taskId: command[2] }, 'dry'));
      return 0;
    }
    if (command[0] === 'task' && command[1] === 'resume') {
      requireConfirm(flags, 'task resume');
      const mode = modeFrom(flags, { required: true });
      const context = await humanContext(runtime, { action: 'task.resume', taskId: command[2], mode }, { verifyNow: true, io });
      print(stdout, await dispatch(runtime, context.principal, 'task.resume', { taskId: command[2] }, mode, {
        humanContext: context
      }));
      return 0;
    }
    if (command[0] === 'operation' && command[1] === 'resolve') {
      const operationId = command[2];
      const decision = command[3];
      if (!['confirmed', 'not_sent'].includes(decision)) throw new CliUsageError('decision must be confirmed or not_sent');
      requireConfirm(flags, 'operation resolve');
      const state = await runtime.store.getSnapshot();
      const operation = state.operations[operationId];
      if (!operation) throw new AppError('FORBIDDEN', 'operation not found');
      const evidenceRef = flags['evidence-ref'] ? String(flags['evidence-ref']) : null;
      const context = await humanContext(runtime, {
        action: 'operation.resolve',
        operationId,
        decision,
        businessKey: operation.businessKey,
        inputHash: operation.inputHash,
        evidenceRef
      }, { io });
      let receipt = null;
      if (flags.receipt) receipt = await readJsonArg(flags.receipt);
      print(stdout, await runtime.effectGateway.resolve(
        { operationId, decision, receipt, note: flags.note || '', evidenceRef },
        context
      ));
      return 0;
    }
    if (command[0] === 'operation' && command[1] === 'cancel') {
      requireConfirm(flags, 'operation cancel');
      const operationId = command[2];
      if (!operationId) throw new CliUsageError('usage: operation cancel <operation-id> --reason <text> --confirm');
      if (typeof runtime.effectGateway?.cancelOperation !== 'function') throw waitingFor('EffectGateway.cancelOperation');
      const state = await runtime.store.getSnapshot();
      const operation = state.operations[operationId];
      if (!operation) throw new AppError('FORBIDDEN', 'operation not found');
      let evidence = null;
      if (flags.evidence) evidence = await readJsonArg(flags.evidence);
      if (evidence === null && flags.reason) evidence = flags.reason;
      const normalizedEvidence = normalizeCancellationEvidence(evidence);
      if (!normalizedEvidence) {
        throw new CliUsageError('operation cancel requires --reason or --evidence proving the operation was not dispatched');
      }
      const context = await humanContext(runtime, {
        action: 'operation.cancel',
        operationId,
        businessKey: operation.businessKey,
        inputHash: operation.inputHash,
        reason: truncateText(flags.reason || '', 300),
        evidence: normalizedEvidence.provenance
      }, { io });
      print(stdout, await runtime.effectGateway.cancelOperation(
        { operationId, reason: flags.reason || '', evidence },
        context
      ));
      return 0;
    }
    if (command[0] === 'outbox' && command[1] === 'resolve') {
      requireConfirm(flags, 'outbox resolve');
      const notificationId = command[2];
      const decision = command[3];
      if (!['confirmed', 'not_sent'].includes(decision)) throw new CliUsageError('decision must be confirmed or not_sent');
      const state = await runtime.store.getSnapshot();
      const notification = state.outbox[notificationId];
      if (!notification) throw new AppError('FORBIDDEN', 'notification not found');
      const context = await humanContext(runtime, {
        action: 'outbox.resolve',
        notificationId,
        decision,
        payloadHash: notification.payloadHash
      }, { io });
      let receipt = null;
      if (flags.receipt) receipt = await readJsonArg(flags.receipt);
      print(stdout, await runtime.effectGateway.resolveNotification(
        { notificationId, decision, receipt, note: flags.note || '' },
        context
      ));
      return 0;
    }
    if (command[0] === 'im' && command[1] === 'bind') {
      requireConfirm(flags, 'im bind');
      const binding = await readJsonArg(flags.file);
      const context = await humanContext(runtime, { action: 'im.bind', bindingHash: jcsHash(binding) }, { verifyNow: true, io });
      print(stdout, await runtime.store.transaction(async (draft, tx) =>
        runtime.identity.bindIm(tx, { ...binding, principalId: binding.principalId || context.principal.id })));
      return 0;
    }
    if (command[0] === 'im' && command[1] === 'revoke') {
      requireConfirm(flags, 'im revoke');
      await humanContext(runtime, { action: 'im.revoke', bindingId: command[2] }, { verifyNow: true, io });
      print(stdout, await runtime.store.transaction(async (draft, tx) => runtime.identity.revokeIm(tx, command[2])));
      await runtime.effectGateway.suppressNotificationsForBinding(command[2]);
      return 0;
    }
    if (command[0] === 'migration') {
      const sub = command[1];
      const migrationId = command[2];
      if (sub === 'status') {
        if (!runtime.migration) throw waitingFor('MigrationService');
        print(stdout, await runtime.migration.status());
        return 0;
      }
      if (sub === 'release-hold') {
        requireConfirm(flags, 'migration release-hold');
        const holdId = command[2];
        if (!holdId) throw new CliUsageError('usage: migration release-hold <hold-id> --task <task-id> --note <note> --confirm');
        if (!runtime.migration) throw waitingFor('MigrationService');
        if (typeof runtime.migration.releaseTaskHold !== 'function') throw waitingFor('MigrationService.releaseTaskHold');
        const context = await humanContext(runtime, {
          action: 'migration.release-hold',
          holdId,
          taskId: flags.task || null
        }, { io });
        print(stdout, await runtime.migration.releaseTaskHold(
          { holdId, taskId: flags.task || null, note: flags.note || '' },
          context
        ));
        return 0;
      }
      const CONFIRMED_SUBS = new Set(['prepare', 'release', 'activate', 'abort', 'disable-target', 'rollback']);
      if (CONFIRMED_SUBS.has(sub)) requireConfirm(flags, `migration ${sub}`);
      if (!runtime.migration) throw waitingFor('MigrationService');
      const activateReceipt = sub === 'activate' ? await readJsonArg(flags.receipt) : null;
      const preparePayload = { targetInstanceId: flags.target, executorStopEvidence: flags['executor-stop-evidence'] || null };
      const activatePayload = {
        migrationId,
        receipt: activateReceipt,
        dataDir: path.resolve(flags['data-dir']),
        sourceStopped: flags['source-stopped'] === true
      };
      const disablePayload = {
        migrationId,
        targetDataDir: flags['target-data-dir'] || null,
        targetStopped: flags['target-stopped'] === true,
        targetStopEvidence: flags['target-stop-evidence'] || null
      };
      const rollbackPayload = {
        migrationId,
        targetDataDir: flags['target-data-dir'] || null,
        to: flags.to || null
      };
      const importPayload = {
        from: path.resolve(flags.from),
        dataDir: path.resolve(flags['data-dir'] || flags.to)
      };
      const bindingBySub = {
        prepare: { action: 'migration.prepare', targetInstanceId: preparePayload.targetInstanceId },
        export: { action: 'migration.export', migrationId },
        release: { action: 'migration.release', migrationId },
        import: { action: 'migration.import', from: importPayload.from, dataDir: importPayload.dataDir },
        validate: { action: 'migration.validate', migrationId },
        activate: {
          action: 'migration.activate',
          migrationId,
          snapshotHash: activateReceipt?.snapshotHash,
          sourceStopped: true
        },
        abort: { action: 'migration.abort', migrationId },
        'disable-target': { action: 'migration.disable-target', migrationId },
        rollback: { action: 'migration.rollback', ...rollbackPayload }
      };
      if (!bindingBySub[sub]) throw new CliUsageError('unknown migration subcommand');
      const context = await humanContext(runtime, bindingBySub[sub], { io });
      if (sub === 'prepare') {
        print(stdout, await runtime.migration.prepare(preparePayload, context));
      } else if (sub === 'export') {
        print(stdout, await runtime.migration.export({ migrationId, out: flags.out || null }, context));
      } else if (sub === 'release') {
        print(stdout, await runtime.migration.release({ migrationId }, context));
      } else if (sub === 'import') {
        print(stdout, await runtime.migration.importPackage(importPayload, context));
      } else if (sub === 'validate') {
        print(stdout, await runtime.migration.validate({ migrationId, dataDir: path.resolve(flags['data-dir']) }, context));
      } else if (sub === 'activate') {
        print(stdout, await runtime.migration.activate(activatePayload, context));
      } else if (sub === 'abort') {
        print(stdout, await runtime.migration.abort({ migrationId }, context));
      } else if (sub === 'disable-target') {
        print(stdout, await runtime.migration.disableTarget(disablePayload, context));
      } else if (sub === 'rollback') {
        print(stdout, await runtime.migration.rollback(rollbackPayload, context));
      }
      return 0;
    }
    if (command[0] === 'backup') {
      const sub = command[1];
      if (sub === 'status') {
        print(stdout, {
          service: await runtime.backupService.status(),
          scheduler: await runtime.backupScheduler.status()
        });
        return 0;
      }
      if (sub === 'verify') {
        print(stdout, await runtime.backupService.verify(command[2]));
        return 0;
      }
      if (sub === 'policy') {
        requireConfirm(flags, 'backup policy');
        const policy = await readJsonArg(flags.file);
        await humanContext(runtime, { action: 'backup.policy', policyHash: jcsHash(policy) }, { verifyNow: true, io });
        print(stdout, await runtime.policyService.save(policy));
        return 0;
      }
      if (sub === 'record-restore') {
        if (!command[2]) {
          throw new CliUsageError('backup record-restore <backup-id> --recovery <id> --target-instance <id> --new-epoch <epoch> --confirm');
        }
        requireConfirm(flags, 'backup record-restore');
        const context = await humanContext(
          runtime,
          { action: 'backup.record-restore', backupId: command[2], recoveryId: flags.recovery },
          { io }
        );
        print(stdout, await runtime.backupService.recordRestoreTest(
          {
            backupId: command[2],
            recoveryId: flags.recovery,
            targetInstanceId: flags['target-instance'] || null,
            newHistoryEpoch: flags['new-epoch'] || null,
            restoredAt: flags['restored-at'] || null
          },
          context
        ));
        return 0;
      }
      if (sub === 'create') {
        requireConfirm(flags, 'backup create');
        const kind = flags.kind || 'ledger';
        const requestId = flags.request || `cli-${Date.now()}`;
        const context = await humanContext(runtime, { action: 'backup.create', kind, requestId }, { io });
        print(stdout, await runtime.backupService.create({ kind, requestId }, context));
        return 0;
      }
      if (sub === 'prune') {
        if (flags.dry) {
          print(stdout, await runtime.backupService.planPrune());
          return 0;
        }
        if (!flags.plan) throw new CliUsageError('backup prune requires --plan <id> --confirm');
        requireConfirm(flags, 'backup prune');
        const context = await humanContext(runtime, { action: 'backup.prune', planId: flags.plan }, { io });
        print(stdout, await runtime.backupService.prune({ planId: flags.plan }, context));
        return 0;
      }
      throw new CliUsageError('unknown backup subcommand');
    }
    if (command[0] === 'recovery') {
      const sub = command[1];
      if (sub === 'restore' || sub === 'preserve') {
        throw new CliUsageError(`recovery ${sub} is handled before runtime initialization`);
      }
      if (sub === 'inspect') {
        print(stdout, await runtime.recovery.inspect(flags.id || command[2] || null));
        return 0;
      }
      if (sub === 'reconcile') {
        requireConfirm(flags, 'recovery reconcile');
        const evidence = await readJsonArg(flags.evidence);
        const recoveryId = flags.id || command[2] || null;
        const context = await humanContext(runtime, {
          action: 'recovery.reconcile',
          recoveryId,
          evidenceHash: jcsHash(evidence)
        }, { io });
        print(stdout, await runtime.recovery.reconcile({ recoveryId, evidence }, context));
        return 0;
      }
      if (sub === 'authorize') {
        requireConfirm(flags, 'recovery authorize');
        const scope = JSON.parse(flags.scope);
        const recoveryId = flags.id || command[2] || null;
        const context = await humanContext(runtime, {
          action: 'recovery.authorize',
          recoveryId,
          scope: jcsHash(scope),
          evidenceId: flags.evidence || null
        }, { io });
        print(stdout, await runtime.recovery.authorize({ recoveryId, scope, evidenceId: flags.evidence }, context));
        return 0;
      }
      throw new CliUsageError('unknown recovery subcommand');
    }
    throw new CliUsageError(`unknown command: ${command.join(' ')}`);
  } finally {
    await runtime.close();
  }
}

function syntheticLocalOwner() {
  return {
    id: 'local_cli_owner',
    kind: 'human',
    role: 'owner',
    sourceKind: 'local_cli',
    scopes: ['*'],
    revokedAt: null,
    displayName: 'local CLI owner'
  };
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      const parsed = error instanceof AppError
        ? error.toJSON()
        : { code: 'DEPENDENCY_UNAVAILABLE', message: error.message };
      parsed.message = sanitizeErrorMessage(parsed.message);
      process.stderr.write(`${JSON.stringify(parsed, null, 2)}\n`);
      if (error?.usage) process.stderr.write('\nRun with --help for usage.\n');
      process.exitCode = 1;
    }
  );
}
