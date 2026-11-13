/**
 * outbound-lead-waterfall-router :: Shared test doubles (fake clock, mock HTTP clients)
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

const { createLogger } = require('../src/utils/logger');

const silentLogger = createLogger({ silent: true });

/** Deterministic clock: sleep() advances time instantly. */
function fakeClock(start) {
  let current = start || 1_800_000_000_000;
  const slept = [];
  return {
    now: () => current,
    sleep: async (ms) => { slept.push(ms); current += Math.max(0, ms); },
    advance: (ms) => { current += ms; },
    slept
  };
}

/** Build an axios-style HTTP error. */
function httpError(status, headers) {
  const error = new Error('Request failed with status code ' + status);
  error.response = { status, headers: headers || {}, data: { secret: 'never-logged' } };
  error.config = { headers: { 'x-api-key': 'should-not-leak' } };
  return error;
}

/**
 * Mock HTTP client. `script` is a list of responses/errors returned in order;
 * the last entry repeats. Each entry: { status, data, headers } or an Error.
 */
function mockHttp(script) {
  const calls = [];
  const queue = script.slice();
  const respond = async (method, url, bodyOrConfig, config) => {
    calls.push({ method, url, body: method === 'post' ? bodyOrConfig : undefined, config: method === 'get' ? bodyOrConfig : config });
    const entry = queue.length > 1 ? queue.shift() : queue[0];
    if (entry instanceof Error) throw entry;
    return Object.assign({ status: 200, headers: {}, data: {} }, entry);
  };
  return {
    calls,
    post: (url, body, config) => respond('post', url, body, config),
    get: (url, config) => respond('get', url, config)
  };
}

function providerOptions(clock, extra) {
  return Object.assign({
    sandboxMode: false,
    apiKey: 'test-key-placeholder',
    logger: silentLogger,
    now: clock.now,
    sleep: clock.sleep,
    retry: { maxRetries: 2, baseDelayMs: 100, random: () => 0 },
    rateLimit: { requestsPerMinute: 600, burst: 10 }
  }, extra || {});
}

module.exports = {
  silentLogger,
  fakeClock,
  httpError,
  mockHttp,
  providerOptions
};
