import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CredentialService, credentialRevision, loadCredentials, saveCredentials } from '../src/credentials.js';
import { createHarness } from './helpers/harness.js';

test('credentials load from file with environment priority and are saved 0600', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xfy-cred-'));
  const file = path.join(dir, 'credentials.json');
  try {
    await saveCredentials(file, { sessdata: 'file', bili_jct: 'j', buvid3: 'b', dedeuserid: '1' });
    const stat = await fs.stat(file);
    assert.equal(stat.mode & 0o777, 0o600);
    const loaded = await loadCredentials({ file, env: { BILI_SESSDATA: 'env' } });
    assert.equal(loaded.sessdata, 'env');
    assert.equal(loaded.bili_jct, 'j');
    assert.equal(credentialRevision(loaded), credentialRevision({ ...loaded }));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('same MID with a new cookie keeps quota namespace and dev id', async () => {
  const harness = await createHarness();
  try {
    const dir = path.join(harness.dir, 'cred');
    await fs.mkdir(dir);
    const file = path.join(dir, 'credentials.json');
    await saveCredentials(file, { sessdata: 'cookie1', bili_jct: 'j', dedeuserid: '1001' });
    const credentials = new CredentialService({
      file,
      env: {},
      store: harness.store,
      now: harness.now,
      verifier: async () => ({ isLogin: true, mid: 1001, uname: 'tester' })
    });
    await credentials.load();
    const first = await credentials.verifyAndBind({ principal: harness.owner, ownerMid: 1001 });
    const rev1 = first.account.credentialRevision;
    await saveCredentials(file, { sessdata: 'cookie2', bili_jct: 'j', dedeuserid: '1001' });
    await credentials.load();
    const second = await credentials.verifyAndBind({ principal: harness.owner, ownerMid: 1001 });
    assert.notEqual(rev1, second.account.credentialRevision);
    assert.equal(second.account.devId, first.account.devId);
    const state = await harness.store.getSnapshot();
    assert.equal(state.activeAccountRef.accountId, '1001');
    assert.equal(Object.keys(state.accounts).length, 1);
    await assert.rejects(
      () => credentials.verifyAndBind({ principal: harness.owner, ownerMid: 9999 }),
      (error) => error.code === 'IDENTITY_UNVERIFIED'
    );
  } finally {
    await harness.cleanup();
  }
});

test('different MID requires explicit switch and claimed dedeuserid must match whoami', async () => {
  const harness = await createHarness();
  try {
    const file = path.join(harness.dir, 'credentials.json');
    await saveCredentials(file, { sessdata: 'c', bili_jct: 'j', dedeuserid: '1001' });
    let mid = 1001;
    const credentials = new CredentialService({
      file,
      env: {},
      store: harness.store,
      now: harness.now,
      verifier: async () => ({ isLogin: true, mid, uname: 'u' })
    });
    await credentials.load();
    await credentials.verifyAndBind({ principal: harness.owner });
    mid = 2002;
    await saveCredentials(file, { sessdata: 'c2', bili_jct: 'j', dedeuserid: '2002' });
    await credentials.load();
    await assert.rejects(
      () => credentials.verifyAndBind({ principal: harness.owner }),
      (error) => error.code === 'IDENTITY_UNVERIFIED'
    );
    const switched = await credentials.verifyAndBind({ principal: harness.owner, switchAccount: true });
    assert.equal(switched.accountRef.accountId, '2002');
    assert.equal((await harness.store.getSnapshot()).activeAccountRef.accountId, '2002');
    await saveCredentials(file, { sessdata: 'c3', bili_jct: 'j', dedeuserid: '1001' });
    await credentials.load();
    await assert.rejects(
      () => credentials.verifyAndBind({ principal: harness.owner, switchAccount: true }),
      (error) => error.code === 'IDENTITY_UNVERIFIED'
    );
  } finally {
    await harness.cleanup();
  }
});

test('missing write credentials are reported as CREDENTIAL_MISSING', async () => {
  const harness = await createHarness();
  try {
    const credentials = new CredentialService({
      file: path.join(harness.dir, 'none.json'),
      env: {},
      store: harness.store,
      verifier: async () => ({ isLogin: false, mid: 0 })
    });
    await credentials.load();
    assert.equal(credentials.getPublicSummary().hasWriteCredentials, false);
    assert.throws(() => credentials.requireWrite(), (error) => error.code === 'CREDENTIAL_MISSING');
    await assert.rejects(
      () => credentials.verifyAndBind({ principal: harness.owner }),
      (error) => error.code === 'CREDENTIAL_MISSING'
    );
  } finally {
    await harness.cleanup();
  }
});
