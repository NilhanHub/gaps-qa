import { spawn } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createUiElementAuditJson,
  type AuditRunSnapshot,
} from "../../../shared/src/index.js";
import { ensureDir } from "../../../runners/src/index.js";

export const uiElementAuditJsonPath = "docs/qa/artifacts/report/ui-element-audit.json";
export const uiElementWriteupsDocxPath = "docs/qa/UI_Element_Writeups.docx";

function runPythonDocxGenerator(inputPath: string, outputPath: string) {
  const scriptPath = fileURLToPath(
    new URL("../../../scripts/generate_ui_element_writeups.py", import.meta.url),
  );

  return new Promise<void>((resolve, reject) => {
    const child = spawn("python", [scriptPath, inputPath, outputPath], {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(stderr.trim() || `Docx generation failed with exit code ${code}.`));
    });
  });
}

export async function createSupplementalReportArtifacts(
  run: AuditRunSnapshot,
  runDir: string,
): Promise<Record<string, string | Buffer>> {
  const jsonPayload = createUiElementAuditJson(run);
  const bundle: Record<string, string | Buffer> = {
    [uiElementAuditJsonPath]: jsonPayload,
  };

  if (run.uiElementReviews.length === 0) {
    return bundle;
  }

  const tempDir = path.join(runDir, "tmp", "docs");
  const tempJsonPath = path.join(tempDir, "ui-element-audit.json");
  const tempDocxPath = path.join(tempDir, "UI_Element_Writeups.docx");

  await ensureDir(tempDir);
  await writeFile(tempJsonPath, jsonPayload, "utf8");

  try {
    await runPythonDocxGenerator(tempJsonPath, tempDocxPath);
    bundle[uiElementWriteupsDocxPath] = await readFile(tempDocxPath);
    return bundle;
  } finally {
    await rm(tempJsonPath, { force: true }).catch(() => {});
    await rm(tempDocxPath, { force: true }).catch(() => {});
  }
}
