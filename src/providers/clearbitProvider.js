/**
 * outbound-lead-waterfall-router :: Clearbit (legacy) / compatible fallback adapter (tier 2)
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

const axios = require('axios');
const { BaseProvider, RESULT_STATUS, stableBucket } = require('./baseProvider');

const DEFAULT_BASE_URL = 'https://person.clearbit.com';
const MOCK_INDUSTRIES = ['Internet Software & Services', 'Professional Services', 'Financial Services', 'Healthcare Technology'];
const MOCK_COUNTRIES = ['US', 'GB', 'DE', 'CA'];

/**
 * Translate a Clearbit Combined response ({ person, company }) into the
 * canonical enrichment shape.
 */
function mapClearbitCombined(payload, inputEmail) {
  const person = (payload && payload.person) || null;
  const company = (payload && payload.company) || null;
  if (!person && !company) return null;
  const employment = (person && person.employment) || {};
  const name = (person && person.name) || {};
  const handle = person && person.linkedin && person.linkedin.handle;
  return {
    data: {
      email: inputEmail,
      emailStatus: person ? 'unverified' : undefined,
      firstName: name.givenName,
      lastName: name.familyName,
      fullName: name.fullName,
      title: employment.title,
      seniority: employment.seniority,
      linkedinUrl: handle ? 'https://www.linkedin.com/' + String(handle).replace(/^\/+/, '') : undefined,
      companyName: (company && company.name) || employment.name,
      companyDomain: (company && company.domain) || employment.domain,
      industry: company && company.category ? (company.category.industry || company.category.sector) : undefined,
      employeeCount: company && company.metrics && Number.isFinite(company.metrics.employees) ? company.metrics.employees : undefined,
      country: (company && company.geo && company.geo.countryCode) || (person && person.geo && person.geo.countryCode)
    },
    confidence: person && company ? 0.85 : person ? 0.7 : 0.6
  };
}

/**
 * Clearbit Combined Enrichment (GET /v2/combined/find?email=...).
 *
 * IMPORTANT - availability: since HubSpot's acquisition, the standalone
 * Clearbit API is not sold to new customers and API keys exist only for
 * legacy accounts. This adapter therefore:
 *   - works for existing legacy Clearbit keys, and
 *   - accepts CLEARBIT_BASE_URL so any Clearbit-compatible endpoint (or an
 *     internal proxy / alternative vendor shim) can be used as the fallback.
 *
 * Auth: `Authorization: Bearer <key>`. Requires an email address.
 * Responses: 200 match, 202 queued (async lookup, retry in a later run),
 * 404 no match, 422 invalid input.
 */
class ClearbitProvider extends BaseProvider {
  constructor(options) {
    const o = options || {};
    super(Object.assign({ name: 'clearbit', tier: 2, mockMatchRate: 55 }, o));
    this.apiKey = o.apiKey || '';
    this.http = o.httpClient || axios.create({
      baseURL: o.baseUrl || DEFAULT_BASE_URL,
      timeout: o.timeoutMs || 15000,
      headers: { Authorization: 'Bearer ' + this.apiKey, Accept: 'application/json' },
      // 202/404 are expected business outcomes, not exceptions.
      validateStatus: (status) => (status >= 200 && status < 300) || status === 404
    });
    if (!this.sandboxMode && this.enabled && !this.apiKey) {
      this.logger.warn('CLEARBIT_API_KEY is not set; Clearbit tier disabled.');
      this.enabled = false;
    }
  }

  supports(lead) {
    return Boolean(lead.email);
  }

  async performLookup(lead) {
    const response = await this.http.get('/v2/combined/find', { params: { email: lead.email } });
    if (response.status === 404) return { status: RESULT_STATUS.NO_MATCH, cost: 0 };
    if (response.status === 202) {
      // Clearbit is still researching this person; do not wait synchronously.
      return { status: RESULT_STATUS.PENDING, cost: 0, reason: 'lookup_queued_by_provider' };
    }
    const mapped = mapClearbitCombined(response.data, lead.email);
    if (!mapped) return { status: RESULT_STATUS.NO_MATCH, cost: 0 };
    return { status: RESULT_STATUS.MATCHED, data: mapped.data, confidence: mapped.confidence, cost: this.costPerLookup };
  }

  /** Deterministic sandbox response: mainly fills firmographic gaps. */
  mockLookup(lead) {
    const bucket = stableBucket('clearbit:' + lead.email);
    if (bucket >= this.mockMatchRate) return { status: RESULT_STATUS.NO_MATCH };
    const domain = lead.email.split('@')[1];
    return {
      status: RESULT_STATUS.MATCHED,
      confidence: 0.85,
      data: {
        email: lead.email,
        emailStatus: 'unverified',
        title: lead.title || 'Revenue Operations Lead',
        companyName: lead.companyName,
        companyDomain: domain,
        industry: MOCK_INDUSTRIES[bucket % MOCK_INDUSTRIES.length],
        employeeCount: 50 + bucket * 10,
        country: MOCK_COUNTRIES[bucket % MOCK_COUNTRIES.length]
      }
    };
  }
}

module.exports = {
  ClearbitProvider,
  mapClearbitCombined
};
