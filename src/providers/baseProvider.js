/**
 * outbound-lead-waterfall-router :: Shared provider contract, resilience & sandbox mocks
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

const { TokenBucket, CircuitBreaker, createGuardedExecutor, sleep } = require('../utils/rateLimiter');
const { classifyHttpError, ERROR_CODES } = require('../utils/errors');
const { logger: defaultLogger } = require('../utils/logger');

/**
 * Canonical enrichment fields. Every provider maps its response into this
 * shape so the router can merge results field by field.
 */
const ENRICHMENT_FIELDS = Object.freeze([
  'email', 'emailStatus', 'firstName', 'lastName', 'fullName', 'title', 'seniority',
  'linkedinUrl', 'companyName', 'companyDomain', 'industry', 'employeeCount', 'country'
]);

const RESULT_STATUS = Object.freeze({
  MATCHED: 'matched',
  NO_MATCH: 'no_match',
  PENDING: 'pending',
  SKIPPED: 'skipped',
  ERROR: 'error'
});

/** Deterministic 0-99 bucket for a string (FNV-1a). Used for sandbox mocks. */
function stableBucket(input) {
  let hash = 0x811c9dc5;
  const text = String(input || '');
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 100;
}

/** Keep only canonical, non-empty fields. */
function cleanEnrichment(data) {
  const out = {};
  for (const field of ENRICHMENT_FIELDS) {
    const value = data ? data[field] : undefined;
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    out[field] = typeof value === 'string' ? value.trim() : value;
  }
  return out;
}

/**
 * Base class for every enrichment provider (tier).
 *
 * Contract for subclasses:
 *   supports(lead)        -> boolean: can this provider look up this lead?
 *   performLookup(lead)   -> Promise<{status, data?, confidence?, cost?}>  (live HTTP call)
 *   mockLookup(lead)      -> {status, data?, confidence?}                    (SANDBOX_MODE)
 *
 * lookup() wraps performLookup() with: enable/support checks, sandbox
 * short-circuit, rate limiting, retries with backoff, a circuit breaker and
 * error normalisation. It NEVER throws; failures come back as status "error"
 * so the waterfall can continue to the next tier.
 */
class BaseProvider {
  constructor(options) {
    const o = options || {};
    if (!o.name) throw new Error('Provider requires a name.');
    this.name = o.name;
    this.tier = Number.isFinite(o.tier) ? o.tier : 1;
    this.costPerLookup = Number.isFinite(o.costPerLookup) ? o.costPerLookup : 1;
    this.enabled = o.enabled !== false;
    this.sandboxMode = o.sandboxMode !== false;
    this.mockMatchRate = Number.isFinite(o.mockMatchRate) ? o.mockMatchRate : 60;
    this.now = o.now || (() => Date.now());
    this.logger = (o.logger || defaultLogger).child({ provider: this.name });

    const rate = o.rateLimit || {};
    this.bucket = TokenBucket.perMinute(rate.requestsPerMinute || 60, rate.burst || 5, { now: this.now, sleep: o.sleep || sleep });
    this.breaker = new CircuitBreaker(Object.assign({ now: this.now }, o.circuit || {}));
    this.execute = createGuardedExecutor({
      provider: this.name,
      bucket: this.bucket,
      breaker: this.breaker,
      classify: (error) => classifyHttpError(error, this.name, this.now()),
      retry: Object.assign({
        sleep: o.sleep || sleep,
        onRetry: ({ attempt, delayMs, error }) => this.logger.warn('Retrying provider request', { attempt, delayMs, errorCode: error.code, status: error.status })
      }, o.retry || {})
    });
  }

  /** Worst-case credits one lookup can consume (used for budget reservation). */
  get maxCostPerLookup() {
    return this.costPerLookup;
  }

  supports() {
    return true;
  }

  // eslint-disable-next-line class-methods-use-this, no-unused-vars
  async performLookup(lead) {
    throw new Error('performLookup() must be implemented by the provider.');
  }

  // eslint-disable-next-line class-methods-use-this, no-unused-vars
  mockLookup(lead) {
    return { status: RESULT_STATUS.NO_MATCH };
  }

  /**
   * Run one lookup for a normalised lead.
   * @returns {Promise<{provider:string, status:string, data:object, confidence:number, cost:number, simulated:boolean, durationMs:number, errorCode?:string, reason?:string}>}
   */
  async lookup(lead) {
    const started = this.now();
    const finish = (result) => Object.assign({
      provider: this.name,
      data: {},
      confidence: 0,
      cost: 0,
      simulated: this.sandboxMode
    }, result, { durationMs: Math.max(0, this.now() - started) });

    if (!this.enabled) return finish({ status: RESULT_STATUS.SKIPPED, reason: 'disabled' });
    if (!this.supports(lead)) return finish({ status: RESULT_STATUS.SKIPPED, reason: 'unsupported_input' });

    if (this.sandboxMode) {
      const mock = this.mockLookup(lead) || { status: RESULT_STATUS.NO_MATCH };
      const matched = mock.status === RESULT_STATUS.MATCHED;
      return finish({
        status: mock.status,
        data: cleanEnrichment(mock.data),
        confidence: matched ? (mock.confidence || 0.8) : 0,
        // Sandbox spend is simulated so the savings report stays meaningful.
        cost: matched ? this.costPerLookup : 0
      });
    }

    try {
      const result = await this.execute(() => this.performLookup(lead));
      const matched = result.status === RESULT_STATUS.MATCHED;
      return finish({
        status: result.status,
        data: matched ? cleanEnrichment(result.data) : {},
        confidence: matched ? (result.confidence || 0.5) : 0,
        cost: Number.isFinite(result.cost) ? result.cost : (matched ? this.costPerLookup : 0),
        reason: result.reason
      });
    } catch (error) {
      const code = error.code || ERROR_CODES.UPSTREAM;
      this.logger.warn('Provider lookup failed', { leadId: lead.id, errorCode: code, status: error.status || null });
      return finish({ status: RESULT_STATUS.ERROR, errorCode: code, reason: error.message });
    }
  }

  /** Lightweight health snapshot for run summaries. */
  health() {
    return { provider: this.name, enabled: this.enabled, circuit: this.breaker.state, permanentFailure: this.breaker.permanent };
  }
}

module.exports = {
  ENRICHMENT_FIELDS,
  RESULT_STATUS,
  BaseProvider,
  cleanEnrichment,
  stableBucket
};
