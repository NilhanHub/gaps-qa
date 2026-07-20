import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";

import {
  allowedAuditModes,
  allowedBackends,
  allowedSafetyModes,
  type AuditSectionResponse,
} from "../../../shared/src/index.js";
import { AuditService } from "../services/audit-service.js";

const WIDGET_URI = "ui://gaps-qa/operator-console.html";

interface CreateAppServerOptions {
  service: AuditService;
  widgetHtmlLoader: () => Promise<string>;
  publicBaseUrl: string | null;
}

function widgetMeta(publicBaseUrl: string | null) {
  const origin = publicBaseUrl ? new URL(publicBaseUrl).origin : null;
  const domains = origin ? [origin] : [];

  return {
    ui: {
      prefersBorder: true,
      csp: {
        connectDomains: domains,
        resourceDomains: domains,
      },
      ...(origin ? { domain: origin } : {}),
    },
    "openai/widgetDescription":
      "A browser-first QA operations console that launches audits, shows live status, and reviews evidence-backed findings.",
  };
}

function buildToolResult(text: string, structuredContent: Record<string, unknown>, publicBaseUrl: string | null) {
  return {
    content: [{ type: "text" as const, text }],
    structuredContent,
    _meta: {
      operatorConsole: {
        apiBaseUrl: publicBaseUrl ?? "",
      },
    },
  };
}

export function createAppServer(options: CreateAppServerOptions) {
  const server = new McpServer(
    {
      name: "gaps-qa",
      version: "0.1.0",
      title: "GAPS QA",
    },
    {
      capabilities: {
        logging: {},
      },
      instructions:
        "Use the audit tools to launch browser-based QA runs, inspect completed reports, and review evidence rather than inferring feature behavior from code.",
    },
  );

  registerAppResource(
    server,
    "GAPS QA Operator Console",
    WIDGET_URI,
    {
      title: "GAPS QA Operator Console",
      description: "Operator UI for launching QA runs and reviewing evidence.",
      _meta: widgetMeta(options.publicBaseUrl),
    },
    async () => ({
      contents: [
        {
          uri: WIDGET_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: await options.widgetHtmlLoader(),
          _meta: widgetMeta(options.publicBaseUrl),
        },
      ],
    }),
  );

  registerAppTool(
    server,
    "start_audit_run",
    {
      title: "Start Audit Run",
      description:
        "Use this when you want to launch a new browser-driven QA run for a target URL and open the operator console on that run.",
      inputSchema: {
        target_url: z.string().url().describe("Reachable URL to audit."),
        audit_mode: z.enum(allowedAuditModes).default("full_ui_release_audit"),
        role_credentials: z
          .array(
            z.object({
              role: z.string(),
              username: z.string().optional(),
              password: z.string().optional(),
              notes: z.string().optional(),
            }),
          )
          .optional(),
        login_hints: z.string().optional(),
        test_data_hints: z.string().optional(),
        safety_mode: z.enum(allowedSafetyModes).default("safe_read_only"),
        preferred_backend: z.enum(allowedBackends).optional(),
        prompt_id: z.string().optional(),
      },
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
      },
      _meta: {
        ui: { resourceUri: WIDGET_URI },
        "openai/toolInvocation/invoking": "Launching audit run",
        "openai/toolInvocation/invoked": "Audit run launched",
      },
    },
    async (args) => {
      const run = await options.service.startRun({
        targetUrl: args.target_url,
        auditMode: args.audit_mode,
        roleCredentials: args.role_credentials,
        loginHints: args.login_hints,
        testDataHints: args.test_data_hints,
        safetyMode: args.safety_mode,
        preferredBackend: args.preferred_backend,
        promptId: args.prompt_id,
      });

      return buildToolResult(
        `Started audit ${run.id} for ${run.targetUrl}.`,
        {
          view: "run_detail",
          runId: run.id,
          run,
        },
        options.publicBaseUrl,
      );
    },
  );

  registerAppTool(
    server,
    "list_audit_runs",
    {
      title: "List Audit Runs",
      description:
        "Use this when you want a concise history of recent QA runs, verdicts, and statuses before drilling into a specific run.",
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
      _meta: {
        ui: { resourceUri: WIDGET_URI },
      },
    },
    async () => {
      const runs = await options.service.listRuns();
      return buildToolResult(
        `Loaded ${runs.length} audit run${runs.length === 1 ? "" : "s"}.`,
        {
          view: "runs",
          runs,
        },
        options.publicBaseUrl,
      );
    },
  );

  registerAppTool(
    server,
    "get_audit_run",
    {
      title: "Get Audit Run",
      description:
        "Use this when you want the latest status, verdict, coverage counters, and backend details for one audit run.",
      inputSchema: {
        run_id: z.string().describe("Audit run ID."),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
      _meta: {
        ui: { resourceUri: WIDGET_URI },
      },
    },
    async ({ run_id }) => {
      const run = await options.service.getRun(run_id);
      if (!run) {
        return buildToolResult(
          `Audit run ${run_id} was not found.`,
          { view: "run_detail", runId: run_id, run: null },
          options.publicBaseUrl,
        );
      }

      return buildToolResult(
        `Loaded audit ${run.id} with status ${run.runStatus}.`,
        {
          view: "run_detail",
          runId: run.id,
          run,
        },
        options.publicBaseUrl,
      );
    },
  );

  registerAppTool(
    server,
    "get_audit_section",
    {
      title: "Get Audit Section",
      description:
        "Use this when you want one canonical markdown report section, such as findings, workflows, or the readiness scorecard.",
      inputSchema: {
        run_id: z.string().describe("Audit run ID."),
        section: z
          .enum([
            "summary",
            "surface_map",
            "components",
            "ui_elements",
            "workflows",
            "findings",
            "narrative",
            "blocked",
            "scorecard",
          ])
          .describe("Report section key."),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
      _meta: {
        ui: { resourceUri: WIDGET_URI },
      },
    },
    async ({ run_id, section }) => {
      const resolved = await options.service.getSection(run_id, section);
      const payload: AuditSectionResponse | null = resolved;

      return buildToolResult(
        payload
          ? `Loaded the ${section} report section for ${run_id}.`
          : `The ${section} report section could not be found for ${run_id}.`,
        {
          view: "section",
          runId: run_id,
          section,
          payload,
        },
        options.publicBaseUrl,
      );
    },
  );

  registerAppTool(
    server,
    "list_audit_artifacts",
    {
      title: "List Audit Artifacts",
      description:
        "Use this when you want the screenshot, trace, console, network, and report artifact paths for a completed or running audit.",
      inputSchema: {
        run_id: z.string().describe("Audit run ID."),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
      _meta: {
        ui: { resourceUri: WIDGET_URI },
      },
    },
    async ({ run_id }) => {
      const artifacts = await options.service.listArtifacts(run_id);
      return buildToolResult(
        artifacts
          ? `Loaded artifact manifest for ${run_id}.`
          : `Artifact manifest for ${run_id} was not found.`,
        {
          view: "artifacts",
          runId: run_id,
          artifacts,
        },
        options.publicBaseUrl,
      );
    },
  );

  registerAppTool(
    server,
    "cancel_audit_run",
    {
      title: "Cancel Audit Run",
      description:
        "Use this when you need to stop a queued or running audit that should not continue.",
      inputSchema: {
        run_id: z.string().describe("Audit run ID."),
      },
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
      },
      _meta: {
        ui: { resourceUri: WIDGET_URI },
      },
    },
    async ({ run_id }) => {
      const run = await options.service.cancelRun(run_id);
      return buildToolResult(
        run
          ? `Audit ${run_id} is now ${run.runStatus}.`
          : `Audit ${run_id} could not be cancelled because it was not found.`,
        {
          view: "run_detail",
          runId: run_id,
          run,
        },
        options.publicBaseUrl,
      );
    },
  );

  return server;
}
