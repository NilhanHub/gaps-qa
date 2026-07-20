import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { AuditService } from "../services/audit-service.js";
import { createAppServer } from "../mcp/create-app-server.js";
import { loadWidgetHtml } from "../widget/load-widget-html.js";

interface CreateNodeServerOptions {
  service: AuditService;
  publicBasePath: string;
  publicBaseUrl?: string;
  widgetHtmlLoader?: (publicBaseUrl: string | null) => Promise<string>;
}

function writeJson(res: ServerResponse, statusCode: number, payload: unknown) {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const body = Buffer.concat(chunks).toString("utf8");
  return body ? (JSON.parse(body) as Record<string, unknown>) : {};
}

function contentTypeFor(filePath: string) {
  if (filePath.endsWith(".html")) {
    return "text/html; charset=utf-8";
  }
  if (filePath.endsWith(".js")) {
    return "application/javascript; charset=utf-8";
  }
  if (filePath.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }
  if (filePath.endsWith(".json")) {
    return "application/json; charset=utf-8";
  }
  if (filePath.endsWith(".png")) {
    return "image/png";
  }
  if (filePath.endsWith(".jpg") || filePath.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  if (filePath.endsWith(".zip")) {
    return "application/zip";
  }
  if (filePath.endsWith(".docx")) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  if (filePath.endsWith(".txt") || filePath.endsWith(".md")) {
    return "text/plain; charset=utf-8";
  }

  return "application/octet-stream";
}

function safeJoin(rootPath: string, requestedPath: string) {
  const normalizedRoot = path.resolve(rootPath);
  const resolvedPath = path.resolve(rootPath, requestedPath);

  if (!resolvedPath.startsWith(normalizedRoot)) {
    throw new Error("Unsafe path traversal attempt.");
  }

  return resolvedPath;
}

async function serveFile(res: ServerResponse, filePath: string) {
  try {
    const file = await readFile(filePath);
    res.statusCode = 200;
    res.setHeader("content-type", contentTypeFor(filePath));
    res.end(file);
  } catch {
    writeJson(res, 404, { error: "Not found" });
  }
}

function sectionKeyFromPath(raw: string) {
  switch (raw) {
    case "summary":
      return "summary";
    case "surface_map":
      return "surface_map";
    case "components":
      return "components";
    case "ui_elements":
      return "ui_elements";
    case "workflows":
      return "workflows";
    case "findings":
      return "findings";
    case "narrative":
      return "narrative";
    case "blocked":
      return "blocked";
    case "scorecard":
      return "scorecard";
    default:
      return null;
  }
}

function inferPublicBaseUrl(req: IncomingMessage, explicit?: string) {
  if (explicit) {
    return explicit;
  }

  const host = req.headers.host;
  if (!host) {
    return null;
  }

  const forwardedProto = req.headers["x-forwarded-proto"];
  const protocol = Array.isArray(forwardedProto)
    ? forwardedProto[0]
    : forwardedProto?.split(",")[0].trim() || "http";

  return `${protocol}://${host}`;
}

export function createNodeServer(options: CreateNodeServerOptions): Server {
  const widgetLoader =
    options.widgetHtmlLoader ??
    (async (publicBaseUrl: string | null) => loadWidgetHtml(publicBaseUrl));

  return createServer(async (req, res) => {
    if (!req.url || !req.method) {
      writeJson(res, 400, { error: "Missing request metadata" });
      return;
    }

    const requestUrl = new URL(req.url, "http://127.0.0.1");
    const pathname = requestUrl.pathname;

    try {
      if (req.method === "GET" && pathname === "/health") {
        writeJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "GET" && pathname === "/api/runs") {
        const runs = await options.service.listRuns();
        writeJson(res, 200, runs);
        return;
      }

      if (req.method === "POST" && pathname === "/api/runs") {
        const payload = await readJsonBody(req);
        const run = await options.service.startRun({
          targetUrl: String(payload.targetUrl ?? ""),
          auditMode: String(payload.auditMode ?? "full_ui_release_audit") as
            | "surface_map_only"
            | "workflow_audit"
            | "full_ui_release_audit",
          roleCredentials: Array.isArray(payload.roleCredentials)
            ? payload.roleCredentials.map((entry) => ({
                role: String((entry as Record<string, unknown>).role ?? ""),
                username:
                  typeof (entry as Record<string, unknown>).username === "string"
                    ? String((entry as Record<string, unknown>).username)
                    : undefined,
                password:
                  typeof (entry as Record<string, unknown>).password === "string"
                    ? String((entry as Record<string, unknown>).password)
                    : undefined,
                notes:
                  typeof (entry as Record<string, unknown>).notes === "string"
                    ? String((entry as Record<string, unknown>).notes)
                    : undefined,
              }))
            : undefined,
          loginHints: typeof payload.loginHints === "string" ? payload.loginHints : undefined,
          testDataHints: typeof payload.testDataHints === "string" ? payload.testDataHints : undefined,
          safetyMode:
            typeof payload.safetyMode === "string"
              ? (payload.safetyMode as "safe_read_only" | "allow_risky_write_in_non_production")
              : undefined,
          preferredBackend:
            typeof payload.preferredBackend === "string"
              ? (payload.preferredBackend as "playwright_cdp" | "windows_local" | "gemini_semantic")
              : undefined,
          promptId: typeof payload.promptId === "string" ? payload.promptId : undefined,
        });
        writeJson(res, 202, run);
        return;
      }

      const runMatch = pathname.match(/^\/api\/runs\/([^/]+)$/);
      if (req.method === "GET" && runMatch) {
        const run = await options.service.getRun(decodeURIComponent(runMatch[1]));
        if (!run) {
          writeJson(res, 404, { error: "Run not found" });
          return;
        }

        writeJson(res, 200, run);
        return;
      }

      const sectionMatch = pathname.match(/^\/api\/runs\/([^/]+)\/section\/([^/]+)$/);
      if (req.method === "GET" && sectionMatch) {
        const section = sectionKeyFromPath(sectionMatch[2]);
        if (!section) {
          writeJson(res, 404, { error: "Section not found" });
          return;
        }

        const payload = await options.service.getSection(decodeURIComponent(sectionMatch[1]), section);
        if (!payload) {
          writeJson(res, 404, { error: "Section not found" });
          return;
        }

        writeJson(res, 200, payload);
        return;
      }

      const artifactMatch = pathname.match(/^\/api\/runs\/([^/]+)\/artifacts$/);
      if (req.method === "GET" && artifactMatch) {
        const payload = await options.service.listArtifacts(decodeURIComponent(artifactMatch[1]));
        if (!payload) {
          writeJson(res, 404, { error: "Artifacts not found" });
          return;
        }

        writeJson(res, 200, payload);
        return;
      }

      const cancelMatch = pathname.match(/^\/api\/runs\/([^/]+)\/cancel$/);
      if (req.method === "POST" && cancelMatch) {
        const payload = await options.service.cancelRun(decodeURIComponent(cancelMatch[1]));
        if (!payload) {
          writeJson(res, 404, { error: "Run not found" });
          return;
        }

        writeJson(res, 200, payload);
        return;
      }

      const eventsMatch = pathname.match(/^\/api\/runs\/([^/]+)\/events$/);
      if (req.method === "GET" && eventsMatch) {
        const runId = decodeURIComponent(eventsMatch[1]);
        res.statusCode = 200;
        res.setHeader("content-type", "text/event-stream; charset=utf-8");
        res.setHeader("cache-control", "no-cache");
        res.setHeader("connection", "keep-alive");
        res.flushHeaders?.();

        const existing = await options.service.listEvents(runId);
        for (const event of existing) {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        }

        const unsubscribe = options.service.subscribe(runId, (event) => {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        });

        req.on("close", () => {
          unsubscribe();
          res.end();
        });
        return;
      }

      const bundlesPrefix = `${options.publicBasePath}/`;
      if (req.method === "GET" && pathname.startsWith(bundlesPrefix)) {
        const [runId, ...rest] = pathname.slice(bundlesPrefix.length).split("/");
        if (!runId || rest.length === 0) {
          writeJson(res, 404, { error: "Bundle not found" });
          return;
        }

        const bundleRoot = options.service.getBundleRoot(runId);
        const filePath = safeJoin(bundleRoot, rest.join("/"));
        await serveFile(res, filePath);
        return;
      }

      if (req.method === "GET" && (pathname === "/app" || pathname === "/app/")) {
        const publicBaseUrl = inferPublicBaseUrl(req, options.publicBaseUrl);
        const html = await widgetLoader(publicBaseUrl);
        res.statusCode = 200;
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(html);
        return;
      }

      if (req.method === "GET" && pathname.startsWith("/app/")) {
        const distRoot = path.resolve(process.cwd(), "web", "dist");
        const relativePath = pathname.slice("/app/".length);
        const filePath = safeJoin(distRoot, relativePath);
        await serveFile(res, filePath);
        return;
      }

      if (pathname === "/mcp") {
        if (req.method !== "POST") {
          writeJson(res, 405, {
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "Method not allowed.",
            },
            id: null,
          });
          return;
        }

        const publicBaseUrl = inferPublicBaseUrl(req, options.publicBaseUrl);
        const server = createAppServer({
          service: options.service,
          publicBaseUrl,
          widgetHtmlLoader: () => widgetLoader(publicBaseUrl),
        });
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });

        try {
          const parsedBody = await readJsonBody(req);
          await server.connect(transport);
          await transport.handleRequest(req, res, parsedBody);
        } finally {
          res.on("close", () => {
            void transport.close();
            void server.close();
          });
        }
        return;
      }

      writeJson(res, 404, { error: "Not found" });
    } catch (error) {
      writeJson(res, 500, {
        error: error instanceof Error ? error.message : "Unexpected server error",
      });
    }
  });
}
