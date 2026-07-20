export const allowedCoverageResults = [
  "PASSED",
  "FAILED",
  "BLOCKED",
  "UNVERIFIED",
] as const;

export const allowedVerdicts = [
  "PASS",
  "PASS_WITH_ISSUES",
  "FAIL",
] as const;

export const allowedAuditModes = [
  "surface_map_only",
  "workflow_audit",
  "full_ui_release_audit",
] as const;

export const allowedRunStatuses = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;

export const allowedReadiness = [
  "demo",
  "internal_pilot",
  "external_beta",
  "production",
] as const;

export const allowedTargetClassifications = [
  "localhost_or_private",
  "staging_or_test",
  "unknown_live",
  "production_suspected",
] as const;

export const allowedBackends = [
  "playwright_cdp",
  "windows_local",
  "gemini_semantic",
] as const;

export const allowedSafetyModes = [
  "safe_read_only",
  "allow_risky_write_in_non_production",
] as const;

export const canonicalReportPaths = [
  "docs/qa/QA_Summary.md",
  "docs/qa/App_Surface_Map.md",
  "docs/qa/UI_Component_Inventory.md",
  "docs/qa/UI_Element_Writeups.md",
  "docs/qa/Workflow_Coverage.md",
  "docs/qa/Findings.md",
  "docs/qa/Human_Test_Narrative.md",
  "docs/qa/Blocked_and_Untested.md",
  "docs/qa/Readiness_Scorecard.md",
] as const;

export type CoverageResult = (typeof allowedCoverageResults)[number];
export type AuditVerdict = (typeof allowedVerdicts)[number];
export type AuditMode = (typeof allowedAuditModes)[number];
export type AuditRunStatus = (typeof allowedRunStatuses)[number];
export type AuditReadiness = (typeof allowedReadiness)[number];
export type TargetClassification = (typeof allowedTargetClassifications)[number];
export type BackendKey = (typeof allowedBackends)[number];
export type SafetyMode = (typeof allowedSafetyModes)[number];

export type FindingSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
export type FindingConfidence = "CERTAIN" | "LIKELY" | "SUSPECTED";
export type SurfaceKind = "page" | "modal" | "drawer" | "tab" | "menu" | "notification";

export interface AuditSummary {
  topRisks: string[];
  biggestWorkflowFailures: string[];
  biggestUxFrictionPoints: string[];
  bluntBottomLine: string;
}

export interface SurfaceRecord {
  id: string;
  path: string;
  title: string;
  kind: SurfaceKind;
  entryPoint: string;
  result: CoverageResult;
  notes: string;
  evidencePaths: string[];
}

export interface ComponentRecord {
  id: string;
  surfaceId: string;
  type: string;
  label: string;
  distinctState: string;
  actionAttempted: string;
  result: CoverageResult;
  notes: string;
  evidencePaths: string[];
}

export interface UiElementReviewRecord {
  id: string;
  surfaceId: string;
  componentId: string | null;
  elementType: string;
  label: string;
  distinctState: string;
  actionAttempted: string;
  stepsExecuted: string[];
  terminalState: string;
  result: CoverageResult;
  humanSummary: string;
  linkedFindingIds: string[];
  evidencePaths: string[];
}

export interface WorkflowRecord {
  id: string;
  name: string;
  entryPoint: string;
  stepsExecuted: string[];
  terminalState: string;
  result: CoverageResult;
  defectIds: string[];
  evidencePaths: string[];
}

export interface FindingRecord {
  id: string;
  severity: FindingSeverity;
  surfaceId: string;
  area: string;
  title: string;
  componentOrWorkflow: string;
  reproductionSteps: string[];
  expectedBehavior: string;
  actualBehavior: string;
  confidence: FindingConfidence;
  screenshotPath: string | null;
  tracePath: string | null;
}

export interface BlockedItem {
  id: string;
  category: string;
  title: string;
  reason: string;
  result: CoverageResult;
}

export interface ScorecardMetric {
  score: number;
  reason: string;
}

export interface ReadinessScorecard {
  reachableSurfaceCoverageConfidence: ScorecardMetric;
  uiComponentCoverageConfidence: ScorecardMetric;
  workflowCoverageConfidence: ScorecardMetric;
  uxClarity: ScorecardMetric;
  errorStateQuality: ScorecardMetric;
  accessibilitySanity: ScorecardMetric;
  globalReadinessSanity: ScorecardMetric;
  productionReadiness: ScorecardMetric;
}

export interface ArtifactManifest {
  screenshots: string[];
  traces: string[];
  reportFiles: string[];
  networkLogs: string[];
  consoleLogs: string[];
}

export interface AuditRunSnapshot {
  id: string;
  appName: string;
  targetUrl: string;
  auditMode: AuditMode;
  runStatus: AuditRunStatus;
  verdict: AuditVerdict | null;
  readiness: AuditReadiness | null;
  startedAt: string;
  finishedAt: string | null;
  backendKey: BackendKey;
  targetClassification: TargetClassification;
  safetyMode: SafetyMode;
  summary: AuditSummary;
  surfaces: SurfaceRecord[];
  components: ComponentRecord[];
  uiElementReviews: UiElementReviewRecord[];
  workflows: WorkflowRecord[];
  findings: FindingRecord[];
  blockedItems: BlockedItem[];
  scorecard: ReadinessScorecard | null;
  humanNarrative: string[];
  artifactManifest: ArtifactManifest;
}

export interface AuditRunEvent {
  timestamp: string;
  phase: string;
  action: string;
  message: string;
  artifactPath: string | null;
}

export interface RoleCredential {
  role: string;
  username?: string;
  password?: string;
  notes?: string;
}

export interface StartAuditRunInput {
  appName?: string;
  targetUrl: string;
  auditMode: AuditMode;
  roleCredentials?: RoleCredential[];
  loginHints?: string;
  testDataHints?: string;
  safetyMode?: SafetyMode;
  preferredBackend?: BackendKey;
  promptId?: string;
}

export interface AuditSectionResponse {
  section: string;
  markdown: string;
}

export function emptyArtifactManifest(): ArtifactManifest {
  return {
    screenshots: [],
    traces: [],
    reportFiles: [],
    networkLogs: [],
    consoleLogs: [],
  };
}
