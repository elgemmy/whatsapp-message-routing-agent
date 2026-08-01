#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildDatasetIndex, fingerprintDataset, loadDataset } from "./data.js";
import { createSeedSampleEvaluation } from "./evaluate.js";
import { createSeedFailureRun, rebuildRunHistory } from "./run-history.js";

const sourceFile = fileURLToPath(import.meta.url);
const codeRoot = path.resolve(path.dirname(sourceFile), "../..");
const repoRoot = path.resolve(codeRoot, "..");

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function paths(): { datasetRoot: string; runsDir: string; evalRunsDir: string } {
  return {
    datasetRoot: path.resolve(option("--dataset") ?? path.join(repoRoot, "dataset")),
    runsDir: path.resolve(option("--runs") ?? path.join(codeRoot, "runs")),
    evalRunsDir: path.resolve(
      option("--eval-runs") ?? path.join(codeRoot, "eval-runs"),
    ),
  };
}

async function validateData(): Promise<void> {
  const { datasetRoot } = paths();
  const index = await buildDatasetIndex(await loadDataset(datasetRoot));
  const mismatches = [...index.mediaById.values()].filter(
    (inspection) => inspection.extensionMismatch,
  );
  const missingBusinessRelationships = index.dataset.messages.filter(
    (message) =>
      message.conversation_type === "business" &&
      !index.userBusinessByUserBusiness.has(
        `${message.user_id}\0${message.business_id as string}`,
      ),
  ).length;
  console.log(
    JSON.stringify(
      {
        status: "valid",
        datasetRoot,
        messages: index.dataset.messages.length,
        samples: index.dataset.samples.length,
        history: index.dataset.history.length,
        media: index.mediaById.size,
        mediaExtensionMismatches: mismatches.length,
        missingBusinessRelationships,
      },
      null,
      2,
    ),
  );
}

async function seed(): Promise<void> {
  const { datasetRoot, runsDir } = paths();
  const index = await buildDatasetIndex(await loadDataset(datasetRoot));
  const summary = await createSeedFailureRun({
    index,
    runsDir,
    repoRoot,
    runId: option("--run-id") ?? "seed-no-judgement",
    recoverLock: hasFlag("--recover-lock"),
    retryFailures: hasFlag("--retry-failures"),
  });
  console.log(
    JSON.stringify(
      {
        runId: summary.runId,
        status: summary.status,
        succeeded: summary.succeeded,
        failed: summary.failed,
        pending: summary.pending,
        dashboard: path.join(runsDir, "index.html"),
        report: path.join(runsDir, summary.runId, "report.md"),
      },
      null,
      2,
    ),
  );
}

async function seedSampleEvaluation(): Promise<void> {
  const { datasetRoot, evalRunsDir } = paths();
  const dataset = await loadDataset(datasetRoot);
  const evaluation = await createSeedSampleEvaluation({
    samples: dataset.samples,
    evalRunsDir,
    runId: option("--run-id") ?? "seed-all-wrong",
    datasetFingerprint: await fingerprintDataset(dataset),
  });
  console.log(
    JSON.stringify(
      {
        runId: option("--run-id") ?? "seed-all-wrong",
        label: evaluation.label,
        total: evaluation.total,
        actionCorrect: evaluation.actionCorrect,
        messageTypeCorrect: evaluation.messageTypeCorrect,
        exactCorrect: evaluation.exactCorrect,
        dashboard: path.join(evalRunsDir, "index.html"),
      },
      null,
      2,
    ),
  );
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "validate-data") {
    await validateData();
    return;
  }
  if (command === "seed") {
    await seed();
    return;
  }
  if (command === "eval-sample-seed") {
    await seedSampleEvaluation();
    return;
  }
  if (command === "rebuild-runs") {
    const summaries = await rebuildRunHistory(paths().runsDir);
    console.log(`Rebuilt ${summaries.length} run(s).`);
    return;
  }
  throw new Error(
    "Usage: cli.js <validate-data|seed|eval-sample-seed|rebuild-runs> [--dataset PATH] [--runs PATH] [--eval-runs PATH] [--run-id ID] [--recover-lock] [--retry-failures]",
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
