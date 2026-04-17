import winston from 'winston';
import config from '../config/index.js';

const logger = winston.createLogger({
  level: config.isDev ? 'debug' : 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}] ${message}`),
  ),
  transports: [new winston.transports.Console()],
});

export function logRequest(req, res) {
  const ms = Date.now() - (req._startTime || Date.now());
  const line = `${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms`;
  if (res.statusCode >= 500) logger.error(line);
  else if (res.statusCode >= 400) logger.warn(line);
  else logger.info(line);
}

export default logger;
