import fsp from 'node:fs/promises';
import { AppError } from './errors.js';
import {
  atomicWriteJson,
  nowIso,
  pathExists,
  randomId,
  sha256Hex
} from './utils.js';

export const CREDENTIAL_FIELDS = Object.freeze(['sessdata', 'bili_jct', 'buvid3', 'dedeuserid']);
export const CREDENTIAL_ENV = Object.freeze({
  sessdata: 'BILI_SESSDATA',
  bili_jct: 'BILI_JCT',
  buvid3: 'BILI_BUVID3',
  dedeuserid: 'BILI_DEDEUSERID'
});

function normalizeCredentialValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeCredentials(raw = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AppError('CREDENTIAL_MISSING', 'credentials must be a JSON object');
  }
  const unknown = Object.keys(raw).filter((key) => !CREDENTIAL_FIELDS.includes(key));
  if (unknown.length > 0) {
    throw new AppError('CREDENTIAL_MISSING', 'credentials contain unknown fields', {
      details: { fields: unknown }
    });
  }
  return Object.fromEntries(CREDENTIAL_FIELDS.map((field) => [field, normalizeCredentialValue(raw[field])]));
}

export async function loadCredentials({ file, env = process.env } = {}) {
  let fromFile = {};
  if (file && (await pathExists(file))) {
    let text;
    try {
      text = await fsp.readFile(file, 'utf8');
    } catch (error) {
      throw new AppError('CREDENTIAL_MISSING', 'cannot read credentials file', { cause: error });
    }
    try {
      fromFile = JSON.parse(text);
    } catch (error) {
      throw new AppError('CREDENTIAL_MISSING', 'credentials file is not valid JSON', { cause: error });
    }
  }
  const normalized = normalizeCredentials(fromFile);
  for (const [field, envName] of Object.entries(CREDENTIAL_ENV)) {
    if (env[envName] !== undefined) normalized[field] = normalizeCredentialValue(env[envName]);
  }
  return normalized;
}

export async function saveCredentials(file, credentials) {
  const normalized = normalizeCredentials(credentials);
  await atomicWriteJson(file, normalized, { mode: 0o600 });
  // Ensure permissions remain narrow even if the file predated this write.
  await fsp.chmod(file, 0o600).catch(() => {});
  return normalized;
}

export function credentialRevision(credentials) {
  if (!credentials?.sessdata) return null;
  return sha256Hex(`credential-v1\n${credentials.sessdata}`);
}

export function publicCredentialSummary(credentials) {
  return {
    present: Boolean(credentials?.sessdata),
    hasWriteCredentials: Boolean(credentials?.sessdata && credentials?.bili_jct),
    credentialRevision: credentialRevision(credentials),
    claimedDedeUserId: credentials?.dedeuserid || null
  };
}

export function cookieHeaderFor(credentials, platform) {
  if (platform !== 'bilibili') {
    throw new AppError('FORBIDDEN', `credentials are not available for platform ${platform}`);
  }
  if (!credentials?.sessdata) {
    throw new AppError('CREDENTIAL_MISSING', 'Bilibili SESSDATA is missing');
  }
  const parts = [`SESSDATA=${credentials.sessdata}`];
  if (credentials.bili_jct) parts.push(`bili_jct=${credentials.bili_jct}`);
  if (credentials.buvid3) parts.push(`buvid3=${credentials.buvid3}`);
  if (credentials.dedeuserid) parts.push(`DedeUserID=${credentials.dedeuserid}`);
  return parts.join('; ');
}

export class CredentialService {
  constructor({ file, env = process.env, store, verifier, now = () => new Date() } = {}) {
    this.file = file;
    this.env = env;
    this.store = store;
    this.verifier = verifier || null;
    this.now = now;
    this.credentials = null;
  }

  async load() {
    this.credentials = await loadCredentials({ file: this.file, env: this.env });
    return this.credentials;
  }

  get() {
    if (!this.credentials) {
      throw new AppError('CREDENTIAL_MISSING', 'credentials have not been loaded');
    }
    return this.credentials;
  }

  getPublicSummary() {
    return publicCredentialSummary(this.credentials || {});
  }

  requireWrite() {
    const credentials = this.get();
    if (!credentials.sessdata || !credentials.bili_jct) {
      throw new AppError('CREDENTIAL_MISSING', 'sessdata and bili_jct are required for writes');
    }
    return credentials;
  }

  cookieForBilibili() {
    return cookieHeaderFor(this.get(), 'bilibili');
  }

  /**
   * Explicit identity verification. The verifier must perform a real whoami;
   * owner.mid and DedeUserID never replace it (SPEC §5.2).
   */
  async verifyAndBind({ principal, switchAccount = false, ownerMid = 0 } = {}) {
    if (!this.verifier) {
      throw new AppError('IDENTITY_UNVERIFIED', 'identity verifier is not configured');
    }
    const credentials = this.get();
    if (!credentials.sessdata) {
      throw new AppError('CREDENTIAL_MISSING', 'SESSDATA is missing');
    }
    let profile;
    try {
      profile = await this.verifier({ credentials });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('IDENTITY_UNVERIFIED', 'whoami verification failed', { cause: error });
    }
    if (!profile || profile.isLogin !== true || !profile.mid) {
      throw new AppError('IDENTITY_UNVERIFIED', 'whoami did not confirm a logged-in account');
    }
    const accountId = String(profile.mid);
    if (ownerMid && String(ownerMid) !== accountId) {
      throw new AppError('IDENTITY_UNVERIFIED', 'owner.mid does not match whoami MID');
    }
    if (credentials.dedeuserid && String(credentials.dedeuserid) !== accountId) {
      throw new AppError('IDENTITY_UNVERIFIED', 'claimed DedeUserID does not match whoami MID');
    }
    const revision = credentialRevision(credentials);
    const result = await this.store.transaction(async (draft, tx) => {
      const active = draft.activeAccountRef;
      if (active && active.accountId !== accountId && !switchAccount) {
        throw new AppError('IDENTITY_UNVERIFIED', 'active account differs; explicit account switch is required', {
          details: { activeAccountId: active.accountId }
        });
      }
      const namespaceKey = `bilibili:${accountId}`;
      const existing = draft.accounts[namespaceKey] || null;
      const account = {
        accountRef: { platform: 'bilibili', accountId },
        mid: accountId,
        uname: profile.uname || existing?.uname || '',
        credentialRevision: revision,
        devId: existing?.devId || `dev_${randomId('bili')}`,
        boundAt: existing?.boundAt || nowIso(this.now),
        lastVerifiedAt: nowIso(this.now),
        verifiedFrom: 'whoami'
      };
      draft.accounts[namespaceKey] = account;
      draft.activeAccountRef = { platform: 'bilibili', accountId };
      if (principal?.id) {
        draft.principals[principal.id] = draft.principals[principal.id] || principal;
      }
      tx.appendEvent({
        type: 'identity.verified',
        actor: principal?.id || 'local',
        accountRef: { platform: 'bilibili', accountId },
        payload: { accountId, uname: account.uname, credentialRevision: revision }
      });
      return { accountRef: account.accountRef, account };
    });
    return result;
  }

  async getActiveAccount() {
    const state = await this.store.getSnapshot();
    if (!state.activeAccountRef) return null;
    const key = `${state.activeAccountRef.platform}:${state.activeAccountRef.accountId}`;
    return state.accounts[key] || null;
  }

  async requireActiveAccount() {
    const account = await this.getActiveAccount();
    if (!account) {
      throw new AppError('IDENTITY_UNVERIFIED', 'no verified platform account is bound');
    }
    return account;
  }

  async getDeviceId(accountId) {
    const state = await this.store.getSnapshot();
    return state.accounts[`bilibili:${accountId}`]?.devId || null;
  }
}

export default CredentialService;
