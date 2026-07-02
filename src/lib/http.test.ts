import { describe, expect, it } from 'vitest';
import { rateLimit } from '@/lib/http';

describe('rateLimit', () => {
  it('allows requests under the limit', () => {
    const request = new Request('http://localhost/api/test', {
      headers: { 'x-forwarded-for': '203.0.113.10' }
    });

    expect(rateLimit(request, 2, 1000)).toBeNull();
    expect(rateLimit(request, 2, 1000)).toBeNull();
  });

  it('blocks requests over the limit', () => {
    const request = new Request('http://localhost/api/test', {
      headers: { 'x-forwarded-for': '203.0.113.11' }
    });

    expect(rateLimit(request, 1, 1000)).toBeNull();
    const blocked = rateLimit(request, 1, 1000);
    expect(blocked?.status).toBe(429);
  });
});
