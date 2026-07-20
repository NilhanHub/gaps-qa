import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  AuditRunEvent,
  AuditRunSnapshot,
} from "../../../shared/src/index.js";

function toJsonLine(value: unknown) {
  return `${JSON.stringify(value)}\n`;
}

async function ensureDir(dirPath: string) {
  await mkdir(dirPath, { recursive: true });
}

async function fileExists(filePath: string) {
  try {
    await readFile(filePath);
    return true;
  } catch {
    return false;
  }
}

export class FileRunRepository {
  constructor(private readonly rootDir: string) {}

  getRunsDir() {
    return path.join(this.rootDir, "runs");
  }

  getRunDir(runId: string) {
    return path.join(this.getRunsDir(), runId);
  }

  private getRunFile(runId: string) {
    return path.join(this.getRunDir(runId), "run.json");
  }

  private getEventsFile(runId: string) {
    return path.join(this.getRunDir(runId), "events.jsonl");
  }

  async saveRun(run: AuditRunSnapshot) {
    await ensureDir(this.getRunDir(run.id));
    await writeFile(this.getRunFile(run.id), `${JSON.stringify(run, null, 2)}\n`, "utf8");
  }

  async getRun(runId: string): Promise<AuditRunSnapshot | null> {
    try {
      const content = await readFile(this.getRunFile(runId), "utf8");
      return JSON.parse(content) as AuditRunSnapshot;
    } catch {
      return null;
    }
  }

  async listRuns(): Promise<AuditRunSnapshot[]> {
    try {
      const entries = await readdir(this.getRunsDir(), { withFileTypes: true });
      const runs = await Promise.all(
        entries
          .filter((entry) => entry.isDirectory())
          .map((entry) => this.getRun(entry.name))
      );

      return runs.filter((run): run is AuditRunSnapshot => run !== null);
    } catch {
      return [];
    }
  }

  async appendEvent(runId: string, event: AuditRunEvent) {
    const eventFile = this.getEventsFile(runId);
    const current = (await this.listEvents(runId)).concat(event);
    await ensureDir(this.getRunDir(runId));
    await writeFile(eventFile, current.map((entry) => toJsonLine(entry)).join(""), "utf8");
  }

  async listEvents(runId: string): Promise<AuditRunEvent[]> {
    const eventFile = this.getEventsFile(runId);
    if (!(await fileExists(eventFile))) {
      return [];
    }

    const raw = await readFile(eventFile, "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AuditRunEvent);
  }

  async writeBundle(runId: string, bundle: Record<string, string | Buffer>) {
    const runDir = this.getRunDir(runId);
    for (const [relativePath, content] of Object.entries(bundle)) {
      const destination = path.join(runDir, "bundle", relativePath);
      await ensureDir(path.dirname(destination));
      if (typeof content === "string") {
        await writeFile(destination, content, "utf8");
      } else {
        await writeFile(destination, content);
      }
    }
  }
}
