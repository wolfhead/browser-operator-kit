import path from "node:path";
import { OperationCatalog } from "./operation-catalog.js";
import { findProjectRoot } from "./project-root.js";
import { startOperatorServer } from "./operator-server.js";

const projectRoot = await findProjectRoot();
const directories = String(process.env.WEB_AUTOMATION_OPERATION_DIRS || "")
  .split(path.delimiter)
  .map((value) => value.trim())
  .filter(Boolean);
const allowedOpenUrls = JSON.parse(process.env.WEB_AUTOMATION_ALLOWED_OPEN_URLS || "[]");

await startOperatorServer({
  projectRoot,
  catalog: directories.length > 0
    ? new OperationCatalog({ directories })
    : new OperationCatalog({ projectRoot }),
  allowedOpenUrls
});
