import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AuditService,
  FileRunRepository,
  type BrowserAuditRunner,
  type RunnerAuditOutput,
} from "../src/index.js";
import { createNodeServer } from "../src/http/create-node-server.js";

const tempDirs: string[] = [];
const liveServers: Server[] = [];

function makeTempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gaps-qa-http-"));
  tempDirs.push(dir);
  return dir;
}

async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });

  liveServers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected an address with a port.");
  }

  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  while (liveServers.length > 0) {
    const server = liveServers.pop();
    if (!server) {
      continue;
    }

    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

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

describe("createNodeServer", () => {
  it("serves health, run creation, and report sections", async () => {
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

    const server = createNodeServer({
      service,
      widgetHtmlLoader: async () => "<!doctype html><html><body>fixture</body></html>",
      publicBasePath: "/bundles",
    });
    const baseUrl = await listen(server);

    const healthResponse = await fetch(`${baseUrl}/health`);
    expect(healthResponse.status).toBe(200);
    expect(await healthResponse.json()).toEqual({ ok: true });

    const startResponse = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        targetUrl: "https://example.com",
        auditMode: "surface_map_only",
      }),
    });
    expect(startResponse.status).toBe(202);

    const queued = (await startResponse.json()) as { id: string };
    await service.waitForRun(queued.id);

    const runResponse = await fetch(`${baseUrl}/api/runs/${queued.id}`);
    const runJson = (await runResponse.json()) as { runStatus: string };
    expect(runJson.runStatus).toBe("completed");

    const sectionResponse = await fetch(`${baseUrl}/api/runs/${queued.id}/section/summary`);
    const sectionJson = (await sectionResponse.json()) as { markdown: string };
    expect(sectionJson.markdown).toContain("# QA Summary");

    const uiElementsResponse = await fetch(`${baseUrl}/api/runs/${queued.id}/section/ui_elements`);
    const uiElementsJson = (await uiElementsResponse.json()) as { markdown: string };
    expect(uiElementsJson.markdown).toContain("# UI Element Writeups");

    const artifactsResponse = await fetch(`${baseUrl}/api/runs/${queued.id}/artifacts`);
    const artifactsJson = (await artifactsResponse.json()) as { reportFiles: string[] };
    expect(artifactsJson.reportFiles).toContain("docs/qa/UI_Element_Writeups.docx");
    expect(artifactsJson.reportFiles).toContain("docs/qa/artifacts/report/ui-element-audit.json");

    const bundleResponse = await fetch(`${baseUrl}/bundles/${queued.id}/docs/qa/QA_Summary.md`);
    expect(bundleResponse.status).toBe(200);
    expect(await bundleResponse.text()).toContain("# QA Summary");
  });
});
