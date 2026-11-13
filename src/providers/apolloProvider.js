/**
 * outbound-lead-waterfall-router :: Apollo People Enrichment adapter (tier 1)
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

const DEFAULT_BASE_URL = 'https://api.apollo.io/api/v1';
const MOCK_TITLES = ['VP Revenue Operations', 'Head of Sales Development', 'Director of Marketing Operations', 'Chief Revenue Officer', 'Sales Operations Manager'];
const MOCK_SENIORITY = ['vp', 'head', 'director', 'c_suite', 'manager'];

/** Map Apollo email_status values to a confidence score. */
function confidenceFromEmailStatus(emailStatus, hasEmail) {
  if (!hasEmail) return 0.5;
  switch (String(emailStatus || '').toLowerCase()) {
    case 'verified': return 0.95;
    case 'likely to engage':
    case 'extrapolated': return 0.75;
    case 'guessed': return 0.65;
    case 'unavailable':
    case 'bounced': return 0.3;
    default: return 0.6;
  }
}

function domainFromWebsite(url) {
  if (!url) return undefined;
  return String(url).toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0] || undefined;
}

/**
 * Translate Apollo's `person` object into the canonical enrichment shape.
 * Apollo may return placeholder emails such as "email_not_unlocked@domain.com"
 * for locked records; those are discarded.
 */
function mapApolloPerson(person) {
  if (!person) return null;
  const org = person.organization || {};
  const email = person.email && !/not_unlocked|^email_/i.test(person.email) ? String(person.email).toLowerCase() : undefined;
  return {
    data: {
      email,
      emailStatus: person.email_status || undefined,
      firstName: person.first_name,
      lastName: person.last_name,
      fullName: person.name,
      title: person.title,
      seniority: person.seniority,
      linkedinUrl: person.linkedin_url,
      companyName: org.name,
      companyDomain: org.primary_domain || domainFromWebsite(org.website_url),
      industry: org.industry,
      employeeCount: Number.isFinite(org.estimated_num_employees) ? org.estimated_num_employees : undefined,
      country: person.country || org.country
    },
    confidence: confidenceFromEmailStatus(person.email_status, Boolean(email))
  };
}

/**
 * Apollo People Enrichment (POST /people/match).
 *
 * Docs: https://docs.apollo.io/reference/people-enrichment
 * Auth: `x-api-key` header (key must have access to api/v1/people/match).
 * Billing: credits are consumed per matched record; no-match responses are
 * treated as zero cost. Personal emails and phone reveals are explicitly
 * disabled to keep spend predictable and avoid collecting personal data.
 */
class ApolloProvider extends BaseProvider {
  constructor(options) {
    const o = options || {};
    super(Object.assign({ name: 'apollo', tier: 1, mockMatchRate: 70 }, o));
    this.apiKey = o.apiKey || '';
    this.http = o.httpClient || axios.create({
      baseURL: o.baseUrl || DEFAULT_BASE_URL,
      timeout: o.timeoutMs || 15000,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'x-api-key': this.apiKey
      }
    });
    if (!this.sandboxMode && this.enabled && !this.apiKey) {
      this.logger.warn('APOLLO_API_KEY is not set; Apollo tier disabled.');
      this.enabled = false;
    }
  }

  /** Apollo can match on email, LinkedIn URL, or full name + company. */
  supports(lead) {
    return Boolean(
      lead.email ||
      lead.linkedinUrl ||
      (lead.firstName && lead.lastName && (lead.companyDomain || lead.companyName))
    );
  }

  buildRequestBody(lead) {
    const body = { reveal_personal_emails: false, reveal_phone_number: false };
    if (lead.email) body.email = lead.email;
    if (lead.firstName) body.first_name = lead.firstName;
    if (lead.lastName) body.last_name = lead.lastName;
    if (lead.companyDomain) body.domain = lead.companyDomain;
    if (lead.companyName) body.organization_name = lead.companyName;
    if (lead.linkedinUrl) body.linkedin_url = lead.linkedinUrl;
    return body;
  }

  async performLookup(lead) {
    const response = await this.http.post('/people/match', this.buildRequestBody(lead));
    this.observeRateHeaders(response.headers);
    const mapped = mapApolloPerson(response.data && response.data.person);
    if (!mapped) return { status: RESULT_STATUS.NO_MATCH, cost: 0 };
    return { status: RESULT_STATUS.MATCHED, data: mapped.data, confidence: mapped.confidence, cost: this.costPerLookup };
  }

  /** Proactively slow down when Apollo reports the window is nearly used up. */
  observeRateHeaders(headers) {
    if (!headers) return;
    const remaining = Number(headers['x-rate-limit-remaining'] !== undefined ? headers['x-rate-limit-remaining'] : headers['x-minute-requests-left']);
    if (Number.isFinite(remaining) && remaining <= 2) {
      this.logger.warn('Apollo rate-limit window nearly exhausted; pausing briefly.', { remaining });
      this.bucket.penalize(5000);
    }
  }

  /** Deterministic sandbox response derived only from the lead's own input. */
  mockLookup(lead) {
    const key = lead.email || lead.linkedinUrl || [lead.firstName, lead.lastName, lead.companyDomain].join('|');
    const bucket = stableBucket('apollo:' + key);
    if (bucket >= this.mockMatchRate) return { status: RESULT_STATUS.NO_MATCH };
    const domain = lead.companyDomain || (lead.email ? lead.email.split('@')[1] : undefined);
    const guessedEmail = lead.email || (lead.firstName && lead.lastName && domain
      ? (lead.firstName + '.' + lead.lastName + '@' + domain).toLowerCase()
      : undefined);
    return {
      status: RESULT_STATUS.MATCHED,
      confidence: lead.email ? 0.95 : 0.75,
      data: {
        email: guessedEmail,
        emailStatus: lead.email ? 'verified' : 'guessed',
        firstName: lead.firstName,
        lastName: lead.lastName,
        title: MOCK_TITLES[bucket % MOCK_TITLES.length],
        seniority: MOCK_SENIORITY[bucket % MOCK_SENIORITY.length],
        companyName: lead.companyName,
        companyDomain: domain,
        // Industry/size intentionally omitted on some records so later tiers have gaps to fill.
        industry: bucket % 2 === 0 ? 'Computer Software' : undefined
      }
    };
  }
}

module.exports = {
  ApolloProvider,
  mapApolloPerson,
  confidenceFromEmailStatus
};
