import { EventEmitter } from "node:events";
import path from "node:path";

import {
  canonicalReportPaths,
  createMarkdownBundle,
  emptyArtifactManifest,
  type AuditRunEvent,
  type AuditRunSnapshot,
  type AuditSectionResponse,
  type BackendKey,
  type StartAuditRunInput,
} from "../../../shared/src/index.js";
import {
  buildScorecard,
  classifyTarget,
  defaultSummary,
  deriveReadiness,
  deriveVerdict,
  slugify,
  type BrowserAuditRunner,
} from "../../../runners/src/index.js";
import { FileRunRepository } from "../persistence/file-run-repository.js";
import { createSupplementalReportArtifacts } from "./report-artifacts.js";

interface AuditServiceOptions {
  appName: string;
  repository: FileRunRepository;
  runners: BrowserAuditRunner[];
  publicBasePath: string;
}

function nowIso() {
  return new Date().toISOString();
}

function createRunId(targetUrl: string) {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${slugify(targetUrl)}`;
}

const sectionPathMap: Record<string, string> = {
  summary: "docs/qa/QA_Summary.md",
  surface_map: "docs/qa/App_Surface_Map.md",
  components: "docs/qa/UI_Component_Inventory.md",
  ui_elements: "docs/qa/UI_Element_Writeups.md",
  workflows: "docs/qa/Workflow_Coverage.md",
  findings: "docs/qa/Findings.md",
  narrative: "docs/qa/Human_Test_Narrative.md",
  blocked: "docs/qa/Blocked_and_Untested.md",
  scorecard: "docs/qa/Readiness_Scorecard.md",
};

export class AuditService {
  private readonly emitter = new EventEmitter();
  private readonly inFlight = new Map<string, Promise<AuditRunSnapshot>>();

  constructor(private readonly options: AuditServiceOptions) {}

  async startRun(input: StartAuditRunInput) {
    const runId = createRunId(input.targetUrl);
    const backendKey = input.preferredBackend ?? this.options.runners[0]?.key ?? "playwright_cdp";
    const run: AuditRunSnapshot = {
      id: runId,
      appName: input.appName ?? this.options.appName,
      targetUrl: input.targetUrl,
      auditMode: input.auditMode,
      runStatus: "queued",
      verdict: null,
      readiness: null,
      startedAt: nowIso(),
      finishedAt: null,
      backendKey,
      targetClassification: classifyTarget(input.targetUrl),
      safetyMode: input.safetyMode ?? "safe_read_only",
      summary: defaultSummary("The audit has been queued and is waiting for a browser runner."),
      surfaces: [],
      components: [],
      uiElementReviews: [],
      workflows: [],
      findings: [],
      blockedItems: [],
      scorecard: null,
      humanNarrative: [],
      artifactManifest: emptyArtifactManifest(),
    };

    await this.options.repository.saveRun(run);
    await this.emitEvent(run.id, {
      phase: "queue",
      action: "run_queued",
      message: `Queued audit for ${run.targetUrl}.`,
      artifactPath: null,
    });

    const task = this.executeRun(run, input);
    this.inFlight.set(run.id, task);
    void task.finally(() => {
      this.inFlight.delete(run.id);
    });

    return run;
  }

  waitForRun(runId: string) {
    return this.inFlight.get(runId) ?? Promise.resolve(null);
  }

  listRuns() {
    return this.options.repository.listRuns();
  }

  getRun(runId: string) {
    return this.options.repository.getRun(runId);
  }

  getBundleRoot(runId: string) {
    return path.join(this.options.repository.getRunDir(runId), "bundle");
  }

  listEvents(runId: string) {
    return this.options.repository.listEvents(runId);
  }

  async getSection(runId: string, section: string): Promise<AuditSectionResponse | null> {
    const run = await this.options.repository.getRun(runId);
    if (!run) {
      return null;
    }

    const bundle = createMarkdownBundle(run);
    const resolvedPath = sectionPathMap[section];
    if (!resolvedPath) {
      return null;
    }

    return {
      section,
      markdown: bundle[resolvedPath],
    };
  }

  async listArtifacts(runId: string) {
    const run = await this.options.repository.getRun(runId);
    return run?.artifactManifest ?? null;
  }

  async cancelRun(runId: string) {
    const run = await this.options.repository.getRun(runId);
    if (!run) {
      return null;
    }

    if (run.runStatus === "completed" || run.runStatus === "failed" || run.runStatus === "cancelled") {
      return run;
    }

    const cancelled: AuditRunSnapshot = {
      ...run,
      runStatus: "cancelled",
      finishedAt: nowIso(),
      summary: defaultSummary("The audit was cancelled before completion."),
    };

    await this.options.repository.saveRun(cancelled);
    await this.emitEvent(runId, {
      phase: "queue",
      action: "run_cancelled",
      message: "The audit run was cancelled.",
      artifactPath: null,
    });

    return cancelled;
  }

  subscribe(runId: string, listener: (event: AuditRunEvent) => void) {
    const channel = this.channelFor(runId);
    this.emitter.on(channel, listener);
    return () => {
      this.emitter.off(channel, listener);
    };
  }

  private channelFor(runId: string) {
    return `run:${runId}`;
  }

  private async emitEvent(runId: string, event: Omit<AuditRunEvent, "timestamp">) {
    const enriched: AuditRunEvent = {
      timestamp: nowIso(),
      ...event,
    };
    await this.options.repository.appendEvent(runId, enriched);
    this.emitter.emit(this.channelFor(runId), enriched);
    return enriched;
  }

  private async executeRun(run: AuditRunSnapshot, input: StartAuditRunInput) {
    try {
      const selectedRunner = await this.selectRunner(input.preferredBackend);
      const runningSnapshot: AuditRunSnapshot = {
        ...run,
        runStatus: "running",
        backendKey: selectedRunner.key,
        summary: defaultSummary(`Audit is running with ${selectedRunner.label}.`),
      };

      await this.options.repository.saveRun(runningSnapshot);
      await this.emitEvent(run.id, {
        phase: "runner",
        action: "runner_selected",
        message: `Selected ${selectedRunner.label}.`,
        artifactPath: null,
      });

      const artifactRootDir = path.join(
        this.options.repository.getRunDir(run.id),
        "bundle",
        "docs",
        "qa",
        "artifacts",
      );

      const runnerOutput = await selectedRunner.run({
        runId: run.id,
        appName: run.appName,
        targetUrl: run.targetUrl,
        auditMode: run.auditMode,
        safetyMode: run.safetyMode,
        roleCredentials: input.roleCredentials ?? [],
        loginHints: input.loginHints ?? "",
        testDataHints: input.testDataHints ?? "",
        artifactRootDir,
      });

      const finishedAt = nowIso();
      const scorecard = buildScorecard({
        surfaces: runnerOutput.surfaces,
        components: runnerOutput.components,
        uiElementReviews: runnerOutput.uiElementReviews,
        workflows: runnerOutput.workflows,
        findings: runnerOutput.findings,
        blockedItems: runnerOutput.blockedItems,
      });
      const verdict = deriveVerdict({
        workflows: runnerOutput.workflows,
        findings: runnerOutput.findings,
        blockedItems: runnerOutput.blockedItems,
      });
      const readiness = deriveReadiness(
        verdict,
        runnerOutput.findings,
        runnerOutput.blockedItems,
        runnerOutput.workflows,
      );

      const finalized: AuditRunSnapshot = {
        ...runningSnapshot,
        runStatus: "completed",
        finishedAt,
        targetClassification: runnerOutput.targetClassification,
        verdict,
        readiness,
        summary: runnerOutput.summary,
        surfaces: runnerOutput.surfaces,
        components: runnerOutput.components,
        uiElementReviews: runnerOutput.uiElementReviews,
        workflows: runnerOutput.workflows,
        findings: runnerOutput.findings,
        blockedItems: runnerOutput.blockedItems,
        scorecard,
        humanNarrative: runnerOutput.humanNarrative,
        artifactManifest: {
          screenshots: runnerOutput.artifactManifest.screenshots,
          traces: runnerOutput.artifactManifest.traces,
          reportFiles: [],
          networkLogs: runnerOutput.artifactManifest.networkLogs,
          consoleLogs: runnerOutput.artifactManifest.consoleLogs,
        },
      };

      const reportArtifacts = await createSupplementalReportArtifacts(
        finalized,
        this.options.repository.getRunDir(run.id),
      );
      finalized.artifactManifest.reportFiles = [...canonicalReportPaths, ...Object.keys(reportArtifacts)];
      const bundle = {
        ...createMarkdownBundle(finalized),
        ...reportArtifacts,
      };
      await this.options.repository.writeBundle(run.id, bundle);
      await this.options.repository.saveRun(finalized);
      await this.emitEvent(run.id, {
        phase: "report",
        action: "run_completed",
        message: `Audit completed with verdict ${verdict}.`,
        artifactPath: `${this.options.publicBasePath}/${run.id}/docs/qa/QA_Summary.md`,
      });

      return finalized;
    } catch (error) {
      const failed: AuditRunSnapshot = {
        ...run,
        runStatus: "failed",
        finishedAt: nowIso(),
        verdict: "FAIL",
        readiness: "demo",
        summary: defaultSummary(
          error instanceof Error ? error.message : "The audit runner failed unexpectedly.",
        ),
      };

      await this.options.repository.saveRun(failed);
      await this.emitEvent(run.id, {
        phase: "runner",
        action: "run_failed",
        message: failed.summary.bluntBottomLine,
        artifactPath: null,
      });

      return failed;
    }
  }

  private async selectRunner(preferredBackend?: BackendKey) {
    const orderedRunners = preferredBackend
      ? [
          ...this.options.runners.filter((runner) => runner.key === preferredBackend),
          ...this.options.runners.filter((runner) => runner.key !== preferredBackend),
        ]
      : [...this.options.runners];

    for (const runner of orderedRunners) {
      const availability = await runner.availability();
      if (availability.available) {
        return runner;
      }
    }

    throw new Error("No audit runner is currently available.");
  }
}
