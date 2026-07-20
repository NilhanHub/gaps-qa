import type { BrowserAuditRunner, RunnerAuditOutput, RunnerContext } from "./types.js";
import { classifyTarget, defaultSummary } from "./utils.js";

export class WindowsLocalRunner implements BrowserAuditRunner {
  readonly key = "windows_local";
  readonly label = "Windows Local";

  async availability() {
    const enabled = process.env.GAPS_QA_ENABLE_WINDOWS_LOCAL === "1";
    return {
      available: enabled,
      reason: enabled ? null : "Set GAPS_QA_ENABLE_WINDOWS_LOCAL=1 to enable the Windows-local adapter.",
    };
  }

  async run(context: RunnerContext): Promise<RunnerAuditOutput> {
    return {
      targetClassification: classifyTarget(context.targetUrl),
      summary: defaultSummary(
        "The Windows-local adapter is scaffolded, but it currently reports blocked coverage until a desktop-control worker is attached.",
      ),
      surfaces: [],
      components: [],
      uiElementReviews: [],
      workflows: [
        {
          id: "workflow_windows_local_placeholder",
          name: "Windows-local execution",
          entryPoint: "Runner selection",
          stepsExecuted: ["Select Windows-local backend"],
          terminalState: "Runner scaffold present but not attached to a live desktop worker",
          result: "BLOCKED",
          defectIds: [],
          evidencePaths: [],
        },
      ],
      findings: [],
      blockedItems: [
        {
          id: "blocked_windows_local_unwired",
          category: "environment",
          title: "Windows-local backend not yet attached",
          reason:
            "The adapter exists for parity, but a live desktop-control worker has not been wired into this repo yet.",
          result: "BLOCKED",
        },
      ],
      humanNarrative: [
        "The run was routed to the Windows-local adapter, but the repo currently exposes it as a parity scaffold rather than a live desktop worker.",
      ],
      artifactManifest: {
        screenshots: [],
        traces: [],
        reportFiles: [],
        networkLogs: [],
        consoleLogs: [],
      },
    };
  }
}
