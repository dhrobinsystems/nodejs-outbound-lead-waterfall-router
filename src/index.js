#!/usr/bin/env node
/**
 * outbound-lead-waterfall-router :: Waterfall orchestrator, configuration & CLI entry point
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
const { logger: defaultLogger, maskEmail } = require('./utils/logger');
const { CacheProvider } = require('./providers/cacheProvider');
const { ApolloProvider } = require('./providers/apolloProvider');
const { ClearbitProvider } = require('./providers/clearbitProvider');
const { ENRICHMENT_FIELDS, RESULT_STATUS } = require('./providers/baseProvider');

const DAY_MS = 24 * 60 * 60 * 1000;

/** Final per-lead outcomes. */
const LEAD_STATUS = Object.freeze({
  ENRICHED: 'enriched',           // all required fields present at or above MIN_CONFIDENCE
  PARTIAL: 'partial',             // some data found, requirements not fully met
  NO_MATCH: 'no_match',           // every eligible tier returned no match
  BUDGET_EXHAUSTED: 'budget_exhausted',
  INVALID: 'invalid'              // input failed validation; no provider was called
});

/** Registry of external (paid) providers that WATERFALL_ORDER can reference. */
const PROVIDER_FACTORIES = Object.freeze({
  apollo: (cfg, shared) => new ApolloProvider(Object.assign({}, shared, cfg.providers.apollo)),
  clearbit: (cfg, shared) => new ClearbitProvider(Object.assign({}, shared, cfg.providers.clearbit))
});

/* ------------------------------------------------------------------------ */
/* Configuration                                                            */
/* ------------------------------------------------------------------------ */

function readBoolean(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const v = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  return null;
}

function readNumber(env, key, fallback, min, max, errors) {
  const raw = env[key];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    errors.push(key + ' must be a number between ' + min + ' and ' + max + '.');
    return fallback;
  }
  return value;
}

function readList(raw, fallback) {
  if (raw === undefined || String(raw).trim() === '') return fallback.slice();
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Build and validate configuration from environment variables.
 * SANDBOX_MODE is ON unless explicitly set to a recognised false value.
 * @returns {{config:object, errors:string[], warnings:string[]}}
 */
function buildConfig(env) {
  const source = env || {};
  const errors = [];
  const warnings = [];

  let sandboxMode = readBoolean(source.SANDBOX_MODE, true);
  if (sandboxMode === null) {
    errors.push('SANDBOX_MODE must be true or false; sandbox stays ENABLED.');
    sandboxMode = true;
  }

  const order = readList(source.WATERFALL_ORDER, ['apollo', 'clearbit']).map((s) => s.toLowerCase());
  for (const name of order) {
    if (!PROVIDER_FACTORIES[name]) errors.push('WATERFALL_ORDER contains unknown provider "' + name + '". Known: ' + Object.keys(PROVIDER_FACTORIES).join(', ') + '.');
  }
  if (new Set(order).size !== order.length) errors.push('WATERFALL_ORDER must not list a provider twice.');

  const requiredFields = readList(source.REQUIRED_FIELDS, ['email', 'title', 'companyDomain']);
  for (const field of requiredFields) {
    if (!ENRICHMENT_FIELDS.includes(field)) errors.push('REQUIRED_FIELDS contains unknown field "' + field + '".');
  }

  const providerConfig = (prefix, defaults) => {
    const enabled = readBoolean(source[prefix + '_ENABLED'], true);
    if (enabled === null) errors.push(prefix + '_ENABLED must be true or false.');
    return {
      enabled: enabled !== false,
      apiKey: source[prefix + '_API_KEY'] || '',
      baseUrl: source[prefix + '_BASE_URL'] || defaults.baseUrl,
      costPerLookup: readNumber(source, prefix + '_COST_PER_LOOKUP', defaults.cost, 0, 1000, errors),
      timeoutMs: readNumber(source, prefix + '_TIMEOUT_MS', 15000, 1000, 120000, errors),
      rateLimit: {
        requestsPerMinute: readNumber(source, prefix + '_RATE_LIMIT_PER_MINUTE', defaults.rpm, 1, 10000, errors),
        burst: readNumber(source, prefix + '_RATE_LIMIT_BURST', defaults.burst, 1, 1000, errors)
      },
      retry: {
        maxRetries: readNumber(source, prefix + '_MAX_RETRIES', 3, 0, 10, errors),
        baseDelayMs: readNumber(source, 'RETRY_BASE_DELAY_MS', 500, 50, 60000, errors),
        maxDelayMs: readNumber(source, 'RETRY_MAX_DELAY_MS', 10000, 100, 300000, errors)
      }
    };
  };

  const config = {
    sandboxMode,
    order,
    requiredFields,
    minConfidence: readNumber(source, 'MIN_CONFIDENCE', 0.7, 0, 1, errors),
    concurrency: readNumber(source, 'ENRICHMENT_CONCURRENCY', 3, 1, 50, errors),
    maxCreditsPerRun: readNumber(source, 'MAX_CREDITS_PER_RUN', 500, 0, 10000000, errors),
    cache: {
      ttlMs: readNumber(source, 'CACHE_TTL_DAYS', 30, 0, 3650, errors) * DAY_MS,
      negativeTtlMs: readNumber(source, 'CACHE_NEGATIVE_TTL_DAYS', 7, 0, 3650, errors) * DAY_MS,
      maxEntries: readNumber(source, 'CACHE_MAX_ENTRIES', 50000, 1, 10000000, errors),
      filePath: source.CACHE_FILE_PATH || '',
      forceRefresh: readBoolean(source.FORCE_REFRESH, false) === true
    },
    circuit: {
      failureThreshold: readNumber(source, 'CIRCUIT_FAILURE_THRESHOLD', 5, 1, 100, errors),
      cooldownMs: readNumber(source, 'CIRCUIT_COOLDOWN_MS', 60000, 1000, 3600000, errors)
    },
    providers: {
      apollo: providerConfig('APOLLO', { baseUrl: 'https://api.apollo.io/api/v1', cost: 1, rpm: 50, burst: 5 }),
      clearbit: providerConfig('CLEARBIT', { baseUrl: 'https://person.clearbit.com', cost: 1, rpm: 300, burst: 10 })
    }
  };

  if (sandboxMode) {
    warnings.push('SANDBOX_MODE is enabled: no external API calls are made; provider responses and credit spend are simulated.');
  } else {
    const live = order.filter((name) => config.providers[name] && config.providers[name].enabled && config.providers[name].apiKey);
    if (live.length === 0) errors.push('SANDBOX_MODE=false but no provider in WATERFALL_ORDER is enabled with an API key.');
    for (const name of order) {
      const p = config.providers[name];
      if (p && p.enabled && !p.apiKey) warnings.push(name + ' is enabled but has no API key; it will be skipped.');
    }
  }
  if (order.includes('clearbit') && config.providers.clearbit.enabled) {
    warnings.push('Clearbit standalone API keys are only available to legacy accounts; set CLEARBIT_BASE_URL for a compatible alternative or CLEARBIT_ENABLED=false.');
  }

  return { config, errors, warnings };
}

/* ------------------------------------------------------------------------ */
/* Input normalisation                                                      */
/* ------------------------------------------------------------------------ */

const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function cleanText(value, max) {
  return String(value === undefined || value === null ? '' : value)
    // Strip ASCII control characters and collapse whitespace.
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max || 120);
}

function normalizeDomain(value) {
  const domain = cleanText(value, 253).toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/^www\./, '')
    .split(/[/?#:]/)[0];
  return DOMAIN_RE.test(domain) ? domain : '';
}

/**
 * Validate and normalise one raw lead.
 * Accepts camelCase or snake_case keys (email, first_name/firstName, ...).
 * @returns {{ok:boolean, lead:object, errors:string[]}}
 */
function normalizeLead(raw, index) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const pick = (...keys) => keys.map((k) => input[k]).find((v) => v !== undefined && v !== null && v !== '');
  const errors = [];

  const lead = {
    id: cleanText(pick('id', 'leadId', 'lead_id') || 'row-' + (index + 1), 64),
    email: cleanText(pick('email', 'work_email'), 254).toLowerCase(),
    firstName: cleanText(pick('firstName', 'first_name'), 80),
    lastName: cleanText(pick('lastName', 'last_name'), 80),
    companyName: cleanText(pick('companyName', 'company_name', 'company'), 120),
    companyDomain: normalizeDomain(pick('companyDomain', 'company_domain', 'domain', 'website')),
    linkedinUrl: cleanText(pick('linkedinUrl', 'linkedin_url'), 300)
  };

  if (lead.email && !EMAIL_RE.test(lead.email)) {
    errors.push('invalid_email');
    lead.email = '';
  }
  if (lead.linkedinUrl && !/^https:\/\/([a-z]{2,3}\.)?linkedin\.com\/in\/[A-Za-z0-9_%-]+\/?$/.test(lead.linkedinUrl)) {
    errors.push('invalid_linkedin_url');
    lead.linkedinUrl = '';
  }
  if (!lead.companyDomain && lead.email) lead.companyDomain = lead.email.split('@')[1];

  const identifiable = lead.email || lead.linkedinUrl || (lead.firstName && lead.lastName && (lead.companyDomain || lead.companyName));
  if (!identifiable) errors.push('insufficient_identifiers');

  for (const key of Object.keys(lead)) if (lead[key] === '') delete lead[key];
  return { ok: Boolean(identifiable), lead, errors };
}

/* ------------------------------------------------------------------------ */
/* Merge & evaluation                                                       */
/* ------------------------------------------------------------------------ */

/**
 * Field-level merge: earlier (cheaper) tiers win; later tiers only fill gaps.
 * Mutates `target` and `sources`; returns the list of fields filled.
 */
function mergeEnrichment(target, sources, data, providerName) {
  const filled = [];
  for (const field of ENRICHMENT_FIELDS) {
    const value = data ? data[field] : undefined;
    if (value === undefined || value === null || value === '') continue;
    if (target[field] === undefined) {
      target[field] = value;
      sources[field] = providerName;
      filled.push(field);
    }
  }
  return filled;
}

/**
 * Is the merged record good enough to stop the waterfall?
 * Confidence = lowest confidence among the providers that supplied required fields.
 */
function evaluateCompleteness(merged, sources, confidences, requiredFields, minConfidence) {
  const missing = requiredFields.filter((field) => merged[field] === undefined);
  const contributing = Array.from(new Set(requiredFields.map((f) => sources[f]).filter(Boolean)));
  const confidence = contributing.length ? Math.min(...contributing.map((p) => confidences[p] || 0)) : 0;
  return { complete: missing.length === 0 && confidence >= minConfidence, missing, confidence: Number(confidence.toFixed(2)) };
}

/** Lookup hints for the next tier: input plus anything already discovered. */
function buildQuery(lead, merged) {
  const query = Object.assign({}, lead);
  for (const field of ['email', 'firstName', 'lastName', 'companyName', 'companyDomain', 'linkedinUrl']) {
    if (!query[field] && merged[field]) query[field] = merged[field];
  }
  return query;
}

/* ------------------------------------------------------------------------ */
/* Budget                                                                   */
/* ------------------------------------------------------------------------ */

/**
 * Credit ledger with reserve/settle semantics so concurrent workers can never
 * overspend MAX_CREDITS_PER_RUN.
 */
class BudgetLedger {
  constructor(limit) {
    this.limit = Number.isFinite(limit) ? limit : Infinity;
    this.reserved = 0;
    this.spent = 0;
  }

  get remaining() {
    return Math.max(0, this.limit - this.spent - this.reserved);
  }

  reserve(amount) {
    if (amount <= 0) return true;
    if (amount > this.remaining) return false;
    this.reserved += amount;
    return true;
  }

  settle(reservedAmount, actualCost) {
    this.reserved = Math.max(0, this.reserved - Math.max(0, reservedAmount));
    this.spent += Math.max(0, actualCost || 0);
  }
}

/* ------------------------------------------------------------------------ */
/* Router                                                                   */
/* ------------------------------------------------------------------------ */

class WaterfallRouter {
  /**
   * @param {object} options
   * @param {object} options.config output of buildConfig().config
   * @param {Array} [options.providers] ordered external providers (defaults from config)
   * @param {CacheProvider} [options.cache]
   * @param {object} [options.logger]
   */
  constructor(options) {
    const o = options || {};
    if (!o.config) throw new Error('WaterfallRouter requires a config.');
    this.config = o.config;
    this.logger = o.logger || defaultLogger;
    const shared = { sandboxMode: this.config.sandboxMode, logger: this.logger, circuit: this.config.circuit, now: o.now, sleep: o.sleep };
    this.providers = o.providers || this.config.order.map((name) => PROVIDER_FACTORIES[name](this.config, shared));
    this.cache = o.cache || new CacheProvider(Object.assign({ logger: this.logger, now: o.now }, this.config.cache));
    this.ledger = new BudgetLedger(this.config.maxCreditsPerRun);
    this.stats = this.freshStats();
  }

  freshStats() {
    const perProvider = {};
    for (const p of this.providers) perProvider[p.name] = { calls: 0, matches: 0, noMatches: 0, pending: 0, errors: 0, skipped: 0, credits: 0 };
    return { perProvider, cacheHits: 0, cacheNegativeHits: 0 };
  }

  /**
   * Run one lead through cache -> tier 1 -> tier 2 -> ... until the record
   * satisfies REQUIRED_FIELDS at MIN_CONFIDENCE, the tiers are exhausted, or
   * the credit budget runs out.
   */
  async enrichLead(raw, index) {
    const { ok, lead, errors } = normalizeLead(raw, index || 0);
    const record = { id: lead.id, status: LEAD_STATUS.INVALID, data: {}, sources: {}, confidence: 0, missingFields: [], credits: 0, attempts: [], validationErrors: errors };
    if (!ok) {
      this.logger.debug('Lead rejected by validation', { leadId: lead.id, errors });
      return record;
    }

    const { requiredFields, minConfidence } = this.config;
    const merged = {};
    const sources = {};
    const confidences = {};

    // Seed with the caller's own input (free, highest trust for identity fields).
    mergeEnrichment(merged, sources, lead, 'input');
    confidences.input = 1;

    // ---- Tier 0: cache --------------------------------------------------
    if (!this.config.cache.forceRefresh) {
      const cached = await this.cache.lookup(lead);
      record.attempts.push({ provider: 'cache', status: cached.status, credits: 0 });
      if (cached.status === 'no_match') {
        this.stats.cacheNegativeHits += 1;
        return Object.assign(record, { status: LEAD_STATUS.NO_MATCH, data: merged, sources, missingFields: requiredFields.filter((f) => merged[f] === undefined), cachedAt: cached.cachedAt });
      }
      if (cached.status === 'matched') {
        this.stats.cacheHits += 1;
        for (const [field, provider] of Object.entries(cached.sources || {})) {
          if (merged[field] === undefined && cached.data[field] !== undefined) {
            merged[field] = cached.data[field];
            sources[field] = 'cache:' + provider;
          }
        }
        mergeEnrichment(merged, sources, cached.data, 'cache');
        for (const p of new Set(Object.values(sources))) if (p !== 'input') confidences[p] = cached.confidence;
        const evaluation = evaluateCompleteness(merged, sources, confidences, requiredFields, minConfidence);
        return Object.assign(record, {
          status: evaluation.complete ? LEAD_STATUS.ENRICHED : LEAD_STATUS.PARTIAL,
          data: merged, sources, confidence: evaluation.confidence, missingFields: evaluation.missing, cachedAt: cached.cachedAt
        });
      }
    }

    // ---- Tiers 1..n: external providers, cheapest first ----------------
    let evaluation = evaluateCompleteness(merged, sources, confidences, requiredFields, minConfidence);
    let budgetHit = false;
    let hadErrors = false;
    let anyMatch = false;

    for (const provider of this.providers) {
      if (evaluation.complete) break;
      const counters = this.stats.perProvider[provider.name];
      const query = buildQuery(lead, merged);

      if (!provider.enabled || !provider.supports(query)) {
        counters.skipped += 1;
        record.attempts.push({ provider: provider.name, status: RESULT_STATUS.SKIPPED, reason: provider.enabled ? 'unsupported_input' : 'disabled', credits: 0 });
        continue;
      }

      const reservation = provider.maxCostPerLookup;
      if (!this.ledger.reserve(reservation)) {
        budgetHit = true;
        counters.skipped += 1;
        record.attempts.push({ provider: provider.name, status: RESULT_STATUS.SKIPPED, reason: 'budget_exhausted', credits: 0 });
        break;
      }

      const result = await provider.lookup(query);
      this.ledger.settle(reservation, result.cost);
      record.credits += result.cost || 0;
      counters.credits += result.cost || 0;
      counters.calls += result.status === RESULT_STATUS.SKIPPED ? 0 : 1;

      const attempt = { provider: provider.name, status: result.status, credits: result.cost || 0, durationMs: result.durationMs };
      if (result.errorCode) attempt.errorCode = result.errorCode;
      if (result.reason && result.status !== RESULT_STATUS.MATCHED) attempt.reason = result.reason;

      if (result.status === RESULT_STATUS.MATCHED) {
        counters.matches += 1;
        anyMatch = true;
        confidences[provider.name] = result.confidence;
        attempt.fieldsFilled = mergeEnrichment(merged, sources, result.data, provider.name);
        evaluation = evaluateCompleteness(merged, sources, confidences, requiredFields, minConfidence);
      } else if (result.status === RESULT_STATUS.NO_MATCH) {
        counters.noMatches += 1;
      } else if (result.status === RESULT_STATUS.PENDING) {
        counters.pending += 1;
        hadErrors = true; // not a confirmed miss; do not negative-cache
      } else if (result.status === RESULT_STATUS.ERROR) {
        counters.errors += 1;
        hadErrors = true;
      } else {
        counters.skipped += 1;
      }
      record.attempts.push(attempt);
    }

    let status;
    if (evaluation.complete) status = LEAD_STATUS.ENRICHED;
    else if (anyMatch) status = LEAD_STATUS.PARTIAL;
    else if (budgetHit) status = LEAD_STATUS.BUDGET_EXHAUSTED;
    else status = LEAD_STATUS.NO_MATCH;

    Object.assign(record, { status, data: merged, sources, confidence: evaluation.confidence, missingFields: evaluation.missing });

    // ---- Write-back to tier 0 -------------------------------------------
    if (anyMatch) {
      const providerSources = {};
      for (const [field, src] of Object.entries(sources)) if (src !== 'input') providerSources[field] = src;
      await this.cache.store(lead, { status: 'matched', data: merged, confidence: evaluation.confidence, sources: providerSources });
    } else if (status === LEAD_STATUS.NO_MATCH && !hadErrors && record.attempts.some((a) => a.status === RESULT_STATUS.NO_MATCH)) {
      // Only cache confirmed misses, never misses caused by errors or skips.
      await this.cache.store(lead, { status: 'no_match' });
    }

    this.logger.debug('Lead processed', { leadId: lead.id, email: lead.email, status, credits: record.credits });
    return record;
  }

  /**
   * In-flight de-duplication: if the same person (same cache key) appears
   * twice in a batch while the first lookup is still running, the second
   * waits for that result instead of paying for a parallel lookup.
   */
  async enrichDeduplicated(raw, index, inflight) {
    const { ok, lead } = normalizeLead(raw, index);
    const key = ok ? this.cache.keyFor(lead) : null;
    if (!key) return this.enrichLead(raw, index);
    if (inflight.has(key)) {
      const original = await inflight.get(key);
      return Object.assign(JSON.parse(JSON.stringify(original)), {
        id: lead.id,
        credits: 0,
        attempts: [{ provider: 'dedupe', status: 'reused_in_flight_result', credits: 0 }]
      });
    }
    const promise = this.enrichLead(raw, index);
    inflight.set(key, promise);
    try {
      return await promise;
    } finally {
      inflight.delete(key);
    }
  }

  /**
   * Enrich a batch with bounded concurrency. Output order matches input order.
   * @returns {Promise<{results:object[], summary:object}>}
   */
  async run(leads) {
    if (!Array.isArray(leads)) throw new Error('run() expects an array of leads.');
    const started = Date.now();
    this.stats = this.freshStats();
    const results = new Array(leads.length);
    const inflight = new Map();
    let next = 0;

    const worker = async () => {
      while (next < leads.length) {
        const index = next;
        next += 1;
        try {
          results[index] = await this.enrichDeduplicated(leads[index], index, inflight);
        } catch (error) {
          // Defensive: a bug in one lead must not abort the whole batch.
          this.logger.error('Unexpected error while enriching lead', { index, error });
          results[index] = { id: 'row-' + (index + 1), status: 'error', data: {}, sources: {}, credits: 0, attempts: [], error: error.message };
        }
      }
    };

    const workers = Array.from({ length: Math.min(this.config.concurrency, Math.max(1, leads.length)) }, worker);
    await Promise.all(workers);
    await this.cache.flush().catch((error) => this.logger.error('Failed to persist cache', { error }));

    const summary = this.summarize(results, Date.now() - started);
    this.logger.info('Waterfall run complete', summary);
    return { results, summary };
  }

  summarize(results, durationMs) {
    const byStatus = {};
    for (const r of results) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    const valid = results.filter((r) => r.status !== LEAD_STATUS.INVALID).length;
    const matched = (byStatus[LEAD_STATUS.ENRICHED] || 0) + (byStatus[LEAD_STATUS.PARTIAL] || 0);
    // Naive baseline: every valid, non-cached lead sent to every supporting provider.
    const allProvidersCost = this.providers.filter((p) => p.enabled).reduce((sum, p) => sum + p.costPerLookup, 0);
    const naiveCredits = valid * allProvidersCost;
    const spent = Number(this.ledger.spent.toFixed(2));
    return {
      mode: this.config.sandboxMode ? 'sandbox' : 'live',
      creditsAreSimulated: this.config.sandboxMode,
      totalLeads: results.length,
      validLeads: valid,
      byStatus,
      matchRate: valid ? Number((matched / valid).toFixed(3)) : 0,
      fullEnrichmentRate: valid ? Number(((byStatus[LEAD_STATUS.ENRICHED] || 0) / valid).toFixed(3)) : 0,
      creditsSpent: spent,
      creditBudget: Number.isFinite(this.ledger.limit) ? this.ledger.limit : null,
      naiveCreditsEstimate: naiveCredits,
      creditsSaved: Number(Math.max(0, naiveCredits - spent).toFixed(2)),
      cache: Object.assign({ hits: this.stats.cacheHits, negativeHits: this.stats.cacheNegativeHits }, { writes: this.cache.stats.writes }),
      providers: this.stats.perProvider,
      providerHealth: this.providers.map((p) => p.health()),
      durationMs
    };
  }
}

/* ------------------------------------------------------------------------ */
/* CLI                                                                      */
/* ------------------------------------------------------------------------ */

function parseArgs(argv) {
  const args = { input: '', output: '', sandbox: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--input' || arg === '-i') args.input = argv[++i] || '';
    else if (arg === '--output' || arg === '-o') args.output = argv[++i] || '';
    else if (arg === '--sandbox' || arg === '--dry-run') args.sandbox = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error('Unknown argument: ' + arg);
  }
  return args;
}

function readLeadsFile(filePath) {
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.leads)) return parsed.leads;
  throw new Error('Input must be a JSON array of leads or an object with a "leads" array.');
}

const HELP = [
  'Usage: node src/index.js --input <leads.json> [--output <results.json>] [--sandbox]',
  '',
  '  -i, --input     JSON array of leads (or { "leads": [...] })',
  '  -o, --output    write per-lead results here (file mode 600). Omit to print only the summary.',
  '      --sandbox   force SANDBOX_MODE=true for this run (no external calls)',
  '  -h, --help      show this help'
].join('\n');

async function main(argv, env) {
  require('dotenv').config({ quiet: true });
  const args = parseArgs(argv || process.argv.slice(2));
  if (args.help || !args.input) {
    process.stdout.write(HELP + '\n');
    return args.help ? 0 : 1;
  }

  const environment = Object.assign({}, env || process.env);
  if (args.sandbox) environment.SANDBOX_MODE = 'true';
  const { config, errors, warnings } = buildConfig(environment);
  for (const warning of warnings) defaultLogger.warn(warning);
  if (errors.length) {
    for (const error of errors) defaultLogger.error(error);
    return 1;
  }

  const leads = readLeadsFile(path.resolve(args.input));
  defaultLogger.info('Starting waterfall run', { leads: leads.length, mode: config.sandboxMode ? 'sandbox' : 'live', order: config.order, budget: config.maxCreditsPerRun });

  const router = new WaterfallRouter({ config });
  const { results, summary } = await router.run(leads);

  if (args.output) {
    const outputPath = path.resolve(args.output);
    fs.writeFileSync(outputPath, JSON.stringify({ summary, results }, null, 2) + '\n', { mode: 0o600 });
    defaultLogger.info('Results written', { file: path.basename(outputPath) });
  }
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  return 0;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    defaultLogger.error('Fatal error', { error: { message: maskEmail(error.message) } });
    process.exitCode = 1;
  });
}

module.exports = {
  LEAD_STATUS,
  PROVIDER_FACTORIES,
  buildConfig,
  normalizeLead,
  mergeEnrichment,
  evaluateCompleteness,
  BudgetLedger,
  WaterfallRouter,
  parseArgs,
  main
};
