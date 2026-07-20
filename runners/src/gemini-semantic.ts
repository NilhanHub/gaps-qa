import type { BrowserAuditRunner, RunnerAuditOutput, RunnerContext } from "./types.js";
import { classifyTarget, defaultSummary } from "./utils.js";

export class GeminiSemanticRunner implements BrowserAuditRunner {
  readonly key = "gemini_semantic";
  readonly label = "Gemini Semantic";

  async availability() {
    const enabled = Boolean(process.env.GEMINI_API_KEY);
    return {
      available: enabled,
      reason: enabled ? null : "Set GEMINI_API_KEY to enable the Gemini semantic adapter.",
    };
  }

  async run(context: RunnerContext): Promise<RunnerAuditOutput> {
    return {
      targetClassification: classifyTarget(context.targetUrl),
      summary: defaultSummary(
        "The Gemini semantic adapter is scaffolded, but semantic browser control has not been implemented in this repo yet.",
      ),
      surfaces: [],
      components: [],
      uiElementReviews: [],
      workflows: [
        {
          id: "workflow_gemini_placeholder",
          name: "Gemini semantic execution",
          entryPoint: "Runner selection",
          stepsExecuted: ["Select Gemini semantic backend"],
          terminalState: "Runner scaffold present but semantic browser-control loop not implemented",
          result: "BLOCKED",
          defectIds: [],
          evidencePaths: [],
        },
      ],
      findings: [],
      blockedItems: [
        {
          id: "blocked_gemini_unwired",
          category: "environment",
          title: "Gemini semantic backend not yet attached",
          reason:
            "The adapter is present for architecture parity, but no Gemini browser-control worker is wired into the runtime yet.",
          result: "BLOCKED",
        },
      ],
      humanNarrative: [
        "The run was routed to the Gemini semantic adapter, but the repo currently exposes it as a parity scaffold rather than a live semantic-control runner.",
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
