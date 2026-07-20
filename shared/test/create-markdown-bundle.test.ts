import { describe, expect, it } from "vitest";

import {
  createMarkdownBundle,
  type AuditRunSnapshot,
} from "../src/index.js";

const sampleRun: AuditRunSnapshot = {
  id: "run_demo_001",
  appName: "Example QA Audit",
  targetUrl: "https://example.com",
  auditMode: "full_ui_release_audit",
  runStatus: "completed",
  verdict: "PASS_WITH_ISSUES",
  readiness: "internal_pilot",
  startedAt: "2026-03-22T15:00:00.000Z",
  finishedAt: "2026-03-22T15:02:00.000Z",
  backendKey: "playwright_cdp",
  targetClassification: "unknown_live",
  safetyMode: "safe_read_only",
  summary: {
    topRisks: ["Login is blocked without test credentials."],
    biggestWorkflowFailures: ["Profile save flow remained unverified."],
    biggestUxFrictionPoints: ["Settings labels are dense."],
    bluntBottomLine: "Usable for a guided demo, but not yet production-trustworthy.",
  },
  surfaces: [
    {
      id: "surface_home",
      path: "/",
      title: "Example Home",
      kind: "page",
      entryPoint: "root_navigation",
      result: "PASSED",
      notes: "Loaded successfully.",
      evidencePaths: ["docs/qa/artifacts/screenshots/home.png"],
    },
  ],
  components: [
    {
      id: "component_primary_cta",
      surfaceId: "surface_home",
      type: "button",
      label: "Get Started",
      distinctState: "default",
      actionAttempted: "click",
      result: "PASSED",
      notes: "Navigated to signup.",
      evidencePaths: ["docs/qa/artifacts/screenshots/home.png"],
    },
  ],
  uiElementReviews: [
    {
      id: "ui_review_primary_cta",
      surfaceId: "surface_home",
      componentId: "component_primary_cta",
      elementType: "button",
      label: "Get Started",
      distinctState: "default",
      actionAttempted: "Click primary CTA",
      stepsExecuted: ["Open home", "Click Get Started", "Observe signup page"],
      terminalState: "Signup page reached",
      result: "PASSED",
      humanSummary: "Clicked Get Started and reached the signup page without friction.",
      linkedFindingIds: ["finding_001"],
      evidencePaths: ["docs/qa/artifacts/screenshots/home.png"],
    },
  ],
  workflows: [
    {
      id: "workflow_signup",
      name: "Signup CTA",
      entryPoint: "Home primary CTA",
      stepsExecuted: ["Open home", "Click Get Started", "Observe signup page"],
      terminalState: "Signup page reached",
      result: "PASSED",
      defectIds: [],
      evidencePaths: ["docs/qa/artifacts/screenshots/home.png"],
    },
    {
      id: "workflow_profile_save",
      name: "Profile save",
      entryPoint: "Profile settings",
      stepsExecuted: ["Open settings"],
      terminalState: "Awaiting credentials",
      result: "BLOCKED",
      defectIds: ["finding_002"],
      evidencePaths: ["docs/qa/artifacts/screenshots/settings-blocked.png"],
    },
  ],
  findings: [
    {
      id: "finding_001",
      severity: "MEDIUM",
      surfaceId: "surface_home",
      area: "Navigation",
      title: "Primary CTA lacks confirmatory feedback",
      componentOrWorkflow: "Signup CTA",
      reproductionSteps: ["Open home", "Click Get Started"],
      expectedBehavior: "Explicit transition confirmation.",
      actualBehavior: "Page changes with no inline status message.",
      confidence: "CERTAIN",
      screenshotPath: "docs/qa/artifacts/screenshots/home.png",
      tracePath: "docs/qa/artifacts/traces/run_demo_001.zip",
    },
    {
      id: "finding_002",
      severity: "HIGH",
      surfaceId: "surface_home",
      area: "Authentication",
      title: "Settings flow blocked without credentials",
      componentOrWorkflow: "Profile save",
      reproductionSteps: ["Open settings", "Attempt edit"],
      expectedBehavior: "Test credentials or safe fallback available.",
      actualBehavior: "Audit cannot proceed beyond auth gate.",
      confidence: "CERTAIN",
      screenshotPath: "docs/qa/artifacts/screenshots/settings-blocked.png",
      tracePath: null,
    },
  ],
  blockedItems: [
    {
      id: "blocked_auth_001",
      category: "auth",
      title: "Profile settings gated",
      reason: "No safe credentials supplied.",
      result: "BLOCKED",
    },
  ],
  scorecard: {
    reachableSurfaceCoverageConfidence: { score: 6, reason: "Only the public shell was reachable." },
    uiComponentCoverageConfidence: { score: 6, reason: "Public CTAs and nav were exercised." },
    workflowCoverageConfidence: { score: 5, reason: "Core gated flows remain blocked." },
    uxClarity: { score: 7, reason: "Main path is understandable." },
    errorStateQuality: { score: 5, reason: "Blocked auth lacks guided recovery." },
    accessibilitySanity: { score: 6, reason: "Buttons are labeled, but focus behavior is unverified." },
    globalReadinessSanity: { score: 6, reason: "Visible copy is neutral, but locale settings were not exercised." },
    productionReadiness: { score: 4, reason: "Important flows remain unproven." },
  },
  humanNarrative: [
    "The home page feels calm and direct.",
    "Trust drops immediately when the gated settings area offers no route for safe test access.",
  ],
  artifactManifest: {
    screenshots: [
      "docs/qa/artifacts/screenshots/home.png",
      "docs/qa/artifacts/screenshots/settings-blocked.png",
    ],
    traces: ["docs/qa/artifacts/traces/run_demo_001.zip"],
    reportFiles: [],
    networkLogs: ["docs/qa/artifacts/network/network.jsonl"],
    consoleLogs: ["docs/qa/artifacts/console/console.jsonl"],
  },
};

describe("createMarkdownBundle", () => {
  it("creates the canonical docs/qa package", () => {
    const bundle = createMarkdownBundle(sampleRun);

    expect(Object.keys(bundle).sort()).toEqual(
      [
        "docs/qa/App_Surface_Map.md",
        "docs/qa/Blocked_and_Untested.md",
        "docs/qa/Findings.md",
        "docs/qa/Human_Test_Narrative.md",
        "docs/qa/QA_Summary.md",
        "docs/qa/Readiness_Scorecard.md",
        "docs/qa/UI_Component_Inventory.md",
        "docs/qa/UI_Element_Writeups.md",
        "docs/qa/Workflow_Coverage.md",
      ].sort()
    );
  });

  it("uses only the allowed coverage status vocabulary in blocked output", () => {
    const bundle = createMarkdownBundle(sampleRun);

    expect(bundle["docs/qa/Blocked_and_Untested.md"]).toContain("BLOCKED");
    expect(bundle["docs/qa/Blocked_and_Untested.md"]).not.toContain("BLOCKED_FOR_SAFETY");
  });

  it("creates human-readable UI element writeups from structured review records", () => {
    const bundle = createMarkdownBundle(sampleRun);

    expect(bundle["docs/qa/UI_Element_Writeups.md"]).toContain("# UI Element Writeups");
    expect(bundle["docs/qa/UI_Element_Writeups.md"]).toContain("Get Started");
    expect(bundle["docs/qa/UI_Element_Writeups.md"]).toContain("Clicked Get Started and reached the signup page");
  });
});
