import { AppError } from '../errors.js';
import { assertCapability, normalizeCapabilities } from '../contracts.js';

/**
 * Declarative, lazy capability registry. Factories are only invoked when an
 * enabled capability is actually needed; disabled adapters never load SDKs.
 */
export class AdapterRegistry {
  constructor() {
    this.platforms = new Map();
    this.channels = new Map();
    this.executionBackends = new Map();
  }

  registerPlatform({ name, declaration, factory, enabled = false }) {
    if (!name || typeof factory !== 'function') throw new Error('platform registration requires name and factory');
    this.platforms.set(name, {
      name,
      enabled: Boolean(enabled),
      capabilities: normalizeCapabilities(declaration),
      factory,
      cached: null,
      error: null
    });
    return this;
  }

  registerChannel({ name, declaration, factory, enabled = false }) {
    if (!name || typeof factory !== 'function') throw new Error('channel registration requires name and factory');
    this.channels.set(name, {
      name,
      enabled: Boolean(enabled),
      capabilities: declaration || {},
      factory,
      cached: null,
      error: null
    });
    return this;
  }

  registerExecutionBackend({ name, declaration, factory, enabled = false }) {
    if (!name || typeof factory !== 'function') throw new Error('execution registration requires name and factory');
    this.executionBackends.set(name, {
      name,
      enabled: Boolean(enabled),
      capabilities: declaration || {},
      factory,
      cached: null,
      error: null
    });
    return this;
  }

  hasPlatform(name) {
    return this.platforms.has(name);
  }

  async getPlatform(name, { requireEnabled = true } = {}) {
    const entry = this.platforms.get(name);
    if (!entry) {
      throw new AppError('CAPABILITY_UNSUPPORTED', `platform ${name} is not registered`, {
        details: { capability: `platform.${name}` }
      });
    }
    if (requireEnabled && !entry.enabled) {
      throw new AppError('FEATURE_DISABLED', `platform ${name} is disabled`);
    }
    if (entry.cached) return entry.cached;
    if (entry.error) throw entry.error;
    try {
      entry.cached = await entry.factory();
      return entry.cached;
    } catch (error) {
      entry.error = error;
      throw error;
    }
  }

  async getChannel(name, { requireEnabled = true } = {}) {
    const entry = this.channels.get(name);
    if (!entry) throw new AppError('CAPABILITY_UNSUPPORTED', `channel ${name} is not registered`);
    if (requireEnabled && !entry.enabled) throw new AppError('FEATURE_DISABLED', `channel ${name} is disabled`);
    if (entry.cached) return entry.cached;
    entry.cached = await entry.factory();
    return entry.cached;
  }

  async getExecutionBackend(name, { requireEnabled = true } = {}) {
    const entry = this.executionBackends.get(name);
    if (!entry) {
      throw new AppError('CAPABILITY_UNSUPPORTED', `execution backend ${name} is not registered`, {
        details: { capability: `execution.${name}` }
      });
    }
    if (requireEnabled && !entry.enabled) {
      throw new AppError('FEATURE_DISABLED', `execution backend ${name} is disabled`);
    }
    if (entry.cached) return entry.cached;
    entry.cached = await entry.factory();
    return entry.cached;
  }

  abilityStatus(platformName, capability) {
    const entry = this.platforms.get(platformName);
    if (!entry) return { supported: false, reason: 'not_registered', verified: false };
    const capabilityEntry = entry.capabilities[capability];
    return {
      supported: Boolean(capabilityEntry?.supported && entry.enabled),
      reason: !entry.enabled ? 'disabled' : capabilityEntry?.reason || null,
      limits: capabilityEntry?.limits || {},
      verified: false
    };
  }

  assertPlatformCapability(platformName, capability) {
    const entry = this.platforms.get(platformName);
    if (!entry) throw new AppError('CAPABILITY_UNSUPPORTED', `platform ${platformName} is not registered`);
    if (!entry.enabled) throw new AppError('FEATURE_DISABLED', `platform ${platformName} is disabled`);
    return assertCapability(entry.capabilities, capability);
  }

  capabilitiesSnapshot() {
    const snapshot = {};
    for (const [name, entry] of this.platforms) {
      snapshot[name] = { enabled: entry.enabled, capabilities: entry.capabilities, cached: Boolean(entry.cached) };
    }
    for (const [name, entry] of this.channels) {
      snapshot[`channel:${name}`] = { enabled: entry.enabled, capabilities: entry.capabilities, cached: Boolean(entry.cached) };
    }
    for (const [name, entry] of this.executionBackends) {
      snapshot[`execution:${name}`] = { enabled: entry.enabled, capabilities: entry.capabilities, cached: Boolean(entry.cached) };
    }
    return snapshot;
  }
}

export default AdapterRegistry;
