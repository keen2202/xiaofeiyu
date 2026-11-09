/**
 * Contract test doubles for platforms that are explicitly out of scope
 * (X/Twitter, Douyin) and for the remote execution backend (SPEC §21.2 /
 * FR-EXT-003, TASKS T14).
 *
 * These doubles exist only to prove the capability contract: they never
 * implement a network call, must not be registered as enabled adapters, and
 * any attempt to use them must resolve to CAPABILITY_UNSUPPORTED instead of a
 * silent fallback.
 */
import { normalizeCapabilities } from '../../src/contracts.js';
import { AppError } from '../../src/errors.js';

export const UNSUPPORTED_PLATFORMS = Object.freeze(['x', 'douyin']);
const NOT_IMPLEMENTED = 'not_implemented';

const ALL_UNSUPPORTED = {
  'read.content': { supported: false, reason: NOT_IMPLEMENTED },
  'read.comments': { supported: false, reason: NOT_IMPLEMENTED },
  'write.comment': { supported: false, reason: NOT_IMPLEMENTED },
  'dm.send': { supported: false, reason: NOT_IMPLEMENTED },
  'dm.receive': { supported: false, reason: 'inbox_not_in_scope' },
  'publish.manual': { supported: false, reason: NOT_IMPLEMENTED },
  'publish.external': { supported: false, reason: NOT_IMPLEMENTED }
};

export const MOCK_PLATFORM_DECLARATIONS = Object.freeze({
  x: ALL_UNSUPPORTED,
  douyin: ALL_UNSUPPORTED
});

function unsupported(platform, action) {
  return new AppError('CAPABILITY_UNSUPPORTED', `${platform} ${action} is a contract-only test double`, {
    details: { platform, action }
  });
}

/** Build a PlatformAdapter-shaped test double that can never perform work. */
export function makeMockPlatformAdapter(name) {
  if (!UNSUPPORTED_PLATFORMS.includes(name)) {
    throw new Error(`unknown mock platform: ${name}`);
  }
  const declaration = MOCK_PLATFORM_DECLARATIONS[name];
  return {
    name,
    mock: true,
    capabilities: normalizeCapabilities(declaration),
    async verifyAccount() {
      throw unsupported(name, 'verifyAccount');
    },
    async discover() {
      throw unsupported(name, 'discover');
    },
    async readContent() {
      throw unsupported(name, 'readContent');
    },
    async readComments() {
      throw unsupported(name, 'readComments');
    },
    async writeComment() {
      throw unsupported(name, 'writeComment');
    },
    async sendDirectMessage() {
      throw unsupported(name, 'sendDirectMessage');
    },
    async preparePublish() {
      throw unsupported(name, 'preparePublish');
    },
    normalizeReceipt(receipt) {
      return receipt;
    }
  };
}

/** Remote execution is declared but never implemented (CAPABILITY_UNSUPPORTED). */
export function makeMockRemoteBackend() {
  return {
    name: 'remote-mock',
    mock: true,
    capabilities: {
      backendId: 'remote',
      schemaVersion: 1,
      supportedStages: [],
      supportsCancel: false,
      supportsCheckpoint: false
    },
    async submit() {
      throw new AppError('CAPABILITY_UNSUPPORTED', 'the remote execution backend is not implemented', {
        details: { capability: 'execution.remote' }
      });
    },
    async getStatus() {
      throw new AppError('CAPABILITY_UNSUPPORTED', 'the remote execution backend is not implemented');
    },
    async cancel() {
      throw new AppError('CAPABILITY_UNSUPPORTED', 'the remote execution backend is not implemented');
    },
    async close() {
      return { closed: true };
    }
  };
}
