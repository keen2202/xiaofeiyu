import { AppError } from './errors.js';
import {
  constantTimeEqual,
  deepClone,
  jcsHash,
  nowIso,
  randomId,
  randomPhrase
} from './utils.js';

export const PRINCIPAL_KINDS = Object.freeze(['human', 'agent', 'service', 'system']);
export const IM_SCOPES = Object.freeze([
  'production.create',
  'task.read.own',
  'task.cancel.own',
  'task.resume.own',
  'approval.decide.own',
  'comment.draft'
]);

export const KNOWN_SCOPES = Object.freeze([
  ...IM_SCOPES,
  'browse.run',
  'diary.read.own',
  'diary.generate.own',
  'dm.send',
  'publish.create',
  'artifact.import',
  'config.read'
]);

export const LOCAL_OWNER_SCOPES = Object.freeze(['*']);

export function makePrincipal({
  id,
  kind = 'human',
  sourceKind = 'local_cli',
  role = 'owner',
  scopes = [],
  workspaceId,
  displayName = '',
  createdAt
}) {
  if (!PRINCIPAL_KINDS.includes(kind)) throw new AppError('FORBIDDEN', 'invalid principal kind');
  const allowed = scopes.filter((scope) => scope === '*' || KNOWN_SCOPES.includes(scope));
  return {
    id: id || randomId('principal'),
    workspaceId,
    kind,
    role,
    sourceKind,
    displayName,
    scopes: [...new Set(allowed)],
    createdAt: createdAt || nowIso(),
    revokedAt: null
  };
}

export class IdentityService {
  constructor({ store, now = () => new Date() } = {}) {
    this.store = store;
    this.now = now;
  }

  ensureLocalOwner(tx, { displayName = 'local owner' } = {}) {
    const existing = Object.values(tx.state.principals).find(
      (principal) =>
        principal.kind === 'human' &&
        principal.role === 'owner' &&
        principal.sourceKind === 'local_cli' &&
        !principal.revokedAt
    );
    if (existing) return existing;
    const principal = makePrincipal({
      kind: 'human',
      sourceKind: 'local_cli',
      role: 'owner',
      scopes: LOCAL_OWNER_SCOPES,
      workspaceId: tx.workspaceId,
      displayName,
      createdAt: nowIso(this.now)
    });
    tx.state.principals[principal.id] = principal;
    return principal;
  }

  create(tx, data) {
    if (!data || !data.kind) throw new AppError('FORBIDDEN', 'principal kind is required');
    if (data.kind === 'human' && data.sourceKind !== 'host_human_challenge' && data.sourceKind !== 'local_cli') {
      throw new AppError('FORBIDDEN', 'human principals require a trusted human source');
    }
    const principal = makePrincipal({
      ...data,
      workspaceId: tx.workspaceId,
      createdAt: nowIso(this.now)
    });
    tx.state.principals[principal.id] = principal;
    return principal;
  }

  get(tx, principalId) {
    const principal = tx.state.principals[principalId];
    if (!principal) throw new AppError('FORBIDDEN', 'principal is not registered');
    if (principal.revokedAt) throw new AppError('FORBIDDEN', 'principal is revoked');
    return principal;
  }

  hasScope(principal, scope) {
    if (!principal || principal.revokedAt) return false;
    if (principal.scopes?.includes('*')) return true;
    if (principal.scopes?.includes(scope)) return true;
    // `.own` actions are always bound to task.principalId separately.
    return false;
  }

  authorize(principal, scope, { task = null, allowOwner = false } = {}) {
    if (!principal || principal.revokedAt) throw new AppError('FORBIDDEN', 'principal is revoked or missing');
    if (principal.kind === 'human' && principal.role === 'owner' && principal.scopes?.includes('*')) return true;
    const base = scope.replace(/\.own$/, '');
    const own = scope.endsWith('.own');
    const direct = this.hasScope(principal, scope);
    const baseScope = this.hasScope(principal, base);
    if (!direct && !baseScope) throw new AppError('FORBIDDEN', `principal lacks scope ${scope}`);
    if (own && task && task.principalId !== principal.id && !allowOwner) {
      throw new AppError('FORBIDDEN', 'task belongs to another principal');
    }
    return true;
  }

  bindIm(tx, data) {
    const { adapterId, botAccountId, senderRef, conversationIds, principalId, scopes = [] } = data;
    for (const key of ['adapterId', 'botAccountId', 'senderRef', 'principalId']) {
      if (typeof data[key] !== 'string' || data[key] === '') {
        throw new AppError('FORBIDDEN', `binding.${key} is required`);
      }
    }
    if (!Array.isArray(conversationIds) || conversationIds.length === 0 || !conversationIds.every((v) => typeof v === 'string' && v)) {
      throw new AppError('FORBIDDEN', 'binding conversationIds must be a non-empty string array');
    }
    if (!Array.isArray(scopes) || !scopes.every((scope) => IM_SCOPES.includes(scope))) {
      throw new AppError('FORBIDDEN', 'binding scopes must be an explicit subset of IM scopes');
    }
    const principal = this.get(tx, principalId);
    if (principal.kind === 'human' && principal.role === 'owner') {
      // Binding an owner principal to an IM channel does not itself confer
      // arbitrary local-owner scopes; the binding scopes remain the ceiling.
    }
    const binding = {
      bindingId: data.bindingId || randomId('binding'),
      adapterId,
      botAccountId,
      senderRef,
      conversationIds: [...new Set(conversationIds)],
      principalId,
      scopes: [...new Set(scopes)],
      createdAt: nowIso(this.now),
      revokedAt: null
    };
    tx.state.bindings[binding.bindingId] = binding;
    tx.appendEvent({
      type: 'im.binding.created',
      actor: principalId,
      payload: {
        bindingId: binding.bindingId,
        adapterId,
        botAccountId,
        conversationIds: binding.conversationIds,
        scopes: binding.scopes
      }
    });
    return binding;
  }

  revokeIm(tx, bindingId) {
    const binding = tx.state.bindings[bindingId];
    if (!binding) throw new AppError('FORBIDDEN', 'binding not found');
    if (!binding.revokedAt) {
      binding.revokedAt = nowIso(this.now);
      binding.revokedBy = 'local_human';
      tx.appendEvent({
        type: 'im.binding.revoked',
        actor: 'local_human',
        payload: { bindingId }
      });
    }
    return binding;
  }

  resolveImPrincipal(tx, { adapterId, botAccountId, senderRef, conversationId }) {
    const bindings = Object.values(tx.state.bindings).filter(
      (binding) =>
        !binding.revokedAt &&
        binding.adapterId === adapterId &&
        binding.botAccountId === botAccountId &&
        binding.senderRef === senderRef &&
        binding.conversationIds.includes(conversationId)
    );
    if (bindings.length === 0) {
      throw new AppError('FORBIDDEN', 'no active IM binding for this sender/conversation');
    }
    const binding = bindings[0];
    const principal = tx.state.principals[binding.principalId];
    if (!principal || principal.revokedAt) throw new AppError('FORBIDDEN', 'bound principal is unavailable');
    const scoped = { ...deepClone(principal), scopes: [...new Set(binding.scopes)], bindingId: binding.bindingId };
    return { principal: scoped, binding: deepClone(binding) };
  }
}

/**
 * Verifies a host-provided or TTY-issued human interaction challenge.
 * A verifier must fail closed when no trustworthy proof exists.
 */
export class HumanProofService {
  constructor({ verifier } = {}) {
    this.verifier = verifier || null;
  }

  async assert(context, binding) {
    if (!context || !context.principal || !context.proof) {
      throw new AppError('TRUST_UNAVAILABLE', 'a trusted human context is required');
    }
    const principal = context.principal;
    if (principal.kind !== 'human' || principal.revokedAt) {
      throw new AppError('FORBIDDEN', 'only a verified human principal may perform this action');
    }
    if (!this.verifier?.verify) {
      throw new AppError('TRUST_UNAVAILABLE', 'no human proof verifier is configured');
    }
    let verified;
    try {
      verified = await this.verifier.verify(context.proof, binding, context);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('TRUST_UNAVAILABLE', 'human proof verification failed', { cause: error });
    }
    if (!verified) throw new AppError('TRUST_UNAVAILABLE', 'human proof was rejected');
    return principal;
  }
}

/**
 * TTY challenge verifier. The challenge phrase is shown once and must be typed
 * in the same interactive terminal; non-TTY invocations are rejected.
 */
export class TtyHumanVerifier {
  constructor({ input = process.stdin, output = process.stdout, challengeTtlMs = 120000, now = () => new Date(), isTTY } = {}) {
    this.input = input;
    this.output = output;
    this.challengeTtlMs = challengeTtlMs;
    this.now = now;
    this.isTTY = isTTY ?? Boolean(input?.isTTY && output?.isTTY);
    this.pending = new Map();
  }

  issue(binding) {
    if (!this.isTTY) {
      throw new AppError('TRUST_UNAVAILABLE', 'interactive TTY is unavailable');
    }
    const challengeId = randomId('human');
    const phrase = randomPhrase(3);
    const bindingHash = jcsHash(binding || {});
    const expiresAt = new Date(this.now().getTime() + this.challengeTtlMs).toISOString();
    this.pending.set(challengeId, { bindingHash, phrase, expiresAt, used: false });
    this.output.write(
      [
        '',
        'Human confirmation required.',
        `Action binding: ${bindingHash}`,
        `Type this one-time phrase to continue: ${phrase}`,
        ''
      ].join('\n')
    );
    return { challengeId, phraseLength: phrase.length, expiresAt, bindingHash };
  }

  async verify(proof, binding) {
    if (!this.isTTY) return false;
    if (!proof || typeof proof.challengeId !== 'string' || typeof proof.response !== 'string') return false;
    const challenge = this.pending.get(proof.challengeId);
    if (!challenge || challenge.used) return false;
    if (binding !== undefined && jcsHash(binding || {}) !== challenge.bindingHash) return false;
    if (Date.parse(challenge.expiresAt) < this.now().getTime()) {
      this.pending.delete(proof.challengeId);
      return false;
    }
    if (!constantTimeEqual(challenge.phrase, proof.response.trim())) return false;
    challenge.used = true;
    this.pending.delete(proof.challengeId);
    return true;
  }
}

export const rejectingHumanVerifier = Object.freeze({
  async verify() {
    return false;
  }
});

export default IdentityService;
