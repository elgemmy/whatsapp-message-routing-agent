import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildDatasetIndex, loadDataset } from "../src/data.js";

const testFile = fileURLToPath(import.meta.url);
export const codeRoot = path.resolve(path.dirname(testFile), "../..");
export const repoRoot = path.resolve(codeRoot, "..");
export const datasetRoot = path.join(repoRoot, "dataset");
export const indexPromise = loadDataset(datasetRoot).then(buildDatasetIndex);
