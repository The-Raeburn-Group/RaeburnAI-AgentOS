import { OptimizationExperimentStatus } from "@prisma/client";
import { NextResponse } from "next/server";
import { ZodError, z } from "zod";
import { db } from "@/lib/db";
import { apiError, rateLimit } from "@/lib/http";
import {
  OptimizationControlError,
  createOptimizationExperiment,
  promoteOptimizationExperiment,
  reviewOptimizationExperiment,
} from "@/lib/optimization-control";
import { authenticateChainServiceRequest } from "@/lib/service-auth";

const ListQuerySchema = z.object({
  status: z.nativeEnum(OptimizationExperimentStatus).optional(),
});

const CommandSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("evaluate"),
    baselineAgentId: z.string().uuid(),
    challengerAgentId: z.string().uuid(),
    evidence: z.unknown(),
    policy: z.unknown().optional(),
  }),
  z.object({
    action: z.literal("review"),
    experimentId: z.string().uuid(),
    decision: z.enum(["approve", "reject"]),
    note: z.string().trim().max(2_000).optional(),
  }),
  z.object({
    action: z.literal("promote"),
    experimentId: z.string().uuid(),
  }),
]);

const readRoles = new Set(["admin", "operator", "quality-reviewer"]);
const reviewRoles = new Set(["admin", "quality-reviewer", "human-approver"]);
const promoteRoles = new Set(["admin", "human-approver"]);

function hasRole(roles: string[], allowed: Set<string>): boolean {
  return roles.some((role) => allowed.has(role));
}

function authorize(request: Request, allowed: Set<string>) {
  const authentication = authenticateChainServiceRequest(request);
  if (!authentication.ok) return authentication;
  if (!hasRole(authentication.context.roles, allowed)) {
    return {
      ok: false as const,
      response: NextResponse.json(
        { error: "optimization_role_required" },
        { status: 403 },
      ),
    };
  }
  return authentication;
}

function optimizationError(error: unknown) {
  if (error instanceof OptimizationControlError) {
    if (error.code === "self_approval_forbidden") {
      return NextResponse.json({ error: error.code }, { status: 403 });
    }
    if (
      error.code === "agent_not_found" ||
      error.code === "experiment_not_found"
    ) {
      return NextResponse.json({ error: error.code }, { status: 404 });
    }
    if (
      error.code === "experiment_not_eligible" ||
      error.code === "evidence_candidate_mismatch" ||
      error.code === "benchmark_definition_mismatch"
    ) {
      return NextResponse.json({ error: error.code }, { status: 422 });
    }
    return NextResponse.json({ error: error.code }, { status: 409 });
  }
  if (error instanceof ZodError || error instanceof SyntaxError) {
    return NextResponse.json(
      { error: "invalid_optimization_request" },
      { status: 400 },
    );
  }
  if (
    error instanceof Error &&
    [
      "baseline_integrity_invalid",
      "tool_benchmark_integrity_invalid",
      "performance_benchmark_integrity_invalid",
    ].includes(error.message)
  ) {
    return NextResponse.json(
      { error: "optimization_evidence_integrity_invalid" },
      { status: 422 },
    );
  }
  return null;
}

function responseExperiment(experiment: {
  id: string;
  baselineAgentId: string;
  challengerAgentId: string;
  artifactDigest: string;
  status: OptimizationExperimentStatus;
  result: unknown;
  createdBy: string;
  reviewedBy: string | null;
  reviewNote: string | null;
  reviewedAt: Date | null;
  promotedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: experiment.id,
    baselineAgentId: experiment.baselineAgentId,
    challengerAgentId: experiment.challengerAgentId,
    artifactDigest: experiment.artifactDigest,
    status: experiment.status,
    result: experiment.result,
    createdBy: experiment.createdBy,
    reviewedBy: experiment.reviewedBy,
    reviewNote: experiment.reviewNote,
    reviewedAt: experiment.reviewedAt,
    promotedAt: experiment.promotedAt,
    createdAt: experiment.createdAt,
    updatedAt: experiment.updatedAt,
  };
}

export async function GET(request: Request) {
  const authentication = authorize(request, readRoles);
  if (!authentication.ok) return authentication.response;

  const limited = rateLimit(request, 60, 60_000);
  if (limited) return limited;

  try {
    const url = new URL(request.url);
    const query = ListQuerySchema.parse({
      status: url.searchParams.get("status") ?? undefined,
    });
    const experiments = await db.optimizationExperiment.findMany({
      where: {
        tenantId: authentication.context.tenantId,
        ...(query.status ? { status: query.status } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true,
        baselineAgentId: true,
        challengerAgentId: true,
        artifactDigest: true,
        status: true,
        result: true,
        createdBy: true,
        reviewedBy: true,
        reviewNote: true,
        reviewedAt: true,
        promotedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return NextResponse.json({ experiments });
  } catch (error) {
    return optimizationError(error) ?? apiError(error, "optimization.list");
  }
}

export async function POST(request: Request) {
  const authentication = authenticateChainServiceRequest(request);
  if (!authentication.ok) return authentication.response;

  const limited = rateLimit(request, 30, 60_000);
  if (limited) return limited;

  try {
    const command = CommandSchema.parse(await request.json());
    const roles = authentication.context.roles;
    const common = {
      tenantId: authentication.context.tenantId,
    };

    if (command.action === "evaluate") {
      if (!hasRole(roles, readRoles)) {
        return NextResponse.json(
          { error: "optimization_role_required" },
          { status: 403 },
        );
      }
      const experiment = await createOptimizationExperiment({
        ...common,
        baselineAgentId: command.baselineAgentId,
        challengerAgentId: command.challengerAgentId,
        createdBy: authentication.context.actorId,
        evidence: command.evidence,
        ...(command.policy !== undefined ? { policy: command.policy } : {}),
      });
      return NextResponse.json(
        { experiment: responseExperiment(experiment) },
        { status: 201 },
      );
    }

    if (command.action === "review") {
      if (!hasRole(roles, reviewRoles)) {
        return NextResponse.json(
          { error: "optimization_review_role_required" },
          { status: 403 },
        );
      }
      const experiment = await reviewOptimizationExperiment({
        ...common,
        experimentId: command.experimentId,
        reviewer: authentication.context.actorId,
        decision: command.decision,
        ...(command.note ? { note: command.note } : {}),
      });
      return NextResponse.json({ experiment: responseExperiment(experiment) });
    }

    if (!hasRole(roles, promoteRoles)) {
      return NextResponse.json(
        { error: "optimization_promotion_role_required" },
        { status: 403 },
      );
    }
    const experiment = await promoteOptimizationExperiment({
      ...common,
      experimentId: command.experimentId,
      reviewer: authentication.context.actorId,
    });
    return NextResponse.json({ experiment: responseExperiment(experiment) });
  } catch (error) {
    return optimizationError(error) ?? apiError(error, "optimization.command");
  }
}
