import path from "node:path";

import {
  GeminiSemanticRunner,
  PlaywrightCdpRunner,
  WindowsLocalRunner,
} from "../../runners/src/index.js";
import { createNodeServer } from "./http/create-node-server.js";
import { FileRunRepository } from "./persistence/file-run-repository.js";
import { AuditService } from "./services/audit-service.js";

const port = Number(process.env.PORT ?? 3000);
const publicBasePath = process.env.PUBLIC_BASE_PATH ?? "/bundles";
const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? undefined;
const dataRoot = process.env.DATA_ROOT
  ? path.resolve(process.env.DATA_ROOT)
  : path.resolve(process.cwd(), ".data");

const repository = new FileRunRepository(dataRoot);
const service = new AuditService({
  appName: "GAPS QA",
  repository,
  runners: [
    new PlaywrightCdpRunner(),
    new WindowsLocalRunner(),
    new GeminiSemanticRunner(),
  ],
  publicBasePath,
});

const server = createNodeServer({
  service,
  publicBasePath,
  publicBaseUrl,
});

server.listen(port, () => {
  console.log(`GAPS QA server listening on http://127.0.0.1:${port}`);
});
