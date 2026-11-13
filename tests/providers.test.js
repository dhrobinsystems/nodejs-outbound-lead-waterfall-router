/**
 * outbound-lead-waterfall-router :: Apollo, Clearbit and cache provider adapters
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
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ApolloProvider, mapApolloPerson, confidenceFromEmailStatus } = require('../src/providers/apolloProvider');
const { ClearbitProvider, mapClearbitCombined } = require('../src/providers/clearbitProvider');
const { CacheProvider } = require('../src/providers/cacheProvider');
const { fakeClock, httpError, mockHttp, providerOptions, silentLogger } = require('./helpers');

const LEAD = { id: 'L1', email: 'jane.doe@example.com', firstName: 'Jane', lastName: 'Doe', companyDomain: 'example.com' };

const APOLLO_PERSON = {
  person: {
    first_name: 'Jane', last_name: 'Doe', name: 'Jane Doe', title: 'VP Revenue Operations', seniority: 'vp',
    email: 'jane.doe@example.com', email_status: 'verified', linkedin_url: 'https://www.linkedin.com/in/example-profile',
    organization: { name: 'Example Co', primary_domain: 'example.com', industry: 'Computer Software', estimated_num_employees: 250 }
  }
};

test('apollo: sends a match request without personal-email or phone reveals', async () => {
  const clock = fakeClock();
  const http = mockHttp([{ data: APOLLO_PERSON }]);
  const apollo = new ApolloProvider(providerOptions(clock, { httpClient: http, costPerLookup: 1 }));
  const result = await apollo.lookup(LEAD);
  assert.equal(http.calls[0].url, '/people/match');
  assert.deepEqual(http.calls[0].body, {
    reveal_personal_emails: false, reveal_phone_number: false,
    email: 'jane.doe@example.com', first_name: 'Jane', last_name: 'Doe', domain: 'example.com'
  });
  assert.equal(result.status, 'matched');
  assert.equal(result.cost, 1);
  assert.equal(result.confidence, 0.95);
  assert.equal(result.data.title, 'VP Revenue Operations');
  assert.equal(result.data.employeeCount, 250);
  assert.equal(result.simulated, false);
});

test('apollo: a null person is a zero-cost no_match', async () => {
  const clock = fakeClock();
  const apollo = new ApolloProvider(providerOptions(clock, { httpClient: mockHttp([{ data: { person: null } }]) }));
  const result = await apollo.lookup(LEAD);
  assert.equal(result.status, 'no_match');
  assert.equal(result.cost, 0);
});

test('apollo: retries 429/503 then succeeds; 401 disables the tier for the run', async () => {
  const clock = fakeClock();
  const http = mockHttp([httpError(429, { 'retry-after': '1' }), httpError(503), { data: APOLLO_PERSON }]);
  const apollo = new ApolloProvider(providerOptions(clock, { httpClient: http }));
  assert.equal((await apollo.lookup(LEAD)).status, 'matched');
  assert.equal(http.calls.length, 3);

  const authHttp = mockHttp([httpError(401)]);
  const denied = new ApolloProvider(providerOptions(clock, { httpClient: authHttp }));
  const first = await denied.lookup(LEAD);
  assert.equal(first.status, 'error');
  assert.equal(first.errorCode, 'auth_failed');
  const second = await denied.lookup(LEAD);
  assert.equal(second.errorCode, 'circuit_open');
  assert.equal(authHttp.calls.length, 1, 'no further calls with a rejected key');
});

test('apollo: input support rules and missing-key auto-disable', () => {
  const clock = fakeClock();
  const apollo = new ApolloProvider(providerOptions(clock, { httpClient: mockHttp([{}]) }));
  assert.equal(apollo.supports({ email: 'a@example.com' }), true);
  assert.equal(apollo.supports({ firstName: 'A', lastName: 'B', companyDomain: 'example.com' }), true);
  assert.equal(apollo.supports({ firstName: 'A' }), false);
  const keyless = new ApolloProvider(providerOptions(clock, { apiKey: '' }));
  assert.equal(keyless.enabled, false);
});

test('apollo: mapping discards locked placeholder emails and scores email status', () => {
  const mapped = mapApolloPerson({ email: 'email_not_unlocked@domain.com', email_status: 'verified', organization: { website_url: 'https://www.example.org/about' } });
  assert.equal(mapped.data.email, undefined);
  assert.equal(mapped.data.companyDomain, 'example.org');
  assert.equal(mapped.confidence, 0.5);
  assert.equal(confidenceFromEmailStatus('guessed', true), 0.65);
  assert.equal(mapApolloPerson(null), null);
});

test('clearbit: maps a combined match with bearer auth semantics', async () => {
  const clock = fakeClock();
  const http = mockHttp([{
    status: 200,
    data: {
      person: { name: { givenName: 'Jane', familyName: 'Doe', fullName: 'Jane Doe' }, employment: { title: 'Head of RevOps', seniority: 'director' }, linkedin: { handle: 'in/example-profile' } },
      company: { name: 'Example Co', domain: 'example.com', category: { industry: 'Software' }, metrics: { employees: 120 }, geo: { countryCode: 'US' } }
    }
  }]);
  const clearbit = new ClearbitProvider(providerOptions(clock, { httpClient: http }));
  const result = await clearbit.lookup(LEAD);
  assert.equal(http.calls[0].url, '/v2/combined/find');
  assert.deepEqual(http.calls[0].config.params, { email: 'jane.doe@example.com' });
  assert.equal(result.status, 'matched');
  assert.equal(result.confidence, 0.85);
  assert.equal(result.data.linkedinUrl, 'https://www.linkedin.com/in/example-profile');
  assert.equal(result.data.country, 'US');
});

test('clearbit: 404 is no_match, 202 is pending, both free', async () => {
  const clock = fakeClock();
  const missing = new ClearbitProvider(providerOptions(clock, { httpClient: mockHttp([{ status: 404, data: {} }]) }));
  const queued = new ClearbitProvider(providerOptions(clock, { httpClient: mockHttp([{ status: 202, data: {} }]) }));
  assert.equal((await missing.lookup(LEAD)).status, 'no_match');
  const pending = await queued.lookup(LEAD);
  assert.equal(pending.status, 'pending');
  assert.equal(pending.cost, 0);
});

test('clearbit: requires an email and maps company-only payloads', async () => {
  const clock = fakeClock();
  const clearbit = new ClearbitProvider(providerOptions(clock, { httpClient: mockHttp([{}]) }));
  const skipped = await clearbit.lookup({ id: 'x', firstName: 'A', lastName: 'B', companyDomain: 'example.com' });
  assert.equal(skipped.status, 'skipped');
  assert.equal(skipped.reason, 'unsupported_input');
  const mapped = mapClearbitCombined({ person: null, company: { name: 'Example Co', domain: 'example.com' } }, 'a@example.com');
  assert.equal(mapped.confidence, 0.6);
  assert.equal(mapClearbitCombined({}, 'a@example.com'), null);
});

test('sandbox: providers never call HTTP and return deterministic results', async () => {
  const http = mockHttp([new Error('network must not be used')]);
  const a = new ApolloProvider({ sandboxMode: true, httpClient: http, logger: silentLogger });
  const b = new ApolloProvider({ sandboxMode: true, httpClient: http, logger: silentLogger });
  const r1 = await a.lookup(LEAD);
  const r2 = await b.lookup(LEAD);
  assert.equal(http.calls.length, 0);
  assert.deepEqual(r1.data, r2.data);
  assert.equal(r1.simulated, true);
});

test('cache: positive hits, negative hits, TTL expiry and hashed keys', async () => {
  const clock = fakeClock();
  const cache = new CacheProvider({ now: clock.now, ttlMs: 1000, negativeTtlMs: 500, logger: silentLogger });
  assert.equal((await cache.lookup(LEAD)).status, 'miss');
  await cache.store(LEAD, { status: 'matched', data: { title: 'CTO' }, confidence: 0.9, sources: { title: 'apollo' } });
  const hit = await cache.lookup(LEAD);
  assert.equal(hit.status, 'matched');
  assert.equal(hit.data.title, 'CTO');
  assert.match(cache.keyFor(LEAD), /^[a-f0-9]{64}$/);
  clock.advance(1001);
  assert.equal((await cache.lookup(LEAD)).status, 'miss');

  const other = { email: 'nobody@example.net' };
  await cache.store(other, { status: 'no_match' });
  assert.equal((await cache.lookup(other)).status, 'no_match');
  clock.advance(501);
  assert.equal((await cache.lookup(other)).status, 'miss');
});

test('cache: LRU eviction, forget() for erasure requests, atomic file persistence', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waterfall-cache-'));
  const file = path.join(dir, 'cache.json');
  const cache = new CacheProvider({ filePath: file, maxEntries: 2, logger: silentLogger });
  await cache.store({ email: 'a@example.com' }, { status: 'matched', data: { title: 'A' } });
  await cache.store({ email: 'b@example.com' }, { status: 'matched', data: { title: 'B' } });
  await cache.store({ email: 'c@example.com' }, { status: 'matched', data: { title: 'C' } });
  assert.equal(cache.entries.size, 2);
  assert.equal(cache.stats.evictions, 1);
  assert.equal(await cache.forget({ email: 'c@example.com' }), true);
  assert.equal(await cache.flush(), true);
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');
  assert.ok(!fs.readFileSync(file, 'utf8').includes('b@example.com'), 'keys are hashed');
  const reloaded = new CacheProvider({ filePath: file, logger: silentLogger });
  assert.equal((await reloaded.lookup({ email: 'b@example.com' })).data.title, 'B');
  fs.writeFileSync(file, '{corrupt');
  assert.equal(new CacheProvider({ filePath: file, logger: silentLogger }).entries.size, 0, 'corrupt cache is ignored');
});
