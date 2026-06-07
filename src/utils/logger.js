'use strict';

/**
 * Shared winston logger.
 *   const { logger } = require('../utils/logger');
 *   logger.info('msg'); logger.warn('msg'); logger.error(err);
 *
 * - Console transport only (for now).
 * - Timestamped, colorized in development, human-readable.
 * - Level is environment-aware: development => debug, production => info.
 * - Error objects logged with full stack trace.
 */

const winston = require('winston');

const isProduction = process.env.NODE_ENV === 'production';
const level = isProduction ? 'info' : 'debug';

const {
  combine,
  timestamp,
  printf,
  colorize,
  errors,
  align,
} = winston.format;

// Human-readable single line; include stack when present.
const lineFormat = printf(({ level: lvl, message, timestamp: ts, stack }) => {
  return `${ts} [${lvl}] ${stack || message}`;
});

const baseFormat = combine(
  // errors({ stack: true }) promotes Error.stack onto the info object.
  errors({ stack: true }),
  timestamp({ format: 'YYYY-MM-DD HH:mm:ss' })
);

const consoleFormat = isProduction
  ? combine(baseFormat, lineFormat)
  : combine(baseFormat, colorize(), align(), lineFormat);

const logger = winston.createLogger({
  level,
  format: baseFormat,
  transports: [new winston.transports.Console({ format: consoleFormat })],
  // Surface, don't swallow, logging failures.
  exitOnError: false,
});

module.exports = { logger };
