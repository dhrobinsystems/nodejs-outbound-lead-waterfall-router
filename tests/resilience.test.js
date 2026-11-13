/**
 * outbound-lead-waterfall-router :: Rate limiting, retries, circuit breaker, error classification
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

const test = require('node:test');
const assert = require('node:assert/strict');
const { TokenBucket, CircuitBreaker, withRetry, createGuardedExecutor } = require('../src/utils/rateLimiter');
const { ProviderError, ERROR_CODES, parseRetryAfter, classifyHttpError } = require('../src/utils/errors');
const { fakeClock, httpError } = require('./helpers');

test('token bucket: allows a burst, then waits for refill', async () => {
  const clock = fakeClock();
  const bucket = new TokenBucket({ capacity: 2, refillPerSecond: 1, now: clock.now, sleep: clock.sleep });
  await bucket.acquire();
  await bucket.acquire();
  assert.deepEqual(clock.slept, []);
  await bucket.acquire();
  assert.equal(clock.slept.length, 1);
  assert.equal(Math.round(clock.slept[0]), 1000);
});

test('token bucket: perMinute converts RPM to a refill rate', () => {
  const bucket = TokenBucket.perMinute(120, 4);
  assert.equal(bucket.refillPerSecond, 2);
  assert.equal(bucket.capacity, 4);
  assert.throws(() => new TokenBucket({ capacity: 0, refillPerSecond: 1 }), /positive/);
});

test('token bucket: penalize() blocks every caller until the window passes', async () => {
  const clock = fakeClock();
  const bucket = new TokenBucket({ capacity: 5, refillPerSecond: 5, now: clock.now, sleep: clock.sleep });
  bucket.penalize(3000);
  await bucket.acquire();
  assert.ok(clock.slept[0] >= 3000);
});

test('circuit breaker: opens after threshold, half-opens after cooldown, closes on success', () => {
  const clock = fakeClock();
  const breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1000, now: clock.now });
  breaker.recordFailure();
  assert.equal(breaker.canRequest(), true);
  breaker.recordFailure();
  assert.equal(breaker.state, 'open');
  assert.equal(breaker.canRequest(), false);
  clock.advance(1000);
  assert.equal(breaker.canRequest(), true);
  assert.equal(breaker.state, 'half_open');
  breaker.recordSuccess();
  assert.equal(breaker.state, 'closed');
});

test('circuit breaker: a permanent trip never recovers', () => {
  const clock = fakeClock();
  const breaker = new CircuitBreaker({ cooldownMs: 10, now: clock.now });
  breaker.trip(true);
  clock.advance(100000);
  assert.equal(breaker.canRequest(), false);
});

test('retry: retries retryable errors with exponential backoff, then succeeds', async () => {
  const clock = fakeClock();
  let calls = 0;
  const result = await withRetry(async () => {
    calls += 1;
    if (calls < 3) throw new ProviderError('flaky', { retryable: true });
    return 'ok';
  }, { maxRetries: 3, baseDelayMs: 100, sleep: clock.sleep, random: () => 1 });
  assert.equal(result, 'ok');
  assert.deepEqual(clock.slept, [100, 200]);
});

test('retry: non-retryable errors fail immediately; exhausted retries rethrow', async () => {
  const clock = fakeClock();
  let calls = 0;
  await assert.rejects(withRetry(async () => { calls += 1; throw new ProviderError('bad', { retryable: false }); }, { sleep: clock.sleep }), /bad/);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(withRetry(async () => { calls += 1; throw new ProviderError('down', { retryable: true }); }, { maxRetries: 2, sleep: clock.sleep }), /down/);
  assert.equal(calls, 3);
});

test('retry: honours Retry-After, but refuses absurdly long waits', async () => {
  const clock = fakeClock();
  let calls = 0;
  await withRetry(async () => {
    calls += 1;
    if (calls === 1) throw new ProviderError('429', { retryable: true, retryAfterMs: 7000 });
    return true;
  }, { sleep: clock.sleep });
  assert.deepEqual(clock.slept, [7000]);
  await assert.rejects(withRetry(async () => { throw new ProviderError('429', { retryable: true, retryAfterMs: 3600000 }); }, { sleep: clock.sleep }), /429/);
});

test('errors: Retry-After parses seconds and HTTP dates', () => {
  assert.equal(parseRetryAfter('3'), 3000);
  assert.equal(parseRetryAfter('1.5'), 1500);
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(parseRetryAfter('Thu, 01 Jan 2026 00:00:10 GMT', now), 10000);
  assert.equal(parseRetryAfter('garbage'), null);
  assert.equal(parseRetryAfter(undefined), null);
});

test('errors: HTTP statuses map to the right codes and retryability', () => {
  const c = (status, headers) => classifyHttpError(httpError(status, headers), 'apollo');
  assert.equal(c(401).code, ERROR_CODES.AUTH);
  assert.equal(c(403).retryable, false);
  assert.equal(c(429, { 'retry-after': '2' }).retryAfterMs, 2000);
  assert.equal(c(429).retryable, true);
  assert.equal(c(422).code, ERROR_CODES.INVALID_REQUEST);
  assert.equal(c(503).code, ERROR_CODES.UPSTREAM);
  assert.equal(c(503).retryable, true);
  const timeout = Object.assign(new Error('timeout'), { code: 'ECONNABORTED' });
  assert.equal(classifyHttpError(timeout, 'apollo').code, ERROR_CODES.TIMEOUT);
  assert.equal(classifyHttpError(new Error('boom'), 'apollo').code, ERROR_CODES.NETWORK);
});

test('errors: classified errors never carry request config, keys or response bodies', () => {
  const error = classifyHttpError(httpError(500), 'apollo');
  const serialized = JSON.stringify(error) + error.message;
  assert.ok(!serialized.includes('should-not-leak'));
  assert.ok(!serialized.includes('never-logged'));
});

test('guarded executor: auth failure trips the breaker permanently; later calls short-circuit', async () => {
  const clock = fakeClock();
  const breaker = new CircuitBreaker({ now: clock.now });
  const execute = createGuardedExecutor({
    provider: 'apollo',
    bucket: new TokenBucket({ capacity: 5, refillPerSecond: 5, now: clock.now, sleep: clock.sleep }),
    breaker,
    classify: (e) => classifyHttpError(e, 'apollo'),
    retry: { sleep: clock.sleep }
  });
  await assert.rejects(execute(async () => { throw httpError(401); }), (e) => e.code === ERROR_CODES.AUTH);
  assert.equal(breaker.permanent, true);
  let called = false;
  await assert.rejects(execute(async () => { called = true; }), (e) => e.code === ERROR_CODES.CIRCUIT_OPEN);
  assert.equal(called, false);
});
