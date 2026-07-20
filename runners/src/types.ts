import type {
  AuditMode,
  AuditSummary,
  ArtifactManifest,
  BackendKey,
  BlockedItem,
  ComponentRecord,
  FindingRecord,
  RoleCredential,
  SafetyMode,
  SurfaceRecord,
  TargetClassification,
  UiElementReviewRecord,
  WorkflowRecord,
} from "../../shared/src/index.js";

export interface RunnerAvailability {
  available: boolean;
  reason: string | null;
}

export interface RunnerContext {
  runId: string;
  appName: string;
  targetUrl: string;
  auditMode: AuditMode;
  safetyMode: SafetyMode;
  roleCredentials: RoleCredential[];
  loginHints: string;
  testDataHints: string;
  artifactRootDir: string;
}

export interface RunnerAuditOutput {
  targetClassification: TargetClassification;
  summary: AuditSummary;
  surfaces: SurfaceRecord[];
  components: ComponentRecord[];
  uiElementReviews: UiElementReviewRecord[];
  workflows: WorkflowRecord[];
  findings: FindingRecord[];
  blockedItems: BlockedItem[];
  humanNarrative: string[];
  artifactManifest: ArtifactManifest;
}

export interface BrowserAuditRunner {
  key: BackendKey;
  label: string;
  availability(context?: Partial<RunnerContext>): Promise<RunnerAvailability> | RunnerAvailability;
  run(context: RunnerContext): Promise<RunnerAuditOutput>;
}
