/**
 * outbound-lead-waterfall-router :: Tier 0 enrichment cache (memory + optional file)
 *
 * ⚠️ Disclaimer & Liability Limitation
 * Use at your own risk. The code, workflows, and scripts provided in this repository
 * (outbound-lead-waterfall-router) are for educational and architectural demonstration
 * purposes.
 *
 * - No Liability: The author and dhRobin Systems assume no responsibility or liability for
 *   any direct, indirect, incidental, or consequential damages resulting from the use,
 *   misuse, or deployment of these scripts.
 * - No Warranty: All software, configuration templates, and JavaScript modules are provided
 *   "AS IS" without warranty of any kind, express or implied, including but not limited to
 *   merchantability, fitness for a particular purpose, or non-infringement.
 * - Production Testing Required: Always test thoroughly in an isolated staging environment
 *   with SANDBOX_MODE=true enabled and a conservative MAX_CREDITS_PER_RUN before connecting
 *   live Apollo, Clearbit, Clay, or other enrichment provider credentials.
 * - Third-Party APIs & Compliance: Users are solely responsible for complying with the
 *   terms of service, rate limits, credit policies, data privacy regulations (GDPR/CCPA),
 *   and anti-spam laws (e.g. CAN-SPAM, CASL, PECR) of Apollo, Clearbit, Clay, and any other
 *   connected data provider, and for having a lawful basis to process prospect data.
 *
 * Full text: DISCLAIMER.md | License: MIT (see LICENSE)
 * Copyright (c) 2026 DH Robin (dhRobin Systems) - https://dhrobinsystems.com
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { logger: defaultLogger } = require('../utils/logger');

const DAY_MS = 24 * 60 * 60 * 1000;
const CACHE_FORMAT_VERSION = 1;

/**
 * Tier 0 of the waterfall: free, instant, and checked before any paid call.
 *
 * - Positive entries hold the merged enrichment result (TTL: CACHE_TTL_DAYS).
 * - Negative entries remember confirmed "no match" outcomes (shorter TTL), so
 *   you never pay again to learn the same miss.
 * - Keys are SHA-256 hashes of the normalised identity, so the cache index
 *   itself contains no readable emails or names.
 * - Persistence is opt-in (CACHE_FILE_PATH). Cached values DO contain
 *   enriched personal data: store the file on encrypted disk, keep it out of
 *   version control, and honour deletion requests (see README).
 */
class CacheProvider {
  constructor(options) {
    const o = options || {};
    this.name = 'cache';
    this.tier = 0;
    this.costPerLookup = 0;
    this.ttlMs = Number.isFinite(o.ttlMs) ? o.ttlMs : 30 * DAY_MS;
    this.negativeTtlMs = Number.isFinite(o.negativeTtlMs) ? o.negativeTtlMs : 7 * DAY_MS;
    this.maxEntries = o.maxEntries || 50000;
    this.filePath = o.filePath ? path.resolve(o.filePath) : '';
    this.now = o.now || (() => Date.now());
    this.logger = (o.logger || defaultLogger).child({ provider: 'cache' });
    this.entries = new Map();
    this.dirty = false;
    this.stats = { hits: 0, negativeHits: 0, misses: 0, writes: 0, evictions: 0 };
    if (this.filePath) this.load();
  }

  /**
   * Build a privacy-preserving cache key from the strongest identifier.
   * @returns {string|null}
   */
  keyFor(lead) {
    let identity = null;
    if (lead.email) identity = 'email:' + lead.email.toLowerCase();
    else if (lead.linkedinUrl) identity = 'linkedin:' + lead.linkedinUrl.toLowerCase().replace(/\/+$/, '');
    else if (lead.firstName && lead.lastName && lead.companyDomain) {
      identity = 'name:' + [lead.firstName, lead.lastName, lead.companyDomain].join('|').toLowerCase();
    }
    return identity ? crypto.createHash('sha256').update(identity).digest('hex') : null;
  }

  isFresh(entry) {
    const ttl = entry.status === 'no_match' ? this.negativeTtlMs : this.ttlMs;
    return this.now() - entry.storedAt < ttl;
  }

  /**
   * @returns {Promise<{provider:'cache', status:'matched'|'no_match'|'miss', data?:object, confidence?:number, cost:0, cachedAt?:string}>}
   */
  async lookup(lead) {
    const key = this.keyFor(lead);
    const entry = key ? this.entries.get(key) : undefined;
    if (!entry || !this.isFresh(entry)) {
      if (entry) this.entries.delete(key);
      this.stats.misses += 1;
      return { provider: 'cache', status: 'miss', cost: 0 };
    }
    // Refresh recency for LRU eviction.
    this.entries.delete(key);
    this.entries.set(key, entry);
    if (entry.status === 'no_match') {
      this.stats.negativeHits += 1;
      return { provider: 'cache', status: 'no_match', cost: 0, cachedAt: new Date(entry.storedAt).toISOString() };
    }
    this.stats.hits += 1;
    return {
      provider: 'cache',
      status: 'matched',
      data: Object.assign({}, entry.data),
      confidence: entry.confidence,
      sources: Object.assign({}, entry.sources || {}),
      cost: 0,
      cachedAt: new Date(entry.storedAt).toISOString()
    };
  }

  /**
   * Store a final waterfall outcome.
   * @param {object} lead normalised lead
   * @param {{status:'matched'|'no_match', data?:object, confidence?:number, sources?:object}} outcome
   */
  async store(lead, outcome) {
    const key = this.keyFor(lead);
    if (!key || !outcome) return false;
    this.entries.delete(key);
    this.entries.set(key, {
      status: outcome.status === 'no_match' ? 'no_match' : 'matched',
      data: outcome.status === 'no_match' ? undefined : Object.assign({}, outcome.data),
      confidence: outcome.confidence || 0,
      sources: outcome.sources,
      storedAt: this.now()
    });
    this.stats.writes += 1;
    this.dirty = true;
    while (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value);
      this.stats.evictions += 1;
    }
    return true;
  }

  /** Remove one person from the cache (e.g. GDPR erasure request). */
  async forget(lead) {
    const key = this.keyFor(lead);
    const removed = key ? this.entries.delete(key) : false;
    if (removed) this.dirty = true;
    return removed;
  }

  load() {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (!parsed || parsed.version !== CACHE_FORMAT_VERSION || !Array.isArray(parsed.entries)) {
        this.logger.warn('Ignoring cache file with unknown format.');
        return;
      }
      for (const [key, entry] of parsed.entries) {
        if (entry && Number.isFinite(entry.storedAt) && this.isFresh(entry)) this.entries.set(key, entry);
      }
      this.logger.info('Cache loaded', { entries: this.entries.size });
    } catch (error) {
      // A corrupt cache must never stop a run; it only costs extra lookups.
      this.logger.error('Failed to load cache file; starting empty.', { error });
      this.entries.clear();
    }
  }

  /** Persist atomically (write temp file, then rename) with owner-only permissions. */
  async flush() {
    if (!this.filePath || !this.dirty) return false;
    const directory = path.dirname(this.filePath);
    await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
    const temp = this.filePath + '.' + process.pid + '.tmp';
    const body = JSON.stringify({ version: CACHE_FORMAT_VERSION, entries: Array.from(this.entries.entries()) });
    await fs.promises.writeFile(temp, body, { mode: 0o600 });
    await fs.promises.rename(temp, this.filePath);
    this.dirty = false;
    return true;
  }
}

module.exports = {
  CacheProvider
};
