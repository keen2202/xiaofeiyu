import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, bindMockAccount } from './helpers/harness.js';
import { makePrincipal } from '../src/identity.js';

test('IM bindings map trusted sender/conversation and revoke fail closed', async () => {
  const harness = await createHarness();
  try {
    const binding = await harness.store.transaction(async (draft, tx) => {
      const principal = makePrincipal({
        id: 'im_user',
        kind: 'human',
        role: 'user',
        sourceKind: 'host_human_challenge',
        scopes: [],
        workspaceId: draft.workspaceId
      });
      draft.principals[principal.id] = principal;
      return harness.identity.bindIm(tx, {
        adapterId: 'dsh-im',
        botAccountId: 'bot1',
        senderRef: 'sender1',
        conversationIds: ['conv1'],
        principalId: principal.id,
        scopes: ['task.read.own', 'production.create']
      });
    });
    const resolved = await harness.store.transaction(async (draft, tx) =>
      harness.identity.resolveImPrincipal(tx, {
        adapterId: 'dsh-im',
        botAccountId: 'bot1',
        senderRef: 'sender1',
        conversationId: 'conv1'
      })
    );
    assert.equal(resolved.principal.id, 'im_user');
    assert.deepEqual(resolved.principal.scopes.sort(), ['production.create', 'task.read.own']);
    await harness.store.transaction(async (draft, tx) => harness.identity.revokeIm(tx, binding.bindingId));
    await assert.rejects(
      () =>
        harness.store.transaction(async (draft, tx) =>
          harness.identity.resolveImPrincipal(tx, {
            adapterId: 'dsh-im',
            botAccountId: 'bot1',
            senderRef: 'sender1',
            conversationId: 'conv1'
          })
        ),
      (error) => error.code === 'FORBIDDEN'
    );
  } finally {
    await harness.cleanup();
  }
});

test('ACL scopes default to deny and owner wildcard only applies to owner', async () => {
  const harness = await createHarness();
  try {
    assert.throws(
      () => harness.identity.authorize({ id: 'a', kind: 'agent', scopes: [], revokedAt: null }, 'browse.run'),
      (error) => error.code === 'FORBIDDEN'
    );
    const agent = { id: 'a', kind: 'agent', scopes: ['task.read.own'], revokedAt: null };
    assert.equal(harness.identity.authorize(agent, 'task.read.own', { task: { principalId: 'a' } }), true);
    assert.throws(
      () => harness.identity.authorize(agent, 'task.read.own', { task: { principalId: 'b' } }),
      (error) => error.code === 'FORBIDDEN'
    );
    assert.equal(harness.identity.authorize(harness.owner, 'production.create'), true);
  } finally {
    await harness.cleanup();
  }
});

test('IM binding cannot be used to grant owner privileges', async () => {
  const harness = await createHarness();
  try {
    const owner = harness.owner;
    const binding = await harness.store.transaction(async (draft, tx) =>
      harness.identity.bindIm(tx, {
        adapterId: 'dsh-im',
        botAccountId: 'bot1',
        senderRef: 'owner',
        conversationIds: ['c1'],
        principalId: owner.id,
        scopes: ['task.read.own']
      })
    );
    const resolved = await harness.store.transaction(async (draft, tx) =>
      harness.identity.resolveImPrincipal(tx, {
        adapterId: 'dsh-im',
        botAccountId: 'bot1',
        senderRef: 'owner',
        conversationId: 'c1'
      })
    );
    assert.equal(resolved.principal.scopes.includes('*'), false);
    assert.deepEqual(resolved.principal.scopes, ['task.read.own']);
    assert.equal(binding.bindingId.startsWith('binding_'), true);
  } finally {
    await harness.cleanup();
  }
});
