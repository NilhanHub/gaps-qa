import {
  canonicalReportPaths,
  type AuditRunSnapshot,
  type FindingRecord,
  type ScorecardMetric,
} from "./contracts.js";

function escapeCell(value: string) {
  return value.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}

function markdownTable(headers: string[], rows: string[][]) {
  const headerLine = `| ${headers.map(escapeCell).join(" | ")} |`;
  const dividerLine = `| ${headers.map(() => "---").join(" | ")} |`;
  const bodyLines = rows.map((row) => `| ${row.map((cell) => escapeCell(cell)).join(" | ")} |`);
  return [headerLine, dividerLine, ...bodyLines].join("\n");
}

function severityRank(severity: FindingRecord["severity"]) {
  switch (severity) {
    case "CRITICAL":
      return 0;
    case "HIGH":
      return 1;
    case "MEDIUM":
      return 2;
    case "LOW":
      return 3;
    default:
      return 4;
  }
}

function metricRow(label: string, metric: ScorecardMetric) {
  return [label, String(metric.score), metric.reason];
}

export function createMarkdownBundle(run: AuditRunSnapshot): Record<string, string> {
  const findings = [...run.findings].sort((left, right) => {
    const severityDelta = severityRank(left.severity) - severityRank(right.severity);
    if (severityDelta !== 0) {
      return severityDelta;
    }

    return left.area.localeCompare(right.area);
  });

  const reportFiles: Record<string, string> = {
    "docs/qa/QA_Summary.md": [
      "# QA Summary",
      "",
      `- App audited: ${run.appName}`,
      `- Environment audited: ${run.targetUrl}`,
      `- Audit time: ${run.startedAt}${run.finishedAt ? ` -> ${run.finishedAt}` : ""}`,
      `- Audit mode: ${run.auditMode}`,
      `- Backend: ${run.backendKey}`,
      `- Overall verdict: ${run.verdict ?? "UNVERIFIED"}`,
      `- Readiness target: ${run.readiness ?? "UNVERIFIED"}`,
      "",
      "## Top Risks",
      ...(run.summary.topRisks.length > 0 ? run.summary.topRisks.map((risk) => `- ${risk}`) : ["- None captured."]),
      "",
      "## Biggest Workflow Failures",
      ...(run.summary.biggestWorkflowFailures.length > 0
        ? run.summary.biggestWorkflowFailures.map((failure) => `- ${failure}`)
        : ["- None captured."]),
      "",
      "## Biggest UX Friction Points",
      ...(run.summary.biggestUxFrictionPoints.length > 0
        ? run.summary.biggestUxFrictionPoints.map((point) => `- ${point}`)
        : ["- None captured."]),
      "",
      "## Coverage Summary",
      `- Surfaces discovered: ${run.surfaces.length}`,
      `- Components inventoried: ${run.components.length}`,
      `- Workflows attempted: ${run.workflows.length}`,
      `- Findings logged: ${run.findings.length}`,
      `- Blocked items: ${run.blockedItems.length}`,
      "",
      "## Blunt Bottom Line",
      run.summary.bluntBottomLine,
      "",
    ].join("\n"),
    "docs/qa/App_Surface_Map.md": [
      "# App Surface Map",
      "",
      markdownTable(
        ["Surface ID", "Path", "Title", "Kind", "Entry Point", "Result", "Evidence"],
        run.surfaces.map((surface) => [
          surface.id,
          surface.path,
          surface.title,
          surface.kind,
          surface.entryPoint,
          surface.result,
          surface.evidencePaths.join(", "),
        ])
      ),
      "",
    ].join("\n"),
    "docs/qa/UI_Component_Inventory.md": [
      "# UI Component Inventory",
      "",
      markdownTable(
        ["Component ID", "Surface", "Type", "Label", "State", "Action", "Result", "Notes", "Evidence"],
        run.components.map((component) => [
          component.id,
          component.surfaceId,
          component.type,
          component.label,
          component.distinctState,
          component.actionAttempted,
          component.result,
          component.notes,
          component.evidencePaths.join(", "),
        ])
      ),
      "",
    ].join("\n"),
    "docs/qa/UI_Element_Writeups.md": [
      "# UI Element Writeups",
      "",
      ...(run.uiElementReviews.length > 0
        ? run.uiElementReviews.flatMap((review) => [
            `## ${review.label}`,
            "",
            `- Review ID: ${review.id}`,
            `- Surface: ${review.surfaceId}`,
            `- Component ID: ${review.componentId ?? "Unmapped"}`,
            `- Element type: ${review.elementType}`,
            `- Distinct state: ${review.distinctState}`,
            `- Action attempted: ${review.actionAttempted}`,
            `- Result: ${review.result}`,
            `- Terminal state: ${review.terminalState}`,
            `- Linked findings: ${review.linkedFindingIds.length > 0 ? review.linkedFindingIds.join(", ") : "None"}`,
            `- Evidence: ${review.evidencePaths.length > 0 ? review.evidencePaths.join(", ") : "None"}`,
            "",
            review.humanSummary,
            "",
            "### Steps Executed",
            ...(review.stepsExecuted.length > 0
              ? review.stepsExecuted.map((step, index) => `${index + 1}. ${step}`)
              : ["1. No executable steps were recorded."]),
            "",
          ])
        : ["No UI element reviews were captured for this run.", ""]),
    ].join("\n"),
    "docs/qa/Workflow_Coverage.md": [
      "# Workflow Coverage",
      "",
      markdownTable(
        ["Workflow", "Entry Point", "Steps Executed", "Terminal State", "Result", "Defects", "Evidence"],
        run.workflows.map((workflow) => [
          workflow.name,
          workflow.entryPoint,
          workflow.stepsExecuted.join(" -> "),
          workflow.terminalState,
          workflow.result,
          workflow.defectIds.join(", "),
          workflow.evidencePaths.join(", "),
        ])
      ),
      "",
    ].join("\n"),
    "docs/qa/Findings.md": [
      "# Findings",
      "",
      ...findings.flatMap((finding) => [
        `## [${finding.severity}] ${finding.title}`,
        "",
        `- Finding ID: ${finding.id}`,
        `- Surface/Page: ${finding.surfaceId}`,
        `- Area: ${finding.area}`,
        `- Exact component or workflow: ${finding.componentOrWorkflow}`,
        `- Confidence: ${finding.confidence}`,
        `- Screenshot: ${finding.screenshotPath ?? "None"}`,
        `- Trace/log reference: ${finding.tracePath ?? "None"}`,
        "",
        "### Reproduction",
        ...finding.reproductionSteps.map((step, index) => `${index + 1}. ${step}`),
        "",
        "### Expected Behavior",
        finding.expectedBehavior,
        "",
        "### Actual Behavior",
        finding.actualBehavior,
        "",
      ]),
    ].join("\n"),
    "docs/qa/Human_Test_Narrative.md": [
      "# Human Test Narrative",
      "",
      ...(run.humanNarrative.length > 0
        ? run.humanNarrative.map((note) => `- ${note}`)
        : ["- No human narrative notes were captured."]),
      "",
    ].join("\n"),
    "docs/qa/Blocked_and_Untested.md": [
      "# Blocked and Untested",
      "",
      markdownTable(
        ["Category", "Title", "Reason", "Result"],
        run.blockedItems.map((item) => [item.category, item.title, item.reason, item.result])
      ),
      "",
      "## Explicitly Untested",
      ...(run.workflows
        .filter((workflow) => workflow.result === "UNVERIFIED")
        .map((workflow) => `- ${workflow.name}: ${workflow.terminalState}`) || ["- None recorded."]),
      "",
    ].join("\n"),
    "docs/qa/Readiness_Scorecard.md": [
      "# Readiness Scorecard",
      "",
      run.scorecard
        ? markdownTable(
            ["Area", "Score", "Reason"],
            [
              metricRow("Reachable surface coverage confidence", run.scorecard.reachableSurfaceCoverageConfidence),
              metricRow("UI component coverage confidence", run.scorecard.uiComponentCoverageConfidence),
              metricRow("Workflow coverage confidence", run.scorecard.workflowCoverageConfidence),
              metricRow("UX clarity", run.scorecard.uxClarity),
              metricRow("Error-state quality", run.scorecard.errorStateQuality),
              metricRow("Accessibility sanity", run.scorecard.accessibilitySanity),
              metricRow("Global-readiness sanity", run.scorecard.globalReadinessSanity),
              metricRow("Production readiness", run.scorecard.productionReadiness),
            ]
          )
        : "No scorecard has been calculated for this run yet.",
      "",
    ].join("\n"),
  };

  for (const canonicalPath of canonicalReportPaths) {
    if (!reportFiles[canonicalPath]) {
      throw new Error(`Missing canonical report output: ${canonicalPath}`);
    }
  }

  return reportFiles;
}

export function createUiElementAuditPayload(run: AuditRunSnapshot) {
  return {
    generatedAt: new Date().toISOString(),
    runId: run.id,
    appName: run.appName,
    targetUrl: run.targetUrl,
    auditMode: run.auditMode,
    verdict: run.verdict,
    readiness: run.readiness,
    backendKey: run.backendKey,
    summary: run.summary,
    surfaces: run.surfaces,
    uiElementReviews: run.uiElementReviews,
    findings: run.findings,
  };
}

export function createUiElementAuditJson(run: AuditRunSnapshot) {
  return `${JSON.stringify(createUiElementAuditPayload(run), null, 2)}\n`;
}
