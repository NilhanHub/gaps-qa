import { useEffect, useMemo, useState } from "react";

import { useApp } from "@modelcontextprotocol/ext-apps/react";
import type { App as McpApp } from "@modelcontextprotocol/ext-apps";

import type {
  ArtifactManifest,
  AuditRunEvent,
  AuditRunSnapshot,
  BackendKey,
  CoverageResult,
  StartAuditRunInput,
} from "../../shared/src/index.js";

type SectionKey =
  | "summary"
  | "surface_map"
  | "components"
  | "ui_elements"
  | "workflows"
  | "findings"
  | "blocked"
  | "scorecard"
  | "artifacts";

interface AppConfig {
  apiBaseUrl: string;
}

interface StructuredPayload {
  view?: string;
  runId?: string;
  run?: AuditRunSnapshot | null;
  runs?: AuditRunSnapshot[];
  artifacts?: ArtifactManifest | null;
}

interface OperatorTransport {
  mode: "http" | "mcp";
  ready: boolean;
  apiBaseUrl: string;
  listRuns(): Promise<AuditRunSnapshot[]>;
  getRun(runId: string): Promise<AuditRunSnapshot | null>;
  startRun(input: StartAuditRunInput): Promise<AuditRunSnapshot>;
  cancelRun(runId: string): Promise<AuditRunSnapshot | null>;
  getSection(runId: string, section: SectionKey): Promise<string | null>;
  listArtifacts(runId: string): Promise<ArtifactManifest | null>;
  subscribe(runId: string, onEvent: (event: AuditRunEvent) => void): (() => void) | null;
}

type AppMode = "standalone" | "embedded";

const sectionLabels: Record<SectionKey, string> = {
  summary: "Summary",
  surface_map: "Surfaces",
  components: "Components",
  ui_elements: "UI Elements",
  workflows: "Workflows",
  findings: "Findings",
  blocked: "Blocked",
  scorecard: "Scorecard",
  artifacts: "Artifacts",
};

function getConfig(): AppConfig {
  const globalConfig = (window as typeof window & {
    __GAPS_QA_CONFIG__?: Partial<AppConfig>;
  }).__GAPS_QA_CONFIG__;

  return {
    apiBaseUrl: globalConfig?.apiBaseUrl || window.location.origin,
  };
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(`Request failed with ${response.status}.`);
  }

  return (await response.json()) as T;
}

function createHttpTransport(apiBaseUrl: string): OperatorTransport {
  const baseUrl = apiBaseUrl.replace(/\/$/, "");

  return {
    mode: "http",
    ready: true,
    apiBaseUrl: baseUrl,
    async listRuns() {
      const response = await fetch(`${baseUrl}/api/runs`);
      return readJson<AuditRunSnapshot[]>(response);
    },
    async getRun(runId) {
      const response = await fetch(`${baseUrl}/api/runs/${encodeURIComponent(runId)}`);
      if (response.status === 404) {
        return null;
      }
      return readJson<AuditRunSnapshot>(response);
    },
    async startRun(input) {
      const response = await fetch(`${baseUrl}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      return readJson<AuditRunSnapshot>(response);
    },
    async cancelRun(runId) {
      const response = await fetch(`${baseUrl}/api/runs/${encodeURIComponent(runId)}/cancel`, {
        method: "POST",
      });
      if (response.status === 404) {
        return null;
      }
      return readJson<AuditRunSnapshot>(response);
    },
    async getSection(runId, section) {
      const response = await fetch(
        `${baseUrl}/api/runs/${encodeURIComponent(runId)}/section/${section}`,
      );
      if (response.status === 404) {
        return null;
      }
      const payload = await readJson<{ markdown: string }>(response);
      return payload.markdown;
    },
    async listArtifacts(runId) {
      const response = await fetch(`${baseUrl}/api/runs/${encodeURIComponent(runId)}/artifacts`);
      if (response.status === 404) {
        return null;
      }
      return readJson<ArtifactManifest>(response);
    },
    subscribe(runId, onEvent) {
      const source = new EventSource(`${baseUrl}/api/runs/${encodeURIComponent(runId)}/events`);
      source.onmessage = (event) => {
        onEvent(JSON.parse(event.data) as AuditRunEvent);
      };
      source.onerror = () => {
        source.close();
      };

      return () => {
        source.close();
      };
    },
  };
}

function normalizePayload(result: unknown): StructuredPayload | null {
  if (!result || typeof result !== "object") {
    return null;
  }

  const payload = result as { structuredContent?: StructuredPayload };
  return payload.structuredContent ?? null;
}

function createMcpTransport(app: McpApp, apiBaseUrl: string): OperatorTransport {
  return {
    mode: "mcp",
    ready: true,
    apiBaseUrl,
    async listRuns() {
      const result = await app.callServerTool({ name: "list_audit_runs", arguments: {} });
      return (normalizePayload(result)?.runs ?? []) as AuditRunSnapshot[];
    },
    async getRun(runId) {
      const result = await app.callServerTool({
        name: "get_audit_run",
        arguments: { run_id: runId },
      });
      return (normalizePayload(result)?.run ?? null) as AuditRunSnapshot | null;
    },
    async startRun(input) {
      const result = await app.callServerTool({
        name: "start_audit_run",
        arguments: {
          target_url: input.targetUrl,
          audit_mode: input.auditMode,
          role_credentials: input.roleCredentials,
          login_hints: input.loginHints,
          test_data_hints: input.testDataHints,
          safety_mode: input.safetyMode,
          preferred_backend: input.preferredBackend,
          prompt_id: input.promptId,
        },
      });

      const run = normalizePayload(result)?.run as AuditRunSnapshot | undefined;
      if (!run) {
        throw new Error("The app host did not return a run snapshot.");
      }
      return run;
    },
    async cancelRun(runId) {
      const result = await app.callServerTool({
        name: "cancel_audit_run",
        arguments: { run_id: runId },
      });
      return (normalizePayload(result)?.run ?? null) as AuditRunSnapshot | null;
    },
    async getSection(runId, section) {
      const result = await app.callServerTool({
        name: "get_audit_section",
        arguments: { run_id: runId, section },
      });

      const payload = normalizePayload(result) as { payload?: { markdown?: string } | null } | null;
      return payload?.payload?.markdown ?? null;
    },
    async listArtifacts(runId) {
      const result = await app.callServerTool({
        name: "list_audit_artifacts",
        arguments: { run_id: runId },
      });
      return (normalizePayload(result)?.artifacts ?? null) as ArtifactManifest | null;
    },
    subscribe(runId, onEvent) {
      if (!apiBaseUrl) {
        return null;
      }
      return createHttpTransport(apiBaseUrl).subscribe(runId, onEvent);
    },
  };
}

function bundleUrl(apiBaseUrl: string, runId: string, relativePath: string) {
  return `${apiBaseUrl.replace(/\/$/, "")}/bundles/${encodeURIComponent(runId)}/${relativePath}`;
}

function statusTone(result: CoverageResult | AuditRunSnapshot["runStatus"] | AuditRunSnapshot["verdict"] | null | undefined) {
  switch (result) {
    case "PASSED":
    case "completed":
    case "PASS":
      return "ok";
    case "FAILED":
    case "failed":
    case "FAIL":
      return "bad";
    case "BLOCKED":
    case "cancelled":
    case "PASS_WITH_ISSUES":
      return "warn";
    default:
      return "muted";
  }
}

function Metrics({ run }: { run: AuditRunSnapshot }) {
  return (
    <div className="metric-grid">
      <div className="metric-tile">
        <span>Verdict</span>
        <strong className={`tone-${statusTone(run.verdict)}`}>{run.verdict ?? "PENDING"}</strong>
      </div>
      <div className="metric-tile">
        <span>Status</span>
        <strong className={`tone-${statusTone(run.runStatus)}`}>{run.runStatus}</strong>
      </div>
      <div className="metric-tile">
        <span>Surfaces</span>
        <strong>{run.surfaces.length}</strong>
      </div>
      <div className="metric-tile">
        <span>Findings</span>
        <strong>{run.findings.length}</strong>
      </div>
      <div className="metric-tile">
        <span>UI reviews</span>
        <strong>{run.uiElementReviews.length}</strong>
      </div>
      <div className="metric-tile">
        <span>Blocked</span>
        <strong>{run.blockedItems.length}</strong>
      </div>
      <div className="metric-tile">
        <span>Backend</span>
        <strong>{run.backendKey}</strong>
      </div>
    </div>
  );
}

function RunsTable({
  runs,
  selectedRunId,
  onSelect,
}: {
  runs: AuditRunSnapshot[];
  selectedRunId: string | null;
  onSelect: (runId: string) => void;
}) {
  return (
    <div className="panel section-panel">
      <div className="panel-header">
        <h2>Runs</h2>
        <span>{runs.length} tracked</span>
      </div>
      <div className="table-wrap">
        <table className="data-table compact-table">
          <thead>
            <tr>
              <th>Target</th>
              <th>Status</th>
              <th>Verdict</th>
              <th>Backend</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr
                key={run.id}
                className={run.id === selectedRunId ? "is-selected" : undefined}
                onClick={() => onSelect(run.id)}
              >
                <td>
                  <div className="table-primary">{new URL(run.targetUrl).hostname}</div>
                  <div className="table-secondary">{run.auditMode}</div>
                </td>
                <td>
                  <span className={`pill tone-${statusTone(run.runStatus)}`}>{run.runStatus}</span>
                </td>
                <td>
                  <span className={`pill tone-${statusTone(run.verdict)}`}>{run.verdict ?? "PENDING"}</span>
                </td>
                <td>{run.backendKey}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FindingsTable({ run }: { run: AuditRunSnapshot }) {
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th>ID</th>
            <th>Severity</th>
            <th>Area</th>
            <th>Title</th>
            <th>Confidence</th>
          </tr>
        </thead>
        <tbody>
          {run.findings.length === 0 ? (
            <tr>
              <td colSpan={5} className="empty-cell">
                No findings logged for this run.
              </td>
            </tr>
          ) : (
            run.findings.map((finding) => (
              <tr key={finding.id}>
                <td>{finding.id}</td>
                <td>
                  <span className={`pill tone-${finding.severity === "LOW" ? "muted" : "bad"}`}>
                    {finding.severity}
                  </span>
                </td>
                <td>{finding.area}</td>
                <td>
                  <div className="table-primary">{finding.title}</div>
                  <div className="table-secondary">{finding.componentOrWorkflow}</div>
                </td>
                <td>{finding.confidence}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function ArtifactsPanel({
  apiBaseUrl,
  run,
  artifacts,
}: {
  apiBaseUrl: string;
  run: AuditRunSnapshot;
  artifacts: ArtifactManifest | null;
}) {
  const screenshots = artifacts?.screenshots ?? run.artifactManifest.screenshots;
  const traces = artifacts?.traces ?? run.artifactManifest.traces;
  const reportFiles = artifacts?.reportFiles ?? run.artifactManifest.reportFiles;
  const consoleLogs = artifacts?.consoleLogs ?? run.artifactManifest.consoleLogs;
  const networkLogs = artifacts?.networkLogs ?? run.artifactManifest.networkLogs;

  return (
    <div className="artifact-layout">
      <div className="artifact-gallery">
        {screenshots.length === 0 ? (
          <div className="empty-surface">No screenshots captured yet.</div>
        ) : (
          screenshots.map((relativePath) => (
            <a
              key={relativePath}
              className="artifact-card"
              href={bundleUrl(apiBaseUrl, run.id, relativePath)}
              target="_blank"
              rel="noreferrer"
            >
              <img
                src={bundleUrl(apiBaseUrl, run.id, relativePath)}
                alt={relativePath}
              />
              <span>{relativePath.split("/").slice(-1)[0]}</span>
            </a>
          ))
        )}
      </div>
      <div className="artifact-links">
        <h3>Reports</h3>
        {reportFiles.length === 0 ? (
          <div className="empty-surface">No report artifacts generated yet.</div>
        ) : (
          reportFiles.map((relativePath) => (
            <a
              key={relativePath}
              href={bundleUrl(apiBaseUrl, run.id, relativePath)}
              target="_blank"
              rel="noreferrer"
            >
              {relativePath}
            </a>
          ))
        )}
      </div>
      <div className="artifact-links">
        <h3>Trace + logs</h3>
        {[...traces, ...consoleLogs, ...networkLogs].length === 0 ? (
          <div className="empty-surface">No trace or log artifacts captured yet.</div>
        ) : (
          [...traces, ...consoleLogs, ...networkLogs].map((relativePath) => (
            <a
              key={relativePath}
              href={bundleUrl(apiBaseUrl, run.id, relativePath)}
              target="_blank"
              rel="noreferrer"
            >
              {relativePath}
            </a>
          ))
        )}
      </div>
    </div>
  );
}

function Timeline({ events }: { events: AuditRunEvent[] }) {
  return (
    <div className="panel section-panel">
      <div className="panel-header">
        <h2>Live Timeline</h2>
        <span>{events.length} events</span>
      </div>
      <div className="timeline">
        {events.length === 0 ? (
          <div className="empty-surface">No timeline events yet.</div>
        ) : (
          events.map((event) => (
            <div key={`${event.timestamp}-${event.action}`} className="timeline-item">
              <div className="timeline-phase">{event.phase}</div>
              <div className="timeline-copy">
                <strong>{event.action}</strong>
                <p>{event.message}</p>
                <span>{new Date(event.timestamp).toLocaleString()}</span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function SectionBody({
  tab,
  run,
  artifacts,
  apiBaseUrl,
}: {
  tab: SectionKey;
  run: AuditRunSnapshot;
  artifacts: ArtifactManifest | null;
  apiBaseUrl: string;
}) {
  if (tab === "findings") {
    return <FindingsTable run={run} />;
  }

  if (tab === "surface_map") {
    return (
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Surface</th>
              <th>Path</th>
              <th>Kind</th>
              <th>Result</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {run.surfaces.map((surface) => (
              <tr key={surface.id}>
                <td>{surface.title}</td>
                <td>{surface.path}</td>
                <td>{surface.kind}</td>
                <td>
                  <span className={`pill tone-${statusTone(surface.result)}`}>{surface.result}</span>
                </td>
                <td>{surface.notes}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (tab === "components") {
    return (
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Surface</th>
              <th>Type</th>
              <th>Label</th>
              <th>State</th>
              <th>Action</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {run.components.length === 0 ? (
              <tr>
                <td colSpan={6} className="empty-cell">
                  No component inventory captured yet.
                </td>
              </tr>
            ) : (
              run.components.map((component) => (
                <tr key={component.id}>
                  <td>{component.surfaceId}</td>
                  <td>{component.type}</td>
                  <td>{component.label}</td>
                  <td>{component.distinctState}</td>
                  <td>{component.actionAttempted}</td>
                  <td>
                    <span className={`pill tone-${statusTone(component.result)}`}>{component.result}</span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    );
  }

  if (tab === "ui_elements") {
    return (
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Label</th>
              <th>Surface</th>
              <th>Action</th>
              <th>Terminal state</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {run.uiElementReviews.length === 0 ? (
              <tr>
                <td colSpan={5} className="empty-cell">
                  No UI element reviews captured yet.
                </td>
              </tr>
            ) : (
              run.uiElementReviews.map((review) => (
                <tr key={review.id}>
                  <td>
                    <div className="table-primary">{review.label}</div>
                    <div className="table-secondary">{review.humanSummary}</div>
                  </td>
                  <td>{review.surfaceId}</td>
                  <td>{review.actionAttempted}</td>
                  <td>{review.terminalState}</td>
                  <td>
                    <span className={`pill tone-${statusTone(review.result)}`}>{review.result}</span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    );
  }

  if (tab === "workflows") {
    return (
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Entry point</th>
              <th>Terminal state</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {run.workflows.map((workflow) => (
              <tr key={workflow.id}>
                <td>
                  <div className="table-primary">{workflow.name}</div>
                  <div className="table-secondary">{workflow.stepsExecuted.join(" -> ")}</div>
                </td>
                <td>{workflow.entryPoint}</td>
                <td>{workflow.terminalState}</td>
                <td>
                  <span className={`pill tone-${statusTone(workflow.result)}`}>{workflow.result}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (tab === "blocked") {
    return (
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Category</th>
              <th>Title</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {run.blockedItems.length === 0 ? (
              <tr>
                <td colSpan={3} className="empty-cell">
                  No blocked areas recorded.
                </td>
              </tr>
            ) : (
              run.blockedItems.map((item) => (
                <tr key={item.id}>
                  <td>{item.category}</td>
                  <td>{item.title}</td>
                  <td>{item.reason}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    );
  }

  if (tab === "scorecard") {
    const scorecard = run.scorecard;
    return scorecard ? (
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Area</th>
              <th>Score</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(scorecard).map(([key, value]) => (
              <tr key={key}>
                <td>{key}</td>
                <td>{value.score}/10</td>
                <td>{value.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    ) : (
      <div className="empty-surface">No scorecard has been calculated yet.</div>
    );
  }

  if (tab === "summary") {
    return (
      <div className="summary-layout">
        <Metrics run={run} />
        <div className="summary-notes">
          <div className="note-block">
            <h3>Top risks</h3>
            <ul>
              {run.summary.topRisks.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
          <div className="note-block">
            <h3>Workflow failures</h3>
            <ul>
              {run.summary.biggestWorkflowFailures.length === 0 ? (
                <li>No failed workflows recorded.</li>
              ) : (
                run.summary.biggestWorkflowFailures.map((item) => <li key={item}>{item}</li>)
              )}
            </ul>
          </div>
          <div className="note-block">
            <h3>UX friction</h3>
            <ul>
              {run.summary.biggestUxFrictionPoints.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
          <div className="note-block">
            <h3>Blunt bottom line</h3>
            <p>{run.summary.bluntBottomLine}</p>
          </div>
        </div>
      </div>
    );
  }

  return <ArtifactsPanel apiBaseUrl={apiBaseUrl} run={run} artifacts={artifacts} />;
}

function OperatorConsole({
  mode,
  transport,
  initialPayload,
  hostError,
}: {
  mode: AppMode;
  transport: OperatorTransport;
  initialPayload: StructuredPayload | null;
  hostError: string | null;
}) {
  const [runs, setRuns] = useState<AuditRunSnapshot[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(initialPayload?.runId ?? null);
  const [selectedRun, setSelectedRun] = useState<AuditRunSnapshot | null>(initialPayload?.run ?? null);
  const [events, setEvents] = useState<AuditRunEvent[]>([]);
  const [artifacts, setArtifacts] = useState<ArtifactManifest | null>(null);
  const [activeTab, setActiveTab] = useState<SectionKey>("summary");
  const [sectionMarkdown, setSectionMarkdown] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(hostError);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formState, setFormState] = useState({
    targetUrl: "https://example.com",
    auditMode: "full_ui_release_audit" as StartAuditRunInput["auditMode"],
    preferredBackend: "playwright_cdp" as BackendKey,
    safetyMode: "safe_read_only" as StartAuditRunInput["safetyMode"],
    loginHints: "",
    testDataHints: "",
  });

  useEffect(() => {
    let cancelled = false;
    transport
      .listRuns()
      .then((items) => {
        if (cancelled) {
          return;
        }
        const sorted = [...items].sort((left, right) => right.startedAt.localeCompare(left.startedAt));
        setRuns(sorted);
        if (!selectedRunId && sorted[0]) {
          setSelectedRunId(sorted[0].id);
        }
      })
      .catch((error: Error) => {
        if (!cancelled) {
          setErrorMessage(error.message);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [transport, selectedRunId]);

  useEffect(() => {
    if (!selectedRunId) {
      return;
    }

    let cancelled = false;
    transport
      .getRun(selectedRunId)
      .then((run) => {
        if (!cancelled) {
          setSelectedRun(run);
        }
      })
      .catch((error: Error) => {
        if (!cancelled) {
          setErrorMessage(error.message);
        }
      });

    transport
      .listArtifacts(selectedRunId)
      .then((manifest) => {
        if (!cancelled) {
          setArtifacts(manifest);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setArtifacts(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedRunId, transport]);

  useEffect(() => {
    if (!selectedRunId) {
      setSectionMarkdown(null);
      return;
    }

    if (activeTab === "artifacts") {
      setSectionMarkdown(null);
      return;
    }

    let cancelled = false;
    transport
      .getSection(selectedRunId, activeTab)
      .then((markdown) => {
        if (!cancelled) {
          setSectionMarkdown(markdown);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSectionMarkdown(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeTab, selectedRunId, transport]);

  useEffect(() => {
    if (!selectedRunId) {
      setEvents([]);
      return;
    }

    const unsubscribe = transport.subscribe(selectedRunId, (event) => {
      setEvents((current) => {
        const next = [...current, event];
        return next.slice(-40);
      });
    });

    return () => {
      unsubscribe?.();
    };
  }, [selectedRunId, transport]);

  useEffect(() => {
    if (!initialPayload?.runId) {
      return;
    }

    setSelectedRunId(initialPayload.runId);
    if (initialPayload.run) {
      setSelectedRun(initialPayload.run);
    }
  }, [initialPayload]);

  const selectedTitle = useMemo(() => {
    if (!selectedRun) {
      return "No run selected";
    }
    return new URL(selectedRun.targetUrl).hostname;
  }, [selectedRun]);

  async function handleStartRun() {
    setIsSubmitting(true);
    setErrorMessage(null);
    try {
      const created = await transport.startRun({
        targetUrl: formState.targetUrl,
        auditMode: formState.auditMode,
        safetyMode: formState.safetyMode,
        preferredBackend: formState.preferredBackend,
        loginHints: formState.loginHints || undefined,
        testDataHints: formState.testDataHints || undefined,
      });

      setRuns((current) => [created, ...current.filter((item) => item.id !== created.id)]);
      setSelectedRunId(created.id);
      setSelectedRun(created);
      setActiveTab("summary");
      setEvents([]);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to start audit run.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleCancelRun() {
    if (!selectedRunId) {
      return;
    }

    const cancelled = await transport.cancelRun(selectedRunId);
    if (cancelled) {
      setSelectedRun(cancelled);
      setRuns((current) =>
        current.map((item) => (item.id === cancelled.id ? cancelled : item)),
      );
    }
  }

  return (
    <div className="workspace-shell">
      <header className="topbar">
        <div>
          <div className="eyebrow">GAPS QA</div>
          <h1>Browser evidence console</h1>
        </div>
        <div className="topbar-meta">
          <span className="mode-chip">{mode === "embedded" ? "ChatGPT widget" : "Standalone preview"}</span>
          <span className={`mode-chip ${transport.ready ? "tone-ok" : "tone-warn"}`}>
            {transport.ready ? "Connected" : "Connecting"}
          </span>
        </div>
      </header>

      <div className="workspace-grid">
        <aside className="left-rail">
          <div className="panel launch-panel">
            <div className="panel-header">
              <h2>New run</h2>
              <span>Launch safely</span>
            </div>
            <label>
              Target URL
              <input
                value={formState.targetUrl}
                onChange={(event) =>
                  setFormState((current) => ({ ...current, targetUrl: event.target.value }))
                }
              />
            </label>
            <label>
              Audit mode
              <select
                value={formState.auditMode}
                onChange={(event) =>
                  setFormState((current) => ({
                    ...current,
                    auditMode: event.target.value as StartAuditRunInput["auditMode"],
                  }))
                }
              >
                <option value="surface_map_only">surface_map_only</option>
                <option value="workflow_audit">workflow_audit</option>
                <option value="full_ui_release_audit">full_ui_release_audit</option>
              </select>
            </label>
            <label>
              Preferred backend
              <select
                value={formState.preferredBackend}
                onChange={(event) =>
                  setFormState((current) => ({
                    ...current,
                    preferredBackend: event.target.value as BackendKey,
                  }))
                }
              >
                <option value="playwright_cdp">playwright_cdp</option>
                <option value="windows_local">windows_local</option>
                <option value="gemini_semantic">gemini_semantic</option>
              </select>
            </label>
            <label>
              Safety mode
              <select
                value={formState.safetyMode}
                onChange={(event) =>
                  setFormState((current) => ({
                    ...current,
                    safetyMode: event.target.value as StartAuditRunInput["safetyMode"],
                  }))
                }
              >
                <option value="safe_read_only">safe_read_only</option>
                <option value="allow_risky_write_in_non_production">
                  allow_risky_write_in_non_production
                </option>
              </select>
            </label>
            <label>
              Login hints
              <textarea
                rows={3}
                value={formState.loginHints}
                onChange={(event) =>
                  setFormState((current) => ({ ...current, loginHints: event.target.value }))
                }
              />
            </label>
            <label>
              Test data hints
              <textarea
                rows={3}
                value={formState.testDataHints}
                onChange={(event) =>
                  setFormState((current) => ({ ...current, testDataHints: event.target.value }))
                }
              />
            </label>
            <button className="primary-button" disabled={isSubmitting} onClick={handleStartRun}>
              {isSubmitting ? "Launching..." : "Start audit run"}
            </button>
          </div>

          <RunsTable runs={runs} selectedRunId={selectedRunId} onSelect={setSelectedRunId} />
        </aside>

        <main className="main-column">
          {errorMessage ? <div className="alert-banner">{errorMessage}</div> : null}

          <div className="panel detail-panel">
            <div className="panel-header">
              <div>
                <div className="eyebrow">Run detail</div>
                <h2>{selectedTitle}</h2>
              </div>
              {selectedRun ? (
                <div className="detail-actions">
                  <span className={`pill tone-${statusTone(selectedRun.runStatus)}`}>{selectedRun.runStatus}</span>
                  <button className="secondary-button" onClick={handleCancelRun}>
                    Cancel run
                  </button>
                </div>
              ) : null}
            </div>

            {!selectedRun ? (
              <div className="empty-surface">
                Select a run to inspect its surfaces, workflows, findings, and artifacts.
              </div>
            ) : (
              <>
                <div className="run-strip">
                  <div>
                    <span>Target</span>
                    <strong>{selectedRun.targetUrl}</strong>
                  </div>
                  <div>
                    <span>Classification</span>
                    <strong>{selectedRun.targetClassification}</strong>
                  </div>
                  <div>
                    <span>Readiness</span>
                    <strong>{selectedRun.readiness ?? "PENDING"}</strong>
                  </div>
                  <div>
                    <span>Started</span>
                    <strong>{new Date(selectedRun.startedAt).toLocaleString()}</strong>
                  </div>
                </div>

                <div className="tab-strip">
                  {(Object.keys(sectionLabels) as SectionKey[]).map((tab) => (
                    <button
                      key={tab}
                      className={tab === activeTab ? "tab-button is-active" : "tab-button"}
                      onClick={() => setActiveTab(tab)}
                    >
                      {sectionLabels[tab]}
                    </button>
                  ))}
                </div>

                <SectionBody
                  tab={activeTab}
                  run={selectedRun}
                  artifacts={artifacts}
                  apiBaseUrl={transport.apiBaseUrl}
                />

                <div className="markdown-panel">
                  <div className="panel-header">
                    <h2>Canonical markdown</h2>
                    <span>{sectionLabels[activeTab]}</span>
                  </div>
                  <pre>{sectionMarkdown ?? "This section is not available yet."}</pre>
                </div>
              </>
            )}
          </div>
        </main>

        <aside className="right-rail">
          <Timeline events={events} />
          {selectedRun ? (
            <div className="panel section-panel">
              <div className="panel-header">
                <h2>Human notes</h2>
                <span>{selectedRun.humanNarrative.length} captured</span>
              </div>
              <ul className="note-list">
                {selectedRun.humanNarrative.length === 0 ? (
                  <li>No narrative notes captured yet.</li>
                ) : (
                  selectedRun.humanNarrative.map((note) => <li key={note}>{note}</li>)
                )}
              </ul>
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

function EmbeddedAppRoot({ config }: { config: AppConfig }) {
  const [payload, setPayload] = useState<StructuredPayload | null>(null);
  const { app, isConnected, error } = useApp({
    appInfo: { name: "GAPS QA", version: "0.1.0" },
    capabilities: {},
    onAppCreated(createdApp) {
      createdApp.ontoolresult = (result) => {
        const normalized = normalizePayload(result);
        if (normalized) {
          setPayload(normalized);
        }
      };
    },
  });

  if (!app || !isConnected) {
    return (
      <div className="loading-shell">
        <div className="loading-card">Connecting to the ChatGPT app host...</div>
      </div>
    );
  }

  return (
    <OperatorConsole
      mode="embedded"
      transport={createMcpTransport(app, config.apiBaseUrl)}
      initialPayload={payload}
      hostError={error?.message ?? null}
    />
  );
}

function StandaloneAppRoot({ config }: { config: AppConfig }) {
  return (
    <OperatorConsole
      mode="standalone"
      transport={createHttpTransport(config.apiBaseUrl)}
      initialPayload={null}
      hostError={null}
    />
  );
}

export function App() {
  const config = getConfig();
  const isEmbedded = window.parent !== window;

  return isEmbedded ? <EmbeddedAppRoot config={config} /> : <StandaloneAppRoot config={config} />;
}
