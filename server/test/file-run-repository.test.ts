import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileRunRepository, type AuditRunSnapshot } from "../src/index.js";

const tempDirs: string[] = [];

function makeTempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gaps-qa-repo-"));
  tempDirs.push(dir);
  return dir;
}

const sampleRun: AuditRunSnapshot = {
  id: "run_repo_001",
  appName: "Repository Test",
  targetUrl: "https://example.com",
  auditMode: "surface_map_only",
  runStatus: "queued",
  verdict: null,
  readiness: null,
  startedAt: "2026-03-22T15:00:00.000Z",
  finishedAt: null,
  backendKey: "playwright_cdp",
  targetClassification: "unknown_live",
  safetyMode: "safe_read_only",
  summary: {
    topRisks: [],
    biggestWorkflowFailures: [],
    biggestUxFrictionPoints: [],
    bluntBottomLine: "Queued.",
  },
  surfaces: [],
  components: [],
  uiElementReviews: [],
  workflows: [],
  findings: [],
  blockedItems: [],
  scorecard: null,
  humanNarrative: [],
  artifactManifest: {
    screenshots: [],
    traces: [],
    reportFiles: [],
    networkLogs: [],
    consoleLogs: [],
  },
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("FileRunRepository", () => {
  it("persists snapshots and event streams under a run directory", async () => {
    const rootDir = makeTempDir();
    const repository = new FileRunRepository(rootDir);

    await repository.saveRun(sampleRun);
    await repository.appendEvent(sampleRun.id, {
      timestamp: "2026-03-22T15:00:01.000Z",
      phase: "queued",
      action: "run_created",
      message: "Run created",
      artifactPath: null,
    });

    const restored = await repository.getRun(sampleRun.id);
    const events = await repository.listEvents(sampleRun.id);

    expect(restored?.id).toBe(sampleRun.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe("run_created");
  });
});
