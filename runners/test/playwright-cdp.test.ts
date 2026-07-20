import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PlaywrightCdpRunner } from "../src/playwright-cdp.js";

const tempDirs: string[] = [];
const liveServers: Server[] = [];

function makeTempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gaps-qa-runner-"));
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

function makeFixtureServer() {
  return createServer((req, res) => {
    if (req.url === "/details") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(`<!doctype html>
        <html>
          <head><title>Details</title></head>
          <body>
            <h1>Details page</h1>
            <a href="/">Back home</a>
          </body>
        </html>`);
      return;
    }

    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<!doctype html>
      <html>
        <head>
          <title>Fixture Root</title>
          <style>
            body { font-family: sans-serif; padding: 24px; }
            [hidden] { display: none; }
          </style>
        </head>
        <body>
          <h1>Fixture Root</h1>
          <a href="/details">Open details page</a>
          <button id="dialog-trigger" aria-expanded="false">Open details panel</button>
          <div id="dialog-panel" role="dialog" hidden>
            <p>Dialog body</p>
            <button id="dialog-close">Close panel</button>
          </div>

          <div role="tablist" aria-label="Demo tabs">
            <button role="tab" id="tab-overview" aria-selected="true" aria-controls="panel-overview">Overview</button>
            <button role="tab" id="tab-profile" aria-selected="false" aria-controls="panel-profile">Profile</button>
          </div>
          <section id="panel-overview">Overview panel</section>
          <section id="panel-profile" hidden>Profile panel</section>

          <form id="demo-form">
            <label for="name-input">Name</label>
            <input id="name-input" name="name" required />
            <button type="submit">Submit form</button>
          </form>

          <button disabled>Disabled control</button>

          <script>
            const trigger = document.getElementById('dialog-trigger');
            const dialog = document.getElementById('dialog-panel');
            const close = document.getElementById('dialog-close');
            trigger.addEventListener('click', () => {
              dialog.hidden = false;
              trigger.setAttribute('aria-expanded', 'true');
            });
            close.addEventListener('click', () => {
              dialog.hidden = true;
              trigger.setAttribute('aria-expanded', 'false');
            });

            const overviewTab = document.getElementById('tab-overview');
            const profileTab = document.getElementById('tab-profile');
            const overviewPanel = document.getElementById('panel-overview');
            const profilePanel = document.getElementById('panel-profile');
            profileTab.addEventListener('click', () => {
              profileTab.setAttribute('aria-selected', 'true');
              overviewTab.setAttribute('aria-selected', 'false');
              profilePanel.hidden = false;
              overviewPanel.hidden = true;
            });
            overviewTab.addEventListener('click', () => {
              profileTab.setAttribute('aria-selected', 'false');
              overviewTab.setAttribute('aria-selected', 'true');
              profilePanel.hidden = true;
              overviewPanel.hidden = false;
            });

            document.getElementById('demo-form').addEventListener('submit', (event) => {
              event.preventDefault();
            });
          </script>
        </body>
      </html>`);
  });
}

describe("PlaywrightCdpRunner", () => {
  it("creates UI element reviews for safe deep interactions on a live fixture", async () => {
    const server = makeFixtureServer();
    const baseUrl = await listen(server);
    const runner = new PlaywrightCdpRunner();
    const artifactRootDir = path.join(makeTempDir(), "bundle", "docs", "qa", "artifacts");

    const output = await runner.run({
      runId: "fixture_run",
      appName: "Fixture App",
      targetUrl: baseUrl,
      auditMode: "workflow_audit",
      safetyMode: "safe_read_only",
      roleCredentials: [],
      loginHints: "",
      testDataHints: "",
      artifactRootDir,
    });

    expect(output.surfaces.some((surface) => surface.title === "Fixture Root")).toBe(true);
    expect(output.surfaces.some((surface) => surface.title === "Details")).toBe(true);
    expect(output.uiElementReviews.some((review) => review.label === "Open details page" && review.result === "PASSED")).toBe(true);
    expect(output.uiElementReviews.some((review) => review.label === "Open details panel" && review.result === "PASSED")).toBe(true);
    expect(output.uiElementReviews.some((review) => review.label === "Profile" && review.result === "PASSED")).toBe(true);
    expect(output.uiElementReviews.some((review) => review.label === "Name" && review.result === "PASSED")).toBe(true);
    expect(output.uiElementReviews.some((review) => review.label === "Submit form" && review.result === "PASSED")).toBe(true);
    expect(output.uiElementReviews.some((review) => review.label === "Disabled control" && review.result === "BLOCKED")).toBe(true);
    expect(output.components.some((component) => component.result === "UNVERIFIED")).toBe(false);
  }, 20_000);
});
