#!/usr/bin/env node
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { AppError } from './src/errors.js';
import { createRuntime, HTTP_PREFIX } from './src/index.js';
import { loadConfigFile, redactConfig } from './src/config.js';
import { BackupPolicyService, BackupService, RecoveryService } from './src/backup-recovery.js';
import { HumanProofService, TtyHumanVerifier } from './src/identity.js';
import { jcsHash } from './src/utils.js';

class CliUsageError extends AppError {
  constructor(message) {
    super('CONFIG_INVALID', message);
    this.usage = true;
  }
}

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
      if (['dry', 'go', 'confirm', 'force', 'json'].includes(name)) {
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

async function readJsonArg(file) {
  if (!file) throw new CliUsageError('--file or --job is required');
  try {
    return JSON.parse(await fsp.readFile(path.resolve(file), 'utf8'));
  } catch (error) {
    throw new AppError('CONFIG_INVALID', `cannot read JSON file: ${error.message}`);
  }
}

async function ownerPrincipal(runtime) {
  return runtime.store.transaction(async (draft, tx) => runtime.identity.ensureLocalOwner(tx));
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

async function promptProofWithVerifier(verifier, binding) {
  if (!verifier || typeof verifier.issue !== 'function' || !process.stdin.isTTY) {
    throw new AppError('TRUST_UNAVAILABLE', 'interactive TTY human proof is unavailable');
  }
  const challenge = verifier.issue(binding);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('Type the one-time phrase: ');
    return { challengeId: challenge.challengeId, response: answer };
  } finally {
    rl.close();
  }
}

async function promptHumanProof(runtime, binding) {
  return promptProofWithVerifier(runtime.humanProof.verifier, binding);
}

async function humanContext(runtime, binding, { verifyNow = false } = {}) {
  const principal = await ownerPrincipal(runtime);
  const proof = await promptHumanProof(runtime, binding);
  const context = { principal, proof };
  if (verifyNow) await runtime.humanProof.assert(context, binding);
  return context;
}

function print(json, value) {
  json.write(`${JSON.stringify(value, null, 2)}\n`);
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const { command, flags } = parseArgs(argv);
  if (command.length === 0 || flags.help) {
    stdout.write(
      [
        'dsh-bili-unified CLI',
        '',
        'node cli.mjs status | config validate | config update --file <json> --confirm',
        'node cli.mjs account verify | browse --dry|--go | diary --date <date> --scope <scope> [--force]',
        'node cli.mjs comment --draft <json> | approval decide <id> approve|reject --confirm --dry|--go',
        'node cli.mjs dm --to <mid> --text <text> --dry|--go',
        'node cli.mjs artifact import --file <path> --role <role> --confirm',
        'node cli.mjs production --job <json> --dry|--go | publish --job <json> --dry|--go',
        'node cli.mjs task get <id> | task cancel <id> --confirm --dry|--go | task resume <id> --confirm --dry|--go',
        'node cli.mjs publish complete <id> --bvid <bv> --confirm --note <note>',
        'node cli.mjs operation resolve <id> confirmed|not_sent --receipt <json> --note <note> --confirm',
        'node cli.mjs outbox resolve <id> confirmed|not_sent --receipt <json> --note <note> --confirm',
        'node cli.mjs im bind --file <json> --confirm | im revoke <binding-id> --confirm',
        'node cli.mjs migration <prepare|export|release|import|validate|activate|status|abort|disable-target|rollback> ...',
        '  disable-target <id> --target-data-dir <dir> --target-stopped --target-stop-evidence <text> --confirm; rollback <id> --target-data-dir <dir> --to <empty-dir> --confirm',
        'node cli.mjs backup <policy|create|verify|status|record-restore|prune> ...',
        '  record-restore <backup-id> --recovery <id> --target-instance <id> --new-epoch <epoch> --confirm',
        'node cli.mjs recovery <restore|inspect|reconcile|authorize> ...',
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
    if (flags.confirm !== true && flags.go !== true) throw new CliUsageError('migration import requires --confirm');
    const verifier = new TtyHumanVerifier();
    const proofService = new HumanProofService({ verifier });
    const from = path.resolve(flags.from);
    const dataDir = path.resolve(flags['data-dir'] || flags.to);
    const binding = { action: 'migration.import', from, dataDir };
    const principal = syntheticLocalOwner();
    const proof = await promptProofWithVerifier(verifier, binding);
    const { MigrationService } = await import('./src/migration.js');
    const service = new MigrationService({ humanProof: proofService });
    print(stdout, await service.importPackage(
      { from, dataDir },
      { principal, proof }
    ));
    return 0;
  }
  if (command[0] === 'recovery' && command[1] === 'restore') {
    if (flags.confirm !== true) throw new CliUsageError('recovery restore requires --confirm');
    const verifier = new TtyHumanVerifier();
    const proofService = new HumanProofService({ verifier });
    const from = path.resolve(flags.from);
    const to = path.resolve(flags.to);
    const requestId = flags.request || `cli-${Date.now()}`;
    const binding = { action: 'recovery.restore', requestId, from, to };
    const principal = syntheticLocalOwner();
    const proof = await promptProofWithVerifier(verifier, binding);
    let restoreRecorder = null;
    if (flags['data-dir']) {
      const sourceDataDir = path.resolve(flags['data-dir']);
      const policyFile = path.join(sourceDataDir, 'backup-policy.json');
      try {
        await fsp.access(policyFile);
        const policyService = new BackupPolicyService({
          file: policyFile,
          dataDir: sourceDataDir,
          now: () => new Date()
        });
        const indexService = new BackupService({
          policyService,
          now: () => new Date(),
          logger: { warn: () => {} }
        });
        restoreRecorder = (info) => indexService.noteRestoreTest(info);
      } catch {
        restoreRecorder = null;
      }
    }
    const standalone = new RecoveryService({
      recoveryDir: path.join(to, 'recovery'),
      humanProof: proofService,
      restoreRecorder
    });
    print(stdout, await standalone.restore(
      { from, to, requestId },
      { principal, proof }
    ));
    return 0;
  }

  const runtime = await createRuntime({
    dataDir: flags['data-dir'] ? path.resolve(flags['data-dir']) : null,
    configFile: flags.config ? path.resolve(flags.config) : null,
    humanVerifier: new TtyHumanVerifier(),
    logger: { warn: (message, meta) => stderr.write(`${message} ${JSON.stringify(meta || {})}\n`), info: () => {} }
  });
  const principal = await ownerPrincipal(runtime);
  try {
    if (command[0] === 'status') {
      print(stdout, await runtime.status(principal));
      return 0;
    }
    if (command[0] === 'config' && command[1] === 'update') {
      const patch = await readJsonArg(flags.file);
      await humanContext(runtime, { action: 'config.update', patchHash: jcsHash(patch) }, { verifyNow: true });
      const updated = await runtime.configService.update(patch, { source: 'cli' });
      print(stdout, { updated: true, config: updated });
      return 0;
    }
    if (command[0] === 'account' && command[1] === 'verify') {
      const result = await runtime.bindAccount({ principal });
      print(stdout, result);
      return 0;
    }
    if (command[0] === 'browse') {
      const mode = modeFrom(flags, { required: true });
      const result = await runtime.commandService.execute(
        { schemaVersion: 1, requestId: `cli-${Date.now()}`, action: 'browse.run', input: {}, mode },
        principal,
        { trusted: true, sourceKind: 'http' }
      );
      print(stdout, result);
      return 0;
    }
    if (command[0] === 'diary') {
      if (!flags.date) throw new CliUsageError('--date is required');
      const result = await runtime.diary.generate({
        date: flags.date,
        scope: flags.scope || `workspace/${(await runtime.store.getSnapshot()).workspaceId}`,
        book: flags.book || null,
        force: flags.force === true,
        principal
      });
      print(stdout, { ...result, content: undefined });
      return 0;
    }
    if (command[0] === 'comment' && flags.draft) {
      const draft = await readJsonArg(flags.draft);
      const result = await runtime.comments.createDraft({
        candidate: draft.candidate,
        text: draft.text || null,
        principal,
        trigger: 'manual'
      });
      print(stdout, result);
      return 0;
    }
    if (command[0] === 'approval' && command[1] === 'decide') {
      const approvalId = command[2];
      const decision = command[3];
      if (!approvalId || !['approve', 'reject'].includes(decision)) {
        throw new CliUsageError('usage: approval decide <approval-id> approve|reject');
      }
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
      const context = await humanContext(runtime, {
        approvalId,
        taskId: approval.taskId,
        action: approval.action,
        inputHash: approval.inputHash,
        taskRevision: approval.taskRevision
      });
      const result = await runtime.approvalService.decide(
        { approvalId, decision, nonce: flags.nonce, mode: 'go' },
        context
      );
      if (decision === 'approve' && result.task?.kind === 'comment' && result.task.status === 'running') {
        const sent = await runtime.comments.send({ taskId: result.task.id, mode: 'go', principal });
        print(stdout, { ...result, send: sent });
      } else {
        print(stdout, result);
      }
      return 0;
    }
    if (command[0] === 'dm') {
      const mode = modeFrom(flags, { required: true });
      if (mode === 'go') await humanContext(runtime, { action: 'dm.send', to: flags.to }, { verifyNow: true });
      const result = await runtime.directMessages.send({
        recipientMid: flags.to,
        text: flags.text,
        mode,
        principal,
        trigger: 'manual'
      });
      print(stdout, result);
      return 0;
    }
    if (command[0] === 'artifact' && command[1] === 'import') {
      if (flags.confirm !== true) throw new CliUsageError('artifact import requires --confirm');
      const role = flags.role;
      const context = await humanContext(runtime, { action: 'artifact.import', file: flags.file, role }, { verifyNow: true });
      const result = await runtime.artifactStore.importFile({
        sourcePath: path.resolve(flags.file),
        role,
        principal: context.principal
      });
      print(stdout, result);
      return 0;
    }
    if (command[0] === 'production') {
      const mode = modeFrom(flags, { required: true });
      const job = await readJsonArg(flags.job);
      const result = await runtime.production.create({ ...job, mode }, principal);
      print(stdout, result);
      return 0;
    }
    if (command[0] === 'publish' && command[1] === 'complete') {
      if (flags.confirm !== true) throw new CliUsageError('publish complete requires --confirm');
      const taskId = command[2];
      const context = await humanContext(runtime, {
        action: 'publish.complete',
        taskId,
        bvid: flags.bvid
      });
      const result = await runtime.publisher.complete(
        { taskId, bvid: flags.bvid, url: flags.url || null, note: flags.note || '' },
        context
      );
      print(stdout, result);
      return 0;
    }
    if (command[0] === 'publish') {
      const mode = modeFrom(flags, { required: true });
      const job = await readJsonArg(flags.job);
      const result = await runtime.publisher.create({ ...job, mode }, principal);
      print(stdout, result);
      return 0;
    }
    if (command[0] === 'task' && command[1] === 'get') {
      print(stdout, await runtime.commandService.getTask(command[2], principal));
      return 0;
    }
    if (command[0] === 'task' && command[1] === 'cancel') {
      if (flags.confirm !== true) throw new CliUsageError('task cancel requires --confirm');
      await humanContext(runtime, { action: 'task.cancel', taskId: command[2] }, { verifyNow: true });
      print(stdout, await runtime.commandService.cancelTask(command[2], principal));
      return 0;
    }
    if (command[0] === 'task' && command[1] === 'resume') {
      if (flags.confirm !== true) throw new CliUsageError('task resume requires --confirm');
      const mode = modeFrom(flags, { required: true });
      const context = await humanContext(runtime, { action: 'task.resume', taskId: command[2], mode }, { verifyNow: true });
      const state = await runtime.store.getSnapshot();
      const task = state.tasks[command[2]];
      if (!task) throw new AppError('FORBIDDEN', 'task not found');
      if (task.kind === 'production') {
        print(stdout, await runtime.production.resume({ taskId: command[2], mode, principal: context.principal }));
        return 0;
      }
      if (task.kind === 'comment') {
        print(stdout, await runtime.comments.resume({ taskId: command[2], mode, principal: context.principal }));
        return 0;
      }
      if (task.kind === 'dm') {
        print(stdout, await runtime.directMessages.resume({ taskId: command[2], mode, principal: context.principal }));
        return 0;
      }
      throw new AppError('CAPABILITY_UNSUPPORTED', `task kind ${task.kind} has no resume path`);
    }
    if (command[0] === 'operation' && command[1] === 'resolve') {
      const operationId = command[2];
      const decision = command[3];
      if (!['confirmed', 'not_sent'].includes(decision)) throw new CliUsageError('decision must be confirmed or not_sent');
      const note = flags.note || '';
      if (flags.confirm !== true) throw new CliUsageError('operation resolve requires --confirm');
      const context = await humanContext(runtime, { action: 'operation.resolve', operationId, decision });
      let receipt = null;
      if (flags.receipt) receipt = await readJsonArg(flags.receipt);
      print(stdout, await runtime.effectGateway.resolve({ operationId, decision, receipt, note }, context));
      return 0;
    }
    if (command[0] === 'outbox' && command[1] === 'resolve') {
      if (flags.confirm !== true) throw new CliUsageError('outbox resolve requires --confirm');
      const notificationId = command[2];
      const decision = command[3];
      if (!['confirmed', 'not_sent'].includes(decision)) throw new CliUsageError('decision must be confirmed or not_sent');
      const context = await humanContext(runtime, { action: 'outbox.resolve', notificationId, decision });
      let receipt = null;
      if (flags.receipt) receipt = await readJsonArg(flags.receipt);
      print(stdout, await runtime.effectGateway.resolveNotification(
        { notificationId, decision, receipt, note: flags.note || '' },
        context
      ));
      return 0;
    }
    if (command[0] === 'im' && command[1] === 'bind') {
      if (flags.confirm !== true) throw new CliUsageError('im bind requires --confirm');
      const binding = await readJsonArg(flags.file);
      const context = await humanContext(runtime, { action: 'im.bind', bindingHash: jcsHash(binding) }, { verifyNow: true });
      const result = await runtime.store.transaction(async (draft, tx) =>
        runtime.identity.bindIm(tx, { ...binding, principalId: binding.principalId || context.principal.id })
      );
      print(stdout, result);
      return 0;
    }
    if (command[0] === 'im' && command[1] === 'revoke') {
      if (flags.confirm !== true) throw new CliUsageError('im revoke requires --confirm');
      await humanContext(runtime, { action: 'im.revoke', bindingId: command[2] }, { verifyNow: true });
      const result = await runtime.store.transaction(async (draft, tx) => runtime.identity.revokeIm(tx, command[2]));
      await runtime.effectGateway.suppressNotificationsForBinding(command[2]);
      print(stdout, result);
      return 0;
    }
    if (command[0] === 'migration') {
      const sub = command[1];
      const migrationId = command[2];
      if (sub === 'status') {
        print(stdout, await runtime.migration.status());
        return 0;
      }
      const activateReceipt = sub === 'activate' ? await readJsonArg(flags.receipt) : null;
      const context = await humanContext(
        runtime,
        sub === 'rollback'
          ? {
              action: 'migration.rollback',
              migrationId,
              targetDataDir: flags['target-data-dir'] || null,
              to: flags.to || null
            }
          : sub === 'prepare'
            ? { action: 'migration.prepare', targetInstanceId: flags.target }
            : sub === 'activate'
              ? { action: 'migration.activate', migrationId, snapshotHash: activateReceipt?.snapshotHash }
              : { action: `migration.${sub}`, migrationId },
        { verifyNow: false }
      );
      if (sub === 'prepare') {
        print(stdout, await runtime.migration.prepare({ targetInstanceId: flags.target }, context));
      } else if (sub === 'export') {
        print(stdout, await runtime.migration.export({ migrationId, out: flags.out || null }, context));
      } else if (sub === 'release') {
        print(stdout, await runtime.migration.release({ migrationId }, context));
      } else if (sub === 'import') {
        print(stdout, await runtime.migration.importPackage({ from: path.resolve(flags.from), dataDir: path.resolve(flags['data-dir'] || flags.to) }, context));
      } else if (sub === 'validate') {
        print(stdout, await runtime.migration.validate({ migrationId, dataDir: path.resolve(flags['data-dir']) }, context));
      } else if (sub === 'activate') {
        print(stdout, await runtime.migration.activate(
          { migrationId, receipt: activateReceipt, dataDir: path.resolve(flags['data-dir']) },
          context
        ));
      } else if (sub === 'abort') {
        print(stdout, await runtime.migration.abort({ migrationId }, context));
      } else if (sub === 'disable-target') {
        print(stdout, await runtime.migration.disableTarget(
          {
            migrationId,
            targetDataDir: flags['target-data-dir'] || null,
            targetStopped: flags['target-stopped'] === true,
            targetStopEvidence: flags['target-stop-evidence'] || null
          },
          context
        ));
      } else if (sub === 'rollback') {
        print(stdout, await runtime.migration.rollback({ migrationId, targetDataDir: flags['target-data-dir'], to: flags.to || null }, context));
      } else {
        throw new CliUsageError('unknown migration subcommand');
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
        if (flags.confirm !== true) throw new CliUsageError('backup policy requires --confirm');
        const policy = await readJsonArg(flags.file);
        await humanContext(runtime, { action: 'backup.policy', policyHash: jcsHash(policy) }, { verifyNow: true });
        print(stdout, await runtime.policyService.save(policy));
        return 0;
      }
      if (sub === 'record-restore') {
        if (flags.confirm !== true || !command[2]) {
          throw new CliUsageError('backup record-restore <backup-id> --recovery <id> --target-instance <id> --new-epoch <epoch> --confirm');
        }
        const context = await humanContext(
          runtime,
          { action: 'backup.record-restore', backupId: command[2], recoveryId: flags.recovery },
          { verifyNow: true }
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
        if (flags.confirm !== true) throw new CliUsageError('backup create requires --confirm');
        const kind = flags.kind || 'ledger';
        const requestId = flags.request || `cli-${Date.now()}`;
        const context = await humanContext(runtime, { action: 'backup.create', kind, requestId });
        print(stdout, await runtime.backupService.create({ kind, requestId }, context));
        return 0;
      }
      if (sub === 'prune') {
        if (flags.dry) {
          print(stdout, await runtime.backupService.planPrune());
          return 0;
        }
        if (flags.confirm !== true || !flags.plan) throw new CliUsageError('backup prune requires --plan <id> --confirm');
        const context = await humanContext(runtime, { action: 'backup.prune', planId: flags.plan });
        print(stdout, await runtime.backupService.prune({ planId: flags.plan }, context));
        return 0;
      }
      throw new CliUsageError('unknown backup subcommand');
    }
    if (command[0] === 'recovery') {
      const sub = command[1];
      if (sub === 'restore') {
        throw new CliUsageError('recovery restore is handled before runtime initialization');
      }
      if (sub === 'inspect') {
        print(stdout, await runtime.recovery.inspect(flags.id || command[2] || null));
        return 0;
      }
      if (sub === 'reconcile') {
        if (flags.confirm !== true) throw new CliUsageError('recovery reconcile requires --confirm');
        const evidence = await readJsonArg(flags.evidence);
        const recoveryId = flags.id || command[2] || null;
        const context = await humanContext(runtime, {
          action: 'recovery.reconcile',
          recoveryId,
          evidenceHash: jcsHash(evidence)
        });
        print(stdout, await runtime.recovery.reconcile({ recoveryId, evidence }, context));
        return 0;
      }
      if (sub === 'authorize') {
        if (flags.confirm !== true) throw new CliUsageError('recovery authorize requires --confirm');
        const scope = JSON.parse(flags.scope);
        const recoveryId = flags.id || command[2] || null;
        const context = await humanContext(runtime, {
          action: 'recovery.authorize',
          recoveryId,
          scope: jcsHash(scope),
          evidenceId: flags.evidence || null
        });
        print(stdout, await runtime.recovery.authorize(
          { recoveryId, scope, evidenceId: flags.evidence },
          context
        ));
        return 0;
      }
      throw new CliUsageError('unknown recovery subcommand');
    }
    throw new CliUsageError(`unknown command: ${command.join(' ')}`);
  } finally {
    await runtime.close();
  }
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      const parsed = error instanceof AppError ? error.toJSON() : { code: 'DEPENDENCY_UNAVAILABLE', message: error.message };
      process.stderr.write(`${JSON.stringify(parsed, null, 2)}\n`);
      if (error?.usage) process.stderr.write(`\nRun with --help for usage.\n`);
      process.exitCode = 1;
    }
  );
}
