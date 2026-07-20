import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  AuditReadiness,
  AuditRunSnapshot,
  AuditSummary,
  AuditVerdict,
  BlockedItem,
  ComponentRecord,
  FindingRecord,
  ReadinessScorecard,
  ScorecardMetric,
  SurfaceRecord,
  TargetClassification,
  UiElementReviewRecord,
  WorkflowRecord,
} from "../../shared/src/index.js";

function metric(score: number, reason: string): ScorecardMetric {
  return { score: Math.max(0, Math.min(10, score)), reason };
}

export function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "audit";
}

export async function ensureDir(dirPath: string) {
  await mkdir(dirPath, { recursive: true });
}

export async function writeJsonl(filePath: string, rows: unknown[]) {
  await ensureDir(path.dirname(filePath));
  const payload = rows.map((row) => `${JSON.stringify(row)}\n`).join("");
  await writeFile(filePath, payload, "utf8");
}

export function classifyTarget(targetUrl: string): TargetClassification {
  try {
    const url = new URL(targetUrl);
    const host = url.hostname.toLowerCase();

    if (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host.endsWith(".local")
    ) {
      return "localhost_or_private";
    }

    if (
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
    ) {
      return "localhost_or_private";
    }

    if (
      host.includes("staging") ||
      host.includes("sandbox") ||
      host.includes("preview") ||
      host.includes("dev") ||
      host.includes("test") ||
      host.includes("qa")
    ) {
      return "staging_or_test";
    }

    if (host === "example.com" || host.endsWith(".example.com")) {
      return "unknown_live";
    }

    return "production_suspected";
  } catch {
    return "unknown_live";
  }
}

export function defaultSummary(message: string): AuditSummary {
  return {
    topRisks: [message],
    biggestWorkflowFailures: [],
    biggestUxFrictionPoints: [],
    bluntBottomLine: message,
  };
}

function countWhere<T>(items: T[], predicate: (item: T) => boolean) {
  return items.reduce((total, item) => total + (predicate(item) ? 1 : 0), 0);
}

export function buildScorecard(input: Pick<
  AuditRunSnapshot,
  "surfaces" | "components" | "uiElementReviews" | "workflows" | "findings" | "blockedItems"
>): ReadinessScorecard {
  const failedSurfaces = countWhere(input.surfaces, (surface) => surface.result === "FAILED");
  const blockedSurfaces = countWhere(input.surfaces, (surface) => surface.result === "BLOCKED");
  const failedWorkflows = countWhere(input.workflows, (workflow) => workflow.result === "FAILED");
  const unprovenWorkflows = countWhere(
    input.workflows,
    (workflow) => workflow.result === "BLOCKED" || workflow.result === "UNVERIFIED",
  );
  const highFindings = countWhere(
    input.findings,
    (finding) => finding.severity === "CRITICAL" || finding.severity === "HIGH",
  );
  const mediumFindings = countWhere(input.findings, (finding) => finding.severity === "MEDIUM");

  const reachableSurfaceCoverageConfidence = metric(
    9 - failedSurfaces * 3 - blockedSurfaces * 2 - input.blockedItems.length,
    `${input.surfaces.length} surfaces were mapped; ${failedSurfaces} failed and ${blockedSurfaces} were blocked.`,
  );
  const uiComponentCoverageConfidence = metric(
    input.uiElementReviews.length > 0
      ? 8 - countWhere(input.uiElementReviews, (review) => review.result === "UNVERIFIED")
      : input.components.length > 0
        ? 6
        : 4,
    `${input.components.length} meaningful components were inventoried and ${input.uiElementReviews.length} were exercised.`,
  );
  const workflowCoverageConfidence = metric(
    9 - failedWorkflows * 3 - unprovenWorkflows * 2,
    `${input.workflows.length} workflows were attempted; ${failedWorkflows} failed and ${unprovenWorkflows} remain unproven.`,
  );
  const uxClarity = metric(
    8 - mediumFindings - highFindings * 2,
    `${mediumFindings + highFindings} UX-impacting findings were recorded across findings and notes.`,
  );
  const errorStateQuality = metric(
    8 - highFindings * 2 - failedWorkflows,
    `${failedWorkflows} workflow failures and ${highFindings} severe findings reduce trust in recovery paths.`,
  );
  const accessibilitySanity = metric(
    input.components.length > 0 ? 7 - mediumFindings : 4,
    "Accessibility is based on a browser sanity pass, not a compliance audit.",
  );
  const globalReadinessSanity = metric(
    8 - highFindings * 2 - failedWorkflows * 2 - input.blockedItems.length,
    `${input.findings.length} findings and ${input.blockedItems.length} blocked areas influenced the release-readiness readout.`,
  );
  const productionReadiness = metric(
    7 - highFindings * 3 - failedWorkflows * 2 - unprovenWorkflows,
    "Production readiness is conservative when severe findings or unproven flows remain.",
  );

  return {
    reachableSurfaceCoverageConfidence,
    uiComponentCoverageConfidence,
    workflowCoverageConfidence,
    uxClarity,
    errorStateQuality,
    accessibilitySanity,
    globalReadinessSanity,
    productionReadiness,
  };
}

export function deriveVerdict(input: Pick<AuditRunSnapshot, "workflows" | "findings" | "blockedItems">): AuditVerdict {
  if (input.findings.some((finding) => finding.severity === "CRITICAL")) {
    return "FAIL";
  }

  if (
    input.workflows.some((workflow) => workflow.result === "FAILED") ||
    input.workflows.every((workflow) => workflow.result !== "PASSED")
  ) {
    return "FAIL";
  }

  if (
    input.findings.some((finding) => finding.severity === "HIGH") ||
    input.workflows.some(
      (workflow) => workflow.result === "BLOCKED" || workflow.result === "UNVERIFIED",
    ) ||
    input.blockedItems.length > 0
  ) {
    return "PASS_WITH_ISSUES";
  }

  return "PASS";
}

export function deriveReadiness(
  verdict: AuditVerdict,
  findings: FindingRecord[],
  blockedItems: BlockedItem[],
  workflows: WorkflowRecord[],
): AuditReadiness {
  if (verdict === "FAIL") {
    return "demo";
  }

  if (
    findings.some((finding) => finding.severity === "HIGH") ||
    blockedItems.length > 0 ||
    workflows.some((workflow) => workflow.result === "BLOCKED")
  ) {
    return "internal_pilot";
  }

  if (verdict === "PASS_WITH_ISSUES" || findings.some((finding) => finding.severity === "MEDIUM")) {
    return "external_beta";
  }

  return "production";
}

export function findingSeverityFromStatus(
  result:
    | SurfaceRecord["result"]
    | ComponentRecord["result"]
    | WorkflowRecord["result"]
    | UiElementReviewRecord["result"],
): FindingRecord["severity"] {
  switch (result) {
    case "FAILED":
      return "HIGH";
    case "BLOCKED":
      return "MEDIUM";
    case "UNVERIFIED":
      return "LOW";
    default:
      return "LOW";
  }
}
