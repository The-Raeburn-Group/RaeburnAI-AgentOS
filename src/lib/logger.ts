import pino from 'pino';
import { env } from '@/lib/env';

export const logger = pino({
  level: env.LOG_LEVEL,
  base: {
    service: 'raeburnai-agentos',
    environment: process.env.NODE_ENV ?? 'development'
  },
  redact: {
    paths: ['req.headers.authorization', '*.apiKey', '*.password', '*.token', '*.secret'],
    remove: true
  }
});
