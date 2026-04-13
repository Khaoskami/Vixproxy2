import winston from 'winston';

const redactSecrets = winston.format((info) => {
  const str = JSON.stringify(info);
  const redacted = str
    .replace(/"password[^"]*":"[^"]+"/gi, '"password":"[REDACTED]"')
    .replace(/"key[^"]*":"[^"]+"/gi, '"key":"[REDACTED]"')
    .replace(/"secret[^"]*":"[^"]+"/gi, '"secret":"[REDACTED]"')
    .replace(/sk-[a-zA-Z0-9_-]{20,}/g, '[REDACTED-KEY]')
    .replace(/vix_[a-zA-Z0-9_-]{20,}/g, '[REDACTED-PROXY]');
  return JSON.parse(redacted);
});

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    redactSecrets(),
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    process.env.NODE_ENV === 'production'
      ? winston.format.json()
      : winston.format.combine(winston.format.colorize(), winston.format.simple())
  ),
  transports: [new winston.transports.Console()],
});

export default logger;
