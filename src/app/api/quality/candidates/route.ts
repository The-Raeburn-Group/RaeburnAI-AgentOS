import { EvaluationCandidateStatus } from "@prisma/client";
import { NextResponse } from "next/server";
import { ZodError, z } from "zod";
import { db } from "@/lib/db";
import { apiError, rateLimit } from "@/lib/http";
import {
  QualityLoopError,
  promoteEvaluationCandidate,
  reviewEvaluationCandidate,
} from "@/lib/quality-loop";
import { authenticateChainServiceRequest } from "@/lib/service-auth";

const CommandSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("review"),
    candidateId: z.string().uuid(),
    decision: z.enum(["accept", "reject"]),
    note: z.string().trim().max(2_000).optional(),
  }),
  z.object({
    action: z.literal("promote"),
    candidateId: z.string().uuid(),
    record: z.unknown(),
  }),
]);

function qualityOperator(request: Request) {
  const authentication = authenticateChainServiceRequest(request);
  if (!authentication.ok) return authentication;
  if (
    !authentication.context.roles.some((role) =>
      ["admin", "operator", "quality-reviewer"].includes(role),
    )
  ) {
    return {
      ok: false as const,
      response: NextResponse.json(
        { error: "quality_role_required" },
        { status: 403 },
      ),
    };
  }
  return authentication;
}

function qualityError(error: unknown) {
  if (error instanceof QualityLoopError) {
    const status = error.code === "candidate_not_found" ? 404 : 409;
    return NextResponse.json({ error: error.code }, { status });
  }
  if (error instanceof ZodError || error instanceof SyntaxError) {
    return NextResponse.json(
      { error: "invalid_quality_command" },
      { status: 400 },
    );
  }
  return null;
}

export async function GET(request: Request) {
  const authentication = qualityOperator(request);
  if (!authentication.ok) return authentication.response;

  const limited = rateLimit(request, 60, 60_000);
  if (limited) return limited;

  try {
    const candidates = await db.evaluationCandidate.findMany({
      where: {
        tenantId: authentication.context.tenantId,
        status: EvaluationCandidateStatus.PENDING_REVIEW,
      },
      orderBy: [{ occurrenceCount: "desc" }, { createdAt: "asc" }],
      take: 100,
      select: {
        id: true,
        failureKind: true,
        severity: true,
        summary: true,
        reasonLabels: true,
        occurrenceCount: true,
        firstSeenAt: true,
        lastSeenAt: true,
        status: true,
      },
    });
    return NextResponse.json({ candidates });
  } catch (error) {
    return apiError(error, "quality.candidates.list");
  }
}

export async function POST(request: Request) {
  const authentication = qualityOperator(request);
  if (!authentication.ok) return authentication.response;

  const limited = rateLimit(request, 30, 60_000);
  if (limited) return limited;

  try {
    const command = CommandSchema.parse(await request.json());
    const common = {
      tenantId: authentication.context.tenantId,
      candidateId: command.candidateId,
      reviewer: authentication.context.actorId,
    };
    const candidate =
      command.action === "review"
        ? await reviewEvaluationCandidate({
            ...common,
            decision: command.decision,
            ...(command.note ? { note: command.note } : {}),
          })
        : await promoteEvaluationCandidate({
            ...common,
            record: command.record,
          });

    return NextResponse.json({
      candidate: {
        id: candidate.id,
        status: candidate.status,
        reviewedAt: candidate.reviewedAt,
        promotedAt: candidate.promotedAt,
      },
    });
  } catch (error) {
    return qualityError(error) ?? apiError(error, "quality.candidates.command");
  }
}
