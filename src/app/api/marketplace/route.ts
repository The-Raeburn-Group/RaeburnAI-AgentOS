import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiError, rateLimit } from '@/lib/http';
import { ensureDefaultTenant } from '@/lib/orchestrator';
import { AgentManifestSchema } from '@/lib/types';

export async function GET(request: Request) {
  const limited = rateLimit(request, 120, 60000);
  if (limited) return limited;

  try {
    const tenant = await ensureDefaultTenant();
    const agents = await db.agent.findMany({
      where: { tenantId: tenant.id },
      orderBy: [{ status: 'asc' }, { name: 'asc' }]
    });
    return NextResponse.json({ agents });
  } catch (error) {
    return apiError(error, 'marketplace.list');
  }
}

export async function POST(request: Request) {
  const limited = rateLimit(request, 20, 60000);
  if (limited) return limited;

  try {
    const tenant = await ensureDefaultTenant();
    const manifest = AgentManifestSchema.parse(await request.json());
    const agent = await db.agent.upsert({
      where: { tenantId_slug_version: { tenantId: tenant.id, slug: manifest.slug, version: manifest.version } },
      update: {
        name: manifest.name,
        description: manifest.description,
        systemPrompt: manifest.systemPrompt,
        modelProvider: manifest.modelProvider,
        modelName: manifest.modelName,
        marketplaceTags: manifest.marketplaceTags,
        requiredTools: manifest.requiredTools,
        approvalRequired: manifest.approvalRequired,
        memoryScope: manifest.memoryScope,
        manifest
      },
      create: {
        tenantId: tenant.id,
        name: manifest.name,
        slug: manifest.slug,
        version: manifest.version,
        description: manifest.description,
        systemPrompt: manifest.systemPrompt,
        modelProvider: manifest.modelProvider,
        modelName: manifest.modelName,
        marketplaceTags: manifest.marketplaceTags,
        requiredTools: manifest.requiredTools,
        approvalRequired: manifest.approvalRequired,
        memoryScope: manifest.memoryScope,
        manifest
      }
    });
    return NextResponse.json({ agent }, { status: 201 });
  } catch (error) {
    return apiError(error, 'marketplace.upsert');
  }
}
