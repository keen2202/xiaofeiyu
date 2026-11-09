import { AppError } from '../../errors.js';
import {
  assertContentRef,
  makeReceipt,
  normalizeCapabilities
} from '../../contracts.js';
import { deepClone, nowIso, truncateText } from '../../utils.js';

export const BILIBILI_CAPABILITY_DECLARATION = Object.freeze({
  'read.content': { supported: true, limits: { sources: ['popular', 'search'] } },
  'read.comments': { supported: true, limits: { max: 50 } },
  'write.comment': { supported: true, limits: { maxLength: 2000 } },
  'dm.send': { supported: true, limits: { whitelistOnly: true, defaultRequireMutual: true } },
  'dm.receive': { supported: false, reason: 'inbox_not_in_scope' },
  'publish.manual': {
    supported: true,
    limits: {
      nativeUpload: false,
      titleMaxBytes: 80,
      descriptionMaxBytes: 2000,
      tagsMax: 12,
      tagLengthMax: 20,
      tidRequired: true
    }
  },
  'publish.external': { supported: false, reason: 'external_publisher_not_verified' }
});

/** Platform metadata limits are owned by the adapter, not by the publisher (I8). */
export const BILIBILI_PUBLISH_LIMITS = BILIBILI_CAPABILITY_DECLARATION['publish.manual'].limits;

function stripHtml(text) {
  return String(text ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
}

export class BilibiliPlatformAdapter {
  constructor({ client, store, configService, rateLimiter, config = null, logger, now = () => new Date() }) {
    this.client = client;
    this.store = store;
    this.configService = configService;
    this.rateLimiter = rateLimiter;
    this._config = config;
    this.logger = logger;
    this.now = now;
    this.capabilities = normalizeCapabilities(BILIBILI_CAPABILITY_DECLARATION);
    this.name = 'bilibili';
  }

  _configValue() {
    return this._config || this.configService.get();
  }

  _assertPlatformEnabled() {
    if (!this._configValue().platforms.enabled.includes('bilibili')) {
      throw new AppError('FEATURE_DISABLED', 'the Bilibili platform is disabled');
    }
  }

  async _activeAccount() {
    const state = await this.store.getSnapshot();
    if (!state.activeAccountRef || state.activeAccountRef.platform !== 'bilibili') {
      throw new AppError('IDENTITY_UNVERIFIED', 'no verified Bilibili account is bound');
    }
    const key = `bilibili:${state.activeAccountRef.accountId}`;
    const account = state.accounts[key];
    if (!account) throw new AppError('IDENTITY_UNVERIFIED', 'active Bilibili account record is missing');
    return account;
  }

  async verifyAccount() {
    const profile = await this.client.whoami();
    const config = this._configValue();
    if (config.owner.mid && Number(config.owner.mid) !== Number(profile.mid)) {
      throw new AppError('IDENTITY_UNVERIFIED', 'owner.mid does not match whoami MID');
    }
    return {
      accountRef: { platform: 'bilibili', accountId: String(profile.mid) },
      profile: { mid: String(profile.mid), uname: profile.uname }
    };
  }

  _candidate(raw, source) {
    const bvid = raw.bvid || raw.bv_id;
    if (!bvid) return null;
    const owner = raw.owner || {};
    const authorMid = raw.mid ?? owner.mid ?? raw.author_mid ?? 0;
    const title = stripHtml(raw.title ?? '');
    const description = stripHtml(raw.desc ?? raw.description ?? '');
    return {
      contentRef: { platform: 'bilibili', contentId: String(bvid) },
      title,
      description,
      author: { accountId: String(authorMid || '0'), name: stripHtml(owner.name ?? raw.author ?? '') },
      durationSec: Number(raw.duration) || 0,
      score: 0,
      source,
      platformData: {
        aid: Number(raw.aid) || 0,
        cid: Number(raw.cid) || 0
      }
    };
  }

  async discover({ sources = ['popular'], keywords = [], limit = 30 } = {}) {
    this._assertPlatformEnabled();
    if (!Array.isArray(sources) || sources.length === 0) return [];
    const config = this._configValue();
    const candidates = [];
    if (sources.includes('popular')) {
      const raw = await this.client.popular(Math.min(limit, 100));
      for (const item of raw) {
        const candidate = this._candidate(item, 'popular');
        if (candidate) candidates.push(candidate);
      }
    }
    if (sources.includes('search')) {
      const maxKeywords = Math.max(1, Math.min(keywords.length, 3));
      for (const keyword of keywords.slice(0, maxKeywords)) {
        const raw = await this.client.search(keyword, Math.min(limit, 50));
        for (const item of raw) {
          const candidate = this._candidate(item, 'search');
          if (candidate) {
            candidate.keyword = keyword;
            candidates.push(candidate);
          }
        }
      }
    }
    // Deduplicate inside the adapter as well; the Browse module is authoritative.
    const seen = new Set();
    return candidates.filter((candidate) => {
      const id = candidate.contentRef.contentId;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    }).slice(0, config.browse.candidatePool);
  }

  async readContent(candidate, { includeComments = false, includeSubtitle = true } = {}) {
    this._assertPlatformEnabled();
    assertContentRef(candidate.contentRef);
    const bvid = candidate.contentRef.contentId;
    const details = await this.client.videoDetails(bvid);
    const owner = details.owner || {};
    const content = {
      ...candidate,
      title: stripHtml(details.title ?? candidate.title),
      description: stripHtml(details.desc ?? candidate.description),
      author: {
        accountId: String(owner.mid ?? candidate.author?.accountId ?? '0'),
        name: stripHtml(owner.name ?? candidate.author?.name ?? '')
      },
      durationSec: Number(details.duration) || candidate.durationSec || 0,
      platformData: {
        aid: Number(details.aid) || candidate.platformData?.aid || 0,
        cid: Number(details.cid) || candidate.platformData?.cid || 0,
        tid: Number(details.tid) || null
      }
    };
    if (!content.platformData.cid && Array.isArray(details.pages) && details.pages[0]) {
      content.platformData.cid = Number(details.pages[0].cid) || 0;
    }
    if (includeSubtitle && content.platformData.cid) {
      try {
        content.subtitle = await this.client.subtitles({
          bvid,
          cid: content.platformData.cid
        });
      } catch (error) {
        if (this.logger) this.logger.warn?.('subtitle unavailable', { bvid, message: error.message });
        content.subtitle = null;
        content.subtitleError = { code: error.code || 'BILI_API_ERROR' };
      }
    }
    if (includeComments && content.platformData.aid) {
      try {
        const comments = await this.client.comments(content.platformData.aid, 10);
        content.topComments = comments.slice(0, 10).map((comment) => ({
          rpid: String(comment.rpid ?? ''),
          text: truncateText(stripHtml(comment.content?.message ?? ''), 500),
          author: {
            accountId: String(comment.member?.mid ?? '0'),
            name: stripHtml(comment.member?.uname ?? '')
          },
          like: Number(comment.like) || 0
        }));
      } catch (error) {
        content.topComments = [];
        content.commentsError = { code: error.code || 'BILI_API_ERROR' };
      }
    }
    return content;
  }

  async readComments(candidate, limit = 20) {
    this._assertPlatformEnabled();
    assertContentRef(candidate.contentRef);
    const aid = candidate.platformData?.aid;
    if (!aid) throw new AppError('INPUT_REQUIRED', 'Bilibili candidate has no aid');
    const comments = await this.client.comments(aid, limit);
    return comments.map((comment) => ({
      rpid: String(comment.rpid ?? ''),
      text: stripHtml(comment.content?.message ?? ''),
      author: { accountId: String(comment.member?.mid ?? '0'), name: stripHtml(comment.member?.uname ?? '') }
    }));
  }

  async writeComment({ candidate, text, root = 0, parent = 0, operationContext }) {
    this._assertPlatformEnabled();
    const account = await this._activeAccount();
    if (String(operationContext?.accountRef?.accountId) !== account.accountRef.accountId) {
      throw new AppError('FORBIDDEN', 'OperationContext account is not the active account');
    }
    const aid = candidate.platformData?.aid;
    const bvid = candidate.contentRef?.contentId;
    if (!aid) throw new AppError('INPUT_REQUIRED', 'Bilibili candidate has no aid');
    return this.client.sendComment({ aid, bvid, text, root, parent, operationContext });
  }

  async checkRecipient({ recipientMid, requireMutual = true }) {
    this._assertPlatformEnabled();
    const account = await this._activeAccount();
    if (String(recipientMid) === account.accountRef.accountId) {
      throw new AppError('FORBIDDEN', 'cannot direct-message yourself');
    }
    if (requireMutual) {
      const relation = await this.client.relation(recipientMid);
      if (!relation.mutual) throw new AppError('MUTUAL_FOLLOW_REQUIRED', 'recipient is not a mutual follow');
    }
    return { allowed: true };
  }

  async sendDirectMessage({ recipientMid, text, operationContext, requireMutual = true }) {
    this._assertPlatformEnabled();
    const account = await this._activeAccount();
    if (String(operationContext?.accountRef?.accountId) !== account.accountRef.accountId) {
      throw new AppError('FORBIDDEN', 'OperationContext account is not the active account');
    }
    if (String(recipientMid) === account.accountRef.accountId) {
      throw new AppError('FORBIDDEN', 'cannot direct-message yourself');
    }
    let mutualVerified = false;
    if (requireMutual) {
      const relation = await this.client.relation(recipientMid);
      if (!relation.mutual) throw new AppError('MUTUAL_FOLLOW_REQUIRED', 'recipient is not a mutual follow');
      mutualVerified = true;
    }
    // The protocol client re-checks mutual follow unless this adapter proves it
    // already verified the relation in this dispatch.
    return this.client.sendDirectMessage({
      recipientMid,
      text,
      operationContext,
      requireMutual,
      mutualVerified
    });
  }

  /**
   * Validate and normalize publish metadata against the platform limits
   * declared in `capabilities.publish.manual.limits` (I8).
   */
  async validatePublishMetadata(metadata) {
    const limits = this.capabilities['publish.manual'].limits;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      throw new AppError('PUBLISH_INPUT_INVALID', 'metadata is required', {
        details: { field: 'metadata' }
      });
    }
    const title = typeof metadata.title === 'string' ? metadata.title.trim() : '';
    if (title === '') {
      throw new AppError('PUBLISH_INPUT_INVALID', 'metadata.title is required', {
        details: { field: 'metadata.title' }
      });
    }
    if (Buffer.byteLength(title, 'utf8') > limits.titleMaxBytes) {
      throw new AppError('PUBLISH_INPUT_INVALID', `metadata.title exceeds ${limits.titleMaxBytes} bytes`, {
        details: { field: 'metadata.title', titleMaxBytes: limits.titleMaxBytes }
      });
    }
    const description = metadata.description === undefined ? '' : String(metadata.description);
    if (Buffer.byteLength(description, 'utf8') > limits.descriptionMaxBytes) {
      throw new AppError('PUBLISH_INPUT_INVALID', `metadata.description exceeds ${limits.descriptionMaxBytes} bytes`, {
        details: { field: 'metadata.description', descriptionMaxBytes: limits.descriptionMaxBytes }
      });
    }
    const tags = metadata.tags === undefined ? [] : metadata.tags;
    if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === 'string')) {
      throw new AppError('PUBLISH_INPUT_INVALID', 'metadata.tags must be an array of strings', {
        details: { field: 'metadata.tags' }
      });
    }
    const normalizedTags = [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
    if (normalizedTags.length > limits.tagsMax) {
      throw new AppError('PUBLISH_INPUT_INVALID', `metadata.tags exceeds ${limits.tagsMax} entries`, {
        details: { field: 'metadata.tags', tagsMax: limits.tagsMax }
      });
    }
    for (const tag of normalizedTags) {
      if (tag.length > limits.tagLengthMax) {
        throw new AppError('PUBLISH_INPUT_INVALID', `metadata.tags entries must be at most ${limits.tagLengthMax} characters`, {
          details: { field: 'metadata.tags', tagLengthMax: limits.tagLengthMax }
        });
      }
    }
    const platformData = metadata.platformData === undefined ? {} : metadata.platformData;
    if (!platformData || typeof platformData !== 'object' || Array.isArray(platformData)) {
      throw new AppError('PUBLISH_INPUT_INVALID', 'metadata.platformData must be an object', {
        details: { field: 'metadata.platformData' }
      });
    }
    if (platformData.tid !== undefined && (!Number.isSafeInteger(platformData.tid) || platformData.tid <= 0)) {
      throw new AppError('PUBLISH_INPUT_INVALID', 'metadata.platformData.tid must be a positive integer', {
        details: { field: 'metadata.platformData.tid' }
      });
    }
    if (limits.tidRequired && platformData.tid === undefined) {
      throw new AppError('PUBLISH_INPUT_INVALID', 'metadata.platformData.tid is required', {
        details: { field: 'metadata.platformData.tid' }
      });
    }
    return {
      title,
      description: description.trim(),
      tags: normalizedTags,
      platformData: deepClone(platformData)
    };
  }

  async preparePublish() {
    throw new AppError('CAPABILITY_UNSUPPORTED', 'native Bilibili upload is not implemented', {
      details: { capability: 'publish.native' }
    });
  }

  normalizeReceipt(receipt) {
    if (!receipt) return receipt;
    return makeReceipt({
      platform: receipt.platform || 'bilibili',
      accountId: receipt.accountId,
      action: receipt.action,
      externalId: receipt.externalId,
      url: receipt.url || null,
      verification: receipt.verification,
      receivedAt: receipt.receivedAt || nowIso(this.now)
    });
  }

  async capabilitiesSnapshot() {
    const account = await this._activeAccount().catch(() => null);
    return {
      platform: 'bilibili',
      enabled: this._configValue().platforms.enabled.includes('bilibili'),
      verified: Boolean(account),
      capabilities: this.capabilities
    };
  }
}

export default BilibiliPlatformAdapter;
