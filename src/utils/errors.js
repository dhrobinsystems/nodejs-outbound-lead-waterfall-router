/**
 * outbound-lead-waterfall-router :: Provider error taxonomy & HTTP error classification
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

/**
 * Stable error codes used across providers. The router decides what to do
 * (retry, skip provider, stop the run) from these codes, never from raw
 * HTTP responses.
 */
const ERROR_CODES = Object.freeze({
  AUTH: 'auth_failed',
  RATE_LIMITED: 'rate_limited',
  INVALID_REQUEST: 'invalid_request',
  UPSTREAM: 'upstream_error',
  NETWORK: 'network_error',
  TIMEOUT: 'timeout',
  CIRCUIT_OPEN: 'circuit_open',
  CONFIG: 'config_error'
});

class ProviderError extends Error {
  /**
   * @param {string} message  human-readable message (must not contain secrets or PII)
   * @param {object} details
   * @param {string} details.provider
   * @param {string} details.code  one of ERROR_CODES
   * @param {number} [details.status]  HTTP status, if any
   * @param {boolean} [details.retryable]
   * @param {number|null} [details.retryAfterMs]
   */
  constructor(message, details) {
    super(message);
    const d = details || {};
    this.name = 'ProviderError';
    this.provider = d.provider || 'unknown';
    this.code = d.code || ERROR_CODES.UPSTREAM;
    this.status = d.status || null;
    this.retryable = Boolean(d.retryable);
    this.retryAfterMs = Number.isFinite(d.retryAfterMs) ? d.retryAfterMs : null;
  }
}

/**
 * Parse a Retry-After header (delta-seconds or HTTP-date) into milliseconds.
 * @returns {number|null}
 */
function parseRetryAfter(headerValue, nowMs) {
  if (headerValue === undefined || headerValue === null || headerValue === '') return null;
  const raw = String(headerValue).trim();
  if (/^\d+(\.\d+)?$/.test(raw)) return Math.round(Number(raw) * 1000);
  const date = Date.parse(raw);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - (Number.isFinite(nowMs) ? nowMs : Date.now()));
}

function headerValue(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') {
    const value = headers.get(name);
    if (value !== undefined && value !== null) return value;
  }
  return headers[name] !== undefined ? headers[name] : headers[name.toLowerCase()];
}

/**
 * Convert an axios (or generic) error into a ProviderError.
 * Deliberately copies NOTHING from the request config or response body, so
 * API keys and payload PII can never leak into logs through error objects.
 */
function classifyHttpError(error, provider, nowMs) {
  if (error instanceof ProviderError) return error;
  const response = error && error.response;
  if (response) {
    const status = response.status;
    if (status === 401 || status === 403) {
      return new ProviderError(provider + ' rejected the credentials (HTTP ' + status + ').', { provider, code: ERROR_CODES.AUTH, status, retryable: false });
    }
    if (status === 429) {
      return new ProviderError(provider + ' rate limit exceeded (HTTP 429).', {
        provider,
        code: ERROR_CODES.RATE_LIMITED,
        status,
        retryable: true,
        retryAfterMs: parseRetryAfter(headerValue(response.headers, 'retry-after'), nowMs)
      });
    }
    if (status >= 500) {
      return new ProviderError(provider + ' upstream error (HTTP ' + status + ').', { provider, code: ERROR_CODES.UPSTREAM, status, retryable: true });
    }
    return new ProviderError(provider + ' rejected the request (HTTP ' + status + ').', { provider, code: ERROR_CODES.INVALID_REQUEST, status, retryable: false });
  }
  const code = error && error.code;
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || (error && error.name === 'CanceledError')) {
    return new ProviderError(provider + ' request timed out.', { provider, code: ERROR_CODES.TIMEOUT, retryable: true });
  }
  return new ProviderError(provider + ' network error (' + (code || 'unknown') + ').', { provider, code: ERROR_CODES.NETWORK, retryable: true });
}

module.exports = {
  ERROR_CODES,
  ProviderError,
  parseRetryAfter,
  classifyHttpError
};
