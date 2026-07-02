import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { logger } from '@/lib/logger';

const windows = new Map<string, { count: number; resetAt: number }>();

export function getClientKey(request: Request) {
  const forwarded = request.headers.get('x-forwarded-for');
  return forwarded?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || 'local';
}

export function rateLimit(request: Request, limit = 60, windowMs = 60_000) {
  const key = getClientKey(request);
  const now = Date.now();
  const current = windows.get(key);

  if (!current || current.resetAt < now) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return null;
  }

  current.count += 1;
  if (current.count > limit) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
  }

  return null;
}

export function apiError(error: unknown, context: string) {
  const message = error instanceof ZodError ? 'Invalid request payload' : error instanceof Error ? error.message : 'Unexpected error';
  logger.error({ err: error, context }, message);
  return NextResponse.json({ error: message }, { status: error instanceof ZodError ? 400 : 500 });
}
