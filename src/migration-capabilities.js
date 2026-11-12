import fs from 'node:fs/promises';
import { AppError } from './errors.js';
import { imBindingFailure } from './identity.js';

// Invoked only by explicit local capability reauthorization, never by startup/status.
export function migrationCapabilityChecks({ configService, credentials, adapter, channel }) {
  return async ({ state, requestedCapabilities = [] }) => {
    const config = configService.get();
    const capabilities = ['core:read', 'core:write'];
    const blocked = [];
    let accountCheck;
    const verifyAccount = () => accountCheck ||= (async () => {
      if (!config.platforms.enabled.includes('bilibili')) throw new AppError('FEATURE_DISABLED', 'platform disabled');
      credentials.assertWriteAllowed(state);
      const verified = await adapter.verifyAccount();
      if (!state.activeAccountRef || verified.accountRef.platform !== state.activeAccountRef.platform ||
          verified.accountRef.accountId !== state.activeAccountRef.accountId) {
        throw new AppError('IDENTITY_UNVERIFIED', 'reverified platform identity differs from imported identity');
      }
    })();
    for (const capability of requestedCapabilities) {
      try {
        if (capability === 'platform:bilibili') {
          await verifyAccount();
        } else if (capability === 'production:local') {
          if (!config.production.enabled || !config.security.allowLocalProducer) throw new AppError('FEATURE_DISABLED', 'local producer disabled');
          const { loadLocalSlideshowProfile, preflightProfile } = await import('./production/profiles/local-slideshow.js');
          const profile = await loadLocalSlideshowProfile({ profilesFile: config.production.profilesFile, profileId: config.production.profileId, config });
          const result = await preflightProfile(profile);
          if (!result.ok) throw new AppError('DEPENDENCY_UNAVAILABLE', 'local media tools failed preflight', { details: result });
        } else if (capability === 'publish:manual' || capability === 'publish:external') {
          if (!config.publishing.enabled) throw new AppError('FEATURE_DISABLED', 'publishing disabled');
          await verifyAccount();
          if (capability === 'publish:external') {
            if (!config.security.allowExternalPublisher || !config.publishing.external.successJson || config.publishing.provider !== 'external') {
              throw new AppError('EXTERNAL_PUBLISH_DISABLED', 'external publisher is not rebound');
            }
            const stat = await fs.lstat(config.publishing.external.command);
            if (!stat.isFile() || stat.isSymbolicLink()) throw new AppError('DEPENDENCY_UNAVAILABLE', 'publisher is not a regular executable');
            await fs.access(config.publishing.external.command, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
          }
        } else if (capability === 'im') {
          if (!config.im.enabled || !channel) throw new AppError('DEPENDENCY_UNAVAILABLE', 'IM channel is not rebound');
          const probe = await channel.probe();
          if (probe.status !== 'available') throw new AppError('DEPENDENCY_UNAVAILABLE', 'IM channel is unavailable');
          const bindings = Object.values(state.bindings).filter(binding => !imBindingFailure(state, binding) &&
            binding.adapterId === config.im.adapterId && binding.conversationIds.length > 0);
          if (!bindings.length) throw new AppError('FORBIDDEN', 'no reverified IM audience binding');
        } else if (!capabilities.includes(capability)) {
          throw new AppError('CAPABILITY_UNSUPPORTED', 'capability has no local re-verification procedure');
        }
        capabilities.push(capability);
      } catch (error) { blocked.push({ capability, code: error.code || 'DEPENDENCY_UNAVAILABLE', reason: error.message }); }
    }
    return { capabilities: [...new Set(capabilities)], blocked };
  };
}
