/**
 * outbound-lead-waterfall-router :: Token bucket, retry with backoff, circuit breaker
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

const { ERROR_CODES, ProviderError } = require('./errors');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/**
 * Token-bucket rate limiter.
 * - `capacity` = burst size, `refillPerSecond` = sustained rate.
 * - `penalize(ms)` pauses every caller (used when a provider returns 429),
 *   so concurrent workers back off together instead of hammering the API.
 */
class TokenBucket {
  constructor(options) {
    const o = options || {};
    if (!(o.capacity > 0) || !(o.refillPerSecond > 0)) {
      throw new Error('TokenBucket requires positive capacity and refillPerSecond.');
    }
    this.capacity = o.capacity;
    this.refillPerSecond = o.refillPerSecond;
    this.now = o.now || (() => Date.now());
    this.sleep = o.sleep || sleep;
    this.tokens = o.capacity;
    this.lastRefill = this.now();
    this.blockedUntil = 0;
  }

  /** Convenience: build from a requests-per-minute budget. */
  static perMinute(requestsPerMinute, burst, extra) {
    return new TokenBucket(Object.assign({ capacity: Math.max(1, burst || 1), refillPerSecond: requestsPerMinute / 60 }, extra || {}));
  }

  refill() {
    const now = this.now();
    const elapsed = Math.max(0, now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSecond);
    this.lastRefill = now;
  }

  /** Wait until `tokens` are available, then consume them. */
  async acquire(tokens) {
    const needed = tokens || 1;
    if (needed > this.capacity) throw new Error('Requested tokens exceed bucket capacity.');
    // The check-and-consume below runs synchronously, so it is race-free in Node's event loop.
    for (;;) {
      const now = this.now();
      if (now < this.blockedUntil) {
        await this.sleep(this.blockedUntil - now);
        continue;
      }
      this.refill();
      if (this.tokens >= needed) {
        this.tokens -= needed;
        return;
      }
      await this.sleep(((needed - this.tokens) / this.refillPerSecond) * 1000);
    }
  }

  /** Block all callers for `ms` and drain the bucket (server-side throttling signal). */
  penalize(ms) {
    this.blockedUntil = Math.max(this.blockedUntil, this.now() + Math.max(0, ms));
    this.tokens = 0;
    this.lastRefill = this.blockedUntil;
  }
}

/**
 * Circuit breaker: after `failureThreshold` consecutive failures the
 * provider is skipped for `cooldownMs`, then one probe is allowed
 * (half-open). `trip(true)` opens it permanently (e.g. invalid API key).
 */
class CircuitBreaker {
  constructor(options) {
    const o = options || {};
    this.failureThreshold = o.failureThreshold || 5;
    this.cooldownMs = o.cooldownMs || 60000;
    this.now = o.now || (() => Date.now());
    this.state = 'closed';
    this.failures = 0;
    this.openedAt = 0;
    this.permanent = false;
  }

  canRequest() {
    if (this.state === 'closed') return true;
    if (this.permanent) return false;
    if (this.state === 'open' && this.now() - this.openedAt >= this.cooldownMs) {
      this.state = 'half_open';
      return true;
    }
    return this.state === 'half_open';
  }

  recordSuccess() {
    if (this.permanent) return;
    this.state = 'closed';
    this.failures = 0;
  }

  recordFailure() {
    if (this.permanent) return;
    this.failures += 1;
    if (this.state === 'half_open' || this.failures >= this.failureThreshold) this.open();
  }

  open() {
    this.state = 'open';
    this.openedAt = this.now();
  }

  trip(permanent) {
    this.permanent = Boolean(permanent);
    this.open();
  }
}

/**
 * Retry an async operation with exponential backoff + jitter.
 * Only errors flagged `retryable` are retried. A server-provided
 * `retryAfterMs` takes precedence over the computed delay, but is capped
 * at `maxRetryAfterMs` to avoid stalling a run indefinitely.
 */
async function withRetry(operation, options) {
  const o = options || {};
  const maxRetries = Number.isInteger(o.maxRetries) ? o.maxRetries : 3;
  const baseDelayMs = o.baseDelayMs || 500;
  const maxDelayMs = o.maxDelayMs || 10000;
  const maxRetryAfterMs = o.maxRetryAfterMs || 60000;
  const wait = o.sleep || sleep;
  const random = o.random || Math.random;

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (!error || !error.retryable || attempt >= maxRetries) throw error;
      let delay;
      if (Number.isFinite(error.retryAfterMs)) {
        if (error.retryAfterMs > maxRetryAfterMs) throw error;
        delay = error.retryAfterMs;
      } else {
        const exponential = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt));
        delay = Math.round(exponential * (0.5 + random() * 0.5));
      }
      if (typeof o.onRetry === 'function') o.onRetry({ attempt: attempt + 1, delayMs: delay, error });
      await wait(delay);
    }
  }
}

/**
 * Compose bucket + breaker + retry into one guarded executor.
 * @param {object} deps
 * @param {string} deps.provider
 * @param {TokenBucket} deps.bucket
 * @param {CircuitBreaker} deps.breaker
 * @param {(error:any)=>ProviderError} deps.classify
 * @param {object} [deps.retry] options for withRetry
 * @returns {(fn:()=>Promise<any>)=>Promise<any>}
 */
function createGuardedExecutor(deps) {
  const { provider, bucket, breaker, classify } = deps;
  const retryOptions = deps.retry || {};
  const circuitOpen = () => new ProviderError(provider + ' circuit is open; provider temporarily skipped.', {
    provider, code: ERROR_CODES.CIRCUIT_OPEN, retryable: false
  });
  return function execute(fn) {
    if (!breaker.canRequest()) return Promise.reject(circuitOpen());
    return withRetry(async (attempt) => {
      // Re-check on every retry: the breaker may have opened while we waited.
      if (attempt > 0 && !breaker.canRequest()) throw circuitOpen();
      await bucket.acquire(1);
      try {
        const result = await fn();
        breaker.recordSuccess();
        return result;
      } catch (raw) {
        const error = classify(raw);
        if (error.code === ERROR_CODES.RATE_LIMITED) {
          bucket.penalize(Number.isFinite(error.retryAfterMs) ? error.retryAfterMs : 1000);
        } else if (error.code === ERROR_CODES.AUTH) {
          breaker.trip(true);
        } else if (error.retryable) {
          breaker.recordFailure();
        }
        throw error;
      }
    }, retryOptions);
  };
}

module.exports = {
  sleep,
  TokenBucket,
  CircuitBreaker,
  withRetry,
  createGuardedExecutor
};
