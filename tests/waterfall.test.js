/**
 * outbound-lead-waterfall-router :: Orchestrator, budget, config, normalisation & logging
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
const path = require('path');
const winston = require('winston');
const { Writable } = require('stream');
const {
  WaterfallRouter, BudgetLedger, buildConfig, normalizeLead, mergeEnrichment, evaluateCompleteness, parseArgs, LEAD_STATUS
} = require('../src/index');
const { CacheProvider } = require('../src/providers/cacheProvider');
const { createLogger, redact, maskEmail } = require('../src/utils/logger');
const { silentLogger } = require('./helpers');

/** Scriptable in-memory provider for orchestration tests. */
function stubProvider(name, cost, responder, options) {
  const o = options || {};
  const calls = [];
  return {
    name,
    costPerLookup: cost,
    maxCostPerLookup: cost,
    enabled: o.enabled !== false,
    calls,
    supports: o.supports || (() => true),
    lookup: async (lead) => {
      calls.push(lead);
      const r = responder(lead) || { status: 'no_match' };
      return Object.assign({ provider: name, data: {}, confidence: 0, cost: r.status === 'matched' ? cost : 0, durationMs: 1 }, r);
    },
    health: () => ({ provider: name, enabled: true, circuit: 'closed', permanentFailure: false })
  };
}

function routerWith(providers, envOverrides, cache) {
  const { config } = buildConfig(Object.assign({ SANDBOX_MODE: 'true' }, envOverrides || {}));
  return new WaterfallRouter({ config, providers, cache: cache || new CacheProvider({ logger: silentLogger }), logger: silentLogger });
}

const LEAD = { id: 'L1', email: 'jane.doe@example.com', first_name: 'Jane', last_name: 'Doe' };

test('waterfall: stops at the first tier that satisfies the requirements', async () => {
  const apollo = stubProvider('apollo', 1, () => ({ status: 'matched', confidence: 0.95, data: { title: 'CRO' } }));
  const clearbit = stubProvider('clearbit', 1, () => ({ status: 'matched', confidence: 0.85, data: { industry: 'Software' } }));
  const record = await routerWith([apollo, clearbit]).enrichLead(LEAD, 0);
  assert.equal(record.status, LEAD_STATUS.ENRICHED);
  assert.equal(clearbit.calls.length, 0, 'expensive fallback never called');
  assert.equal(record.credits, 1);
  assert.equal(record.sources.title, 'apollo');
  assert.equal(record.sources.email, 'input');
});

test('waterfall: later tiers fill only the missing fields and receive earlier discoveries as hints', async () => {
  const apollo = stubProvider('apollo', 1, () => ({ status: 'matched', confidence: 0.75, data: { email: 'john.sample@example.org', companyName: 'Apollo Name' } }));
  const clearbit = stubProvider('clearbit', 1, () => ({ status: 'matched', confidence: 0.85, data: { title: 'Head of Sales', companyName: 'Clearbit Name' } }), { supports: (lead) => Boolean(lead.email) });
  const record = await routerWith([apollo, clearbit]).enrichLead({ first_name: 'John', last_name: 'Sample', company_domain: 'example.org' }, 0);
  assert.equal(clearbit.calls[0].email, 'john.sample@example.org', 'email found by tier 1 unlocks tier 2');
  assert.equal(record.data.companyName, 'Apollo Name', 'cheaper tier wins on conflicts');
  assert.equal(record.data.title, 'Head of Sales');
  assert.equal(record.status, LEAD_STATUS.ENRICHED);
  assert.equal(record.confidence, 0.75);
});

test('waterfall: low confidence keeps the waterfall going', async () => {
  const apollo = stubProvider('apollo', 1, () => ({ status: 'matched', confidence: 0.4, data: { title: 'Maybe' } }));
  const clearbit = stubProvider('clearbit', 1, () => ({ status: 'no_match' }));
  const record = await routerWith([apollo, clearbit], { MIN_CONFIDENCE: '0.7' }).enrichLead(LEAD, 0);
  assert.equal(clearbit.calls.length, 1);
  assert.equal(record.status, LEAD_STATUS.PARTIAL);
});

test('waterfall: cache hit costs nothing and skips every paid tier', async () => {
  const apollo = stubProvider('apollo', 1, () => ({ status: 'matched', confidence: 0.95, data: { title: 'CRO' } }));
  const router = routerWith([apollo]);
  await router.enrichLead(LEAD, 0);
  const second = await router.enrichLead(LEAD, 0);
  assert.equal(apollo.calls.length, 1);
  assert.equal(second.credits, 0);
  assert.equal(second.status, LEAD_STATUS.ENRICHED);
  assert.ok(second.cachedAt);
  assert.equal(second.sources.title, 'cache:apollo');
});

test('waterfall: confirmed misses are negative-cached; misses caused by errors are not', async () => {
  const miss = stubProvider('apollo', 1, () => ({ status: 'no_match' }));
  const router = routerWith([miss]);
  await router.enrichLead(LEAD, 0);
  const again = await router.enrichLead(LEAD, 0);
  assert.equal(miss.calls.length, 1);
  assert.equal(again.status, LEAD_STATUS.NO_MATCH);

  const failing = stubProvider('apollo', 1, () => ({ status: 'error', errorCode: 'upstream_error' }));
  const router2 = routerWith([failing]);
  await router2.enrichLead(LEAD, 0);
  await router2.enrichLead(LEAD, 0);
  assert.equal(failing.calls.length, 2, 'errors are retried on the next run');
});

test('waterfall: FORCE_REFRESH bypasses the cache', async () => {
  const apollo = stubProvider('apollo', 1, () => ({ status: 'matched', confidence: 0.95, data: { title: 'CRO' } }));
  const router = routerWith([apollo], { FORCE_REFRESH: 'true' });
  await router.enrichLead(LEAD, 0);
  await router.enrichLead(LEAD, 0);
  assert.equal(apollo.calls.length, 2);
});

test('waterfall: provider errors degrade gracefully to the next tier', async () => {
  const apollo = stubProvider('apollo', 1, () => ({ status: 'error', errorCode: 'timeout' }));
  const clearbit = stubProvider('clearbit', 2, () => ({ status: 'matched', confidence: 0.85, data: { title: 'CTO' } }));
  const record = await routerWith([apollo, clearbit]).enrichLead(LEAD, 0);
  assert.equal(record.status, LEAD_STATUS.ENRICHED);
  assert.equal(record.attempts.find((a) => a.provider === 'apollo').errorCode, 'timeout');
});

test('budget: ledger reserve/settle never allows overspend', () => {
  const ledger = new BudgetLedger(2);
  assert.equal(ledger.reserve(1), true);
  assert.equal(ledger.reserve(1), true);
  assert.equal(ledger.reserve(1), false);
  ledger.settle(1, 0);
  assert.equal(ledger.remaining, 1);
  ledger.settle(1, 1);
  assert.equal(ledger.spent, 1);
});

test('budget: the run stops calling paid tiers once MAX_CREDITS_PER_RUN is reached', async () => {
  const apollo = stubProvider('apollo', 1, () => ({ status: 'matched', confidence: 0.95, data: { title: 'CRO' } }));
  const router = routerWith([apollo], { MAX_CREDITS_PER_RUN: '2', ENRICHMENT_CONCURRENCY: '5' });
  const leads = Array.from({ length: 6 }, (_, i) => ({ email: 'person' + i + '@example.com' }));
  const { results, summary } = await router.run(leads);
  assert.equal(apollo.calls.length, 2);
  assert.equal(summary.creditsSpent, 2);
  assert.equal(results.filter((r) => r.status === LEAD_STATUS.BUDGET_EXHAUSTED).length, 4);
});

test('run: preserves input order, isolates invalid leads and reports savings', async () => {
  const apollo = stubProvider('apollo', 1, (lead) => (lead.email.startsWith('hit') ? { status: 'matched', confidence: 0.95, data: { title: 'VP' } } : { status: 'no_match' }));
  const clearbit = stubProvider('clearbit', 1, () => ({ status: 'no_match' }));
  const router = routerWith([apollo, clearbit]);
  const { results, summary } = await router.run([{ id: 'a', email: 'hit1@example.com' }, { id: 'b', email: 'not-an-email' }, { id: 'c', email: 'miss@example.com' }]);
  assert.deepEqual(results.map((r) => r.id), ['a', 'b', 'c']);
  assert.deepEqual(results.map((r) => r.status), ['enriched', 'invalid', 'no_match']);
  assert.equal(summary.validLeads, 2);
  assert.equal(summary.matchRate, 0.5);
  assert.equal(summary.naiveCreditsEstimate, 4);
  assert.equal(summary.creditsSaved, 3);
});

test('run: identical leads processed concurrently are looked up only once', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const apollo = stubProvider('apollo', 1, () => ({ status: 'matched', confidence: 0.95, data: { title: 'CRO' } }));
  const slow = Object.assign({}, apollo, { lookup: async (lead) => { await gate; return apollo.lookup(lead); } });
  const router = routerWith([slow], { ENRICHMENT_CONCURRENCY: '4' });
  const pending = router.run([{ id: 'a', email: 'same@example.com' }, { id: 'b', email: 'SAME@example.com' }]);
  setImmediate(release);
  const { results, summary } = await pending;
  assert.equal(apollo.calls.length, 1);
  assert.equal(summary.creditsSpent, 1);
  assert.deepEqual(results.map((r) => r.id), ['a', 'b']);
  assert.equal(results[1].attempts[0].provider, 'dedupe');
  assert.equal(results[1].status, LEAD_STATUS.ENRICHED);
});

test('normalize: accepts snake_case, lowercases email, derives domain, rejects junk', () => {
  const { ok, lead } = normalizeLead({ Email: 'x', email: ' Jane.Doe@Example.COM ', first_name: 'Jane\u0000', last_name: 'Doe', website: 'https://www.example.com/team' }, 4);
  assert.equal(ok, true);
  assert.equal(lead.id, 'row-5');
  assert.equal(lead.email, 'jane.doe@example.com');
  assert.equal(lead.firstName, 'Jane');
  assert.equal(lead.companyDomain, 'example.com');
  const bad = normalizeLead({ email: 'nope', linkedin_url: 'http://evil.example.com' }, 0);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.errors, ['invalid_email', 'invalid_linkedin_url', 'insufficient_identifiers']);
  assert.equal(normalizeLead({ first_name: 'A', last_name: 'B', company: 'Example Co' }, 0).ok, true);
});

test('merge & completeness: first non-empty value wins; confidence is the weakest contributor', () => {
  const merged = {};
  const sources = {};
  mergeEnrichment(merged, sources, { title: 'A', industry: '' }, 'apollo');
  mergeEnrichment(merged, sources, { title: 'B', industry: 'Software' }, 'clearbit');
  assert.deepEqual(merged, { title: 'A', industry: 'Software' });
  const result = evaluateCompleteness({ email: 'x', title: 'A' }, { email: 'input', title: 'apollo' }, { input: 1, apollo: 0.65 }, ['email', 'title'], 0.7);
  assert.deepEqual(result, { complete: false, missing: [], confidence: 0.65 });
});

test('config: sandbox by default, validation of order/fields, live requires a key', () => {
  assert.equal(buildConfig({}).config.sandboxMode, true);
  assert.equal(buildConfig({ SANDBOX_MODE: 'typo' }).config.sandboxMode, true);
  assert.ok(buildConfig({ WATERFALL_ORDER: 'apollo,zoominfo' }).errors.some((e) => /zoominfo/.test(e)));
  assert.ok(buildConfig({ WATERFALL_ORDER: 'apollo,apollo' }).errors.some((e) => /twice/.test(e)));
  assert.ok(buildConfig({ REQUIRED_FIELDS: 'email,favoriteColor' }).errors.some((e) => /favoriteColor/.test(e)));
  assert.ok(buildConfig({ SANDBOX_MODE: 'false' }).errors.some((e) => /no provider/.test(e)));
  const live = buildConfig({ SANDBOX_MODE: 'false', APOLLO_API_KEY: 'placeholder', CLEARBIT_ENABLED: 'false' });
  assert.deepEqual(live.errors, []);
  assert.equal(live.config.sandboxMode, false);
  assert.ok(buildConfig({ MIN_CONFIDENCE: '5' }).errors.some((e) => /MIN_CONFIDENCE/.test(e)));
});

test('cli: argument parsing', () => {
  assert.deepEqual(parseArgs(['-i', 'in.json', '--output', 'out.json', '--sandbox']), { input: 'in.json', output: 'out.json', sandbox: true, help: false });
  assert.throws(() => parseArgs(['--bogus']), /Unknown argument/);
});

test('logger: secrets and PII are redacted at any depth, emails are masked', () => {
  assert.equal(maskEmail('contact jane.doe@example.com now'), 'contact j***@example.com now');
  const out = redact({ apiKey: 'abc', nested: { authorization: 'Bearer x', firstName: 'Jane', note: 'mail a.b@example.org' }, list: ['c@example.net'] });
  assert.deepEqual(out, { apiKey: '[REDACTED]', nested: { authorization: '[REDACTED]', firstName: '[PII]', note: 'mail a***@example.org' }, list: ['c***@example.net'] });
});

test('logger: real winston output contains no raw email or key', () => {
  const lines = [];
  const stream = new Writable({ write(chunk, enc, cb) { lines.push(chunk.toString()); cb(); } });
  const log = createLogger({ level: 'info' });
  log.clear();
  log.add(new winston.transports.Stream({ stream }));
  log.info('lookup done for jane.doe@example.com', { email: 'jane.doe@example.com', apiKey: 'placeholder-secret', lastName: 'Doe' });
  const text = lines.join('');
  assert.ok(text.includes('j***@example.com'));
  assert.ok(!text.includes('jane.doe@'));
  assert.ok(!text.includes('placeholder-secret'));
  assert.ok(!text.includes('"Doe"'));
});

test('repository: sample data uses reserved example domains only and no key-like strings', () => {
  const root = path.resolve(__dirname, '..');
  const sample = fs.readFileSync(path.join(root, 'samples', 'leads.example.json'), 'utf8');
  const emails = sample.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || [];
  assert.ok(emails.length > 0);
  for (const email of emails) assert.match(email.split('@')[1], /(^|\.)example\.(com|net|org)$/);
  const envExample = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  assert.match(envExample, /^APOLLO_API_KEY=$/m);
  assert.match(envExample, /^CLEARBIT_API_KEY=$/m);
  assert.match(envExample, /^SANDBOX_MODE=true$/m);
});
