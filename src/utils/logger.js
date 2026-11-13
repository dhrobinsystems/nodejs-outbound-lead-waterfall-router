/**
 * outbound-lead-waterfall-router :: Structured, PII-redacting logger (winston)
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

const winston = require('winston');

/**
 * Keys whose values must never be written to logs.
 * Matching is case-insensitive and applies at any nesting depth.
 */
const SECRET_KEY_PATTERN = /(api[_-]?key|authorization|token|secret|password|credential|cookie)/i;

/**
 * Keys that hold personal data. Emails are masked (first char + domain kept
 * for debugging deliverability by domain); every other PII field is replaced.
 */
const PII_KEYS = new Set([
  'firstName', 'lastName', 'fullName', 'first_name', 'last_name', 'name',
  'phone', 'phoneNumber', 'mobile', 'linkedinUrl', 'linkedin_url'
]);

const EMAIL_PATTERN = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
const MAX_DEPTH = 6;

/**
 * Mask every email address inside a string: "jane.doe@example.com" -> "j***@example.com".
 */
function maskEmail(value) {
  return String(value).replace(EMAIL_PATTERN, (match, firstChar, domain) => firstChar + '***@' + domain);
}

/**
 * Recursively redact secrets and PII from any loggable value.
 * Returns a new value; the input is never mutated.
 */
function redact(value, depth) {
  const level = depth || 0;
  if (level > MAX_DEPTH) return '[Truncated]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return maskEmail(value);
  if (typeof value !== 'object') return value;
  if (value instanceof Error) {
    return { name: value.name, message: maskEmail(value.message), code: value.code };
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, level + 1));

  const output = {};
  for (const [key, inner] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) output[key] = '[REDACTED]';
    else if (PII_KEYS.has(key)) output[key] = inner ? '[PII]' : inner;
    else output[key] = redact(inner, level + 1);
  }
  return output;
}

/**
 * winston format that redacts every user-supplied field of a log entry.
 * winston's internal Symbol keys (level/message/splat) are left untouched.
 */
const redactFormat = winston.format((info) => {
  for (const key of Object.keys(info)) {
    if (key === 'level' || key === 'timestamp') continue;
    if (SECRET_KEY_PATTERN.test(key)) info[key] = '[REDACTED]';
    else if (PII_KEYS.has(key)) info[key] = info[key] ? '[PII]' : info[key];
    else info[key] = redact(info[key]);
  }
  return info;
});

/**
 * Create a logger.
 * @param {object} [options]
 * @param {string} [options.level]  error | warn | info | http | verbose | debug | silly
 * @param {'json'|'pretty'} [options.format]  json for log pipelines, pretty for terminals
 * @param {boolean} [options.silent]  disable all output (tests)
 * @param {object} [options.defaultMeta]  fields attached to every entry
 */
function createLogger(options) {
  const opts = options || {};
  const level = opts.level || process.env.LOG_LEVEL || 'info';
  const style = opts.format || process.env.LOG_FORMAT || 'json';
  const base = [winston.format.timestamp(), redactFormat(), winston.format.errors({ stack: false })];

  const outputFormat = style === 'pretty'
    ? winston.format.combine(...base, winston.format.colorize(), winston.format.printf((info) => {
      const { timestamp, level: lvl, message, ...rest } = info;
      const meta = Object.keys(rest).length ? ' ' + JSON.stringify(rest) : '';
      return timestamp + ' ' + lvl + ' ' + message + meta;
    }))
    : winston.format.combine(...base, winston.format.json());

  return winston.createLogger({
    level,
    silent: Boolean(opts.silent),
    defaultMeta: Object.assign({ service: 'outbound-lead-waterfall-router' }, opts.defaultMeta || {}),
    format: outputFormat,
    // Logs go to stderr so stdout stays clean for piping results.
    transports: [new winston.transports.Console({ stderrLevels: ['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly'] })]
  });
}

/** Shared default logger (respects LOG_LEVEL / LOG_FORMAT). */
const logger = createLogger({ silent: process.env.NODE_ENV === 'test' });

module.exports = {
  logger,
  createLogger,
  redact,
  maskEmail
};
