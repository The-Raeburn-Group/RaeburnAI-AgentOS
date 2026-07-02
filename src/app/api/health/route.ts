import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

export async function GET() {
  try {
    await db.$queryRaw`SELECT 1`;
    return NextResponse.json({ status: 'ok', database: 'ok', timestamp: new Date().toISOString() });
  } catch (error) {
    return NextResponse.json(
      { status: 'error', database: 'error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 503 }
    );
  }
}
