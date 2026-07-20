import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AuditService,
  FileRunRepository,
  type BrowserAuditRunner,
  type RunnerAuditOutput,
} from "../src/index.js";

const tempDirs: string[] = [];

function makeTempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gaps-qa-service-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const fakeOutput: RunnerAuditOutput = {
  targetClassification: "unknown_live",
  summary: {
    topRisks: ["Safe smoke only."],
    biggestWorkflowFailures: [],
    biggestUxFrictionPoints: ["No deeper workflow coverage."],
    bluntBottomLine: "The audit completed, but only a smoke path was exercised.",
  },
  surfaces: [
    {
      id: "surface_root",
      path: "/",
      title: "Fixture App",
      kind: "page",
      entryPoint: "root_navigation",
      result: "PASSED",
      notes: "Loaded fixture root.",
      evidencePaths: ["docs/qa/artifacts/screenshots/root.png"],
    },
  ],
  components: [],
  uiElementReviews: [
    {
      id: "ui_review_root_link",
      surfaceId: "surface_root",
      componentId: null,
      elementType: "link",
      label: "Open fixture root",
      distinctState: "default",
      actionAttempted: "Click fixture root link",
      stepsExecuted: ["Open fixture root"],
      terminalState: "Fixture root visible",
      result: "PASSED",
      humanSummary: "Opened the fixture root and the page stayed stable.",
      linkedFindingIds: [],
      evidencePaths: ["docs/qa/artifacts/screenshots/root.png"],
    },
  ],
  workflows: [
    {
      id: "workflow_root_open",
      name: "Open root page",
      entryPoint: "Initial navigation",
      stepsExecuted: ["Navigate to root"],
      terminalState: "Root page visible",
      result: "PASSED",
      defectIds: [],
      evidencePaths: ["docs/qa/artifacts/screenshots/root.png"],
    },
  ],
  findings: [],
  blockedItems: [],
  humanNarrative: ["The fixture app loaded without resistance."],
  artifactManifest: {
    screenshots: ["docs/qa/artifacts/screenshots/root.png"],
    traces: [],
    reportFiles: [],
    networkLogs: [],
    consoleLogs: [],
  },
};

describe("AuditService", () => {
  it("executes a runner, finalizes the run, and writes the canonical bundle", async () => {
    const dataRoot = makeTempDir();
    const repository = new FileRunRepository(dataRoot);
    const runner: BrowserAuditRunner = {
      key: "playwright_cdp",
      label: "Fake Playwright",
      async availability() {
        return { available: true, reason: null };
      },
      async run() {
        return fakeOutput;
      },
    };

    const service = new AuditService({
      appName: "GAPS QA",
      repository,
      runners: [runner],
      publicBasePath: "/bundles",
    });

    const queuedRun = await service.startRun({
      targetUrl: "https://example.com",
      auditMode: "surface_map_only",
    });

    await service.waitForRun(queuedRun.id);

    const restored = await repository.getRun(queuedRun.id);
    const bundleRoot = path.join(repository.getRunDir(queuedRun.id), "bundle", "docs", "qa");
    const docxPath = path.join(bundleRoot, "UI_Element_Writeups.docx");
    const jsonPath = path.join(bundleRoot, "artifacts", "report", "ui-element-audit.json");

    expect(restored?.runStatus).toBe("completed");
    expect(restored?.artifactManifest.reportFiles).toHaveLength(11);
    expect(restored?.backendKey).toBe("playwright_cdp");
    expect(restored?.uiElementReviews).toHaveLength(1);
    expect(existsSync(docxPath)).toBe(true);
    expect(existsSync(jsonPath)).toBe(true);

    const pythonCheck = spawnSync(
      "python",
      [
        "-c",
        [
          "import sys, zipfile, xml.etree.ElementTree as ET",
          "archive = zipfile.ZipFile(sys.argv[1])",
          "root = ET.fromstring(archive.read('word/document.xml'))",
          "print('\\n'.join(node.text or '' for node in root.iter() if node.tag.endswith('}t')))",
        ].join("; "),
        docxPath,
      ],
      { encoding: "utf8" },
    );

    expect(pythonCheck.status).toBe(0);
    expect(pythonCheck.stdout).toContain("UI Element Writeups");
    expect(pythonCheck.stdout).toContain("Open fixture root");
  });
});
