#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parsePredictionCsv, validatePredictionSet } from "./contract.js";
import { buildDatasetIndex, fingerprintDataset, loadDataset } from "./data.js";
import {
  createSeedSampleEvaluation,
  writeSampleRunEvaluation,
  writeSampleRunProgress,
} from "./evaluate.js";
import { decisionToPrediction } from "./domain.js";
import {
  createOpenRouterRoutingProvider,
  type ReasoningEffort,
} from "./providers/openrouter.js";
import { createOpenRouterTranscriptionProvider } from "./providers/openrouter-transcription.js";
import {
  createOrResumeRun,
  createSeedFailureRun,
  readRunEvents,
  readSuccessfulRunPredictions,
  rebuildRunHistory,
  writeSuccessfulRunOutput,
} from "./run-history.js";

const sourceFile = fileURLToPath(import.meta.url);
const codeRoot = path.resolve(path.dirname(sourceFile), "../..");
const repoRoot = path.resolve(codeRoot, "..");

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function options(name: string): string[] {
  return process.argv.flatMap((value, index) => {
    if (value !== name) return [];
    const next = process.argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new Error(`${name} requires a value`);
    }
    return [next];
  });
}

function requiredOption(name: string, environmentName?: string): string {
  const value = option(name) ?? (environmentName ? process.env[environmentName] : undefined);
  if (!value?.trim()) {
    throw new Error(
      `${name} is required${environmentName ? ` (or set ${environmentName})` : ""}`,
    );
  }
  return value.trim();
}

function requiredRunId(): string {
  const runId = requiredOption("--run-id");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)) {
    throw new Error(`Unsafe run ID: ${runId}`);
  }
  return runId;
}

function positiveIntegerOption(name: string): number | undefined {
  const value = option(name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function reasoningEffortOption(): ReasoningEffort {
  const value = option("--reasoning-effort") ?? "max";
  if (
    value !== "max" &&
    value !== "xhigh" &&
    value !== "high" &&
    value !== "medium" &&
    value !== "low" &&
    value !== "minimal" &&
    value !== "none"
  ) {
    throw new Error("--reasoning-effort must be max, xhigh, high, medium, low, minimal, or none");
  }
  return value;
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

async function validateOutput(): Promise<void> {
  const { datasetRoot } = paths();
  const inputPath = path.resolve(option("--input") ?? path.join(datasetRoot, "output.csv"));
  const index = await buildDatasetIndex(await loadDataset(datasetRoot));
  const rows = validatePredictionSet(index, await parsePredictionCsv(inputPath));
  console.log(
    JSON.stringify(
      { status: "valid", inputPath, predictions: rows.length },
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

async function route(partition: "targets" | "samples"): Promise<void> {
  if (!process.env.OPENROUTER_API_KEY?.trim()) {
    throw new Error("OPENROUTER_API_KEY is required; set it in the environment or code/.env");
  }
  const modelId = requiredOption("--model", "OPENROUTER_MODEL");
  const transcriptionModelId =
    option("--transcription-model") ??
    process.env.OPENROUTER_TRANSCRIPTION_MODEL?.trim() ??
    "x-ai/grok-stt-1.0";
  const runId = requiredRunId();
  const { datasetRoot, runsDir, evalRunsDir } = paths();
  const index = await buildDatasetIndex(await loadDataset(datasetRoot));
  const messages =
    partition === "targets" ? index.dataset.messages : index.dataset.samples;
  const selectedRunsDir =
    partition === "targets" ? runsDir : path.join(evalRunsDir, "live");
  const timeoutMs = positiveIntegerOption("--timeout-ms");
  const limit = positiveIntegerOption("--limit");
  const messageIds = options("--message-id");
  const provider = createOpenRouterRoutingProvider({
    modelId,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    reasoningEffort: reasoningEffortOption(),
  });
  const transcriber = createOpenRouterTranscriptionProvider({
    modelId: transcriptionModelId,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
  const summary = await createOrResumeRun({
    index,
    messages,
    runsDir: selectedRunsDir,
    repoRoot,
    runId,
    partition,
    provider,
    transcriber,
    notes:
      partition === "targets"
        ? "OpenRouter structured-routing target run."
        : "OpenRouter structured-routing illustrative sample run; labels are evaluated only after inference.",
    recoverLock: hasFlag("--recover-lock"),
    retryFailures: hasFlag("--retry-failures"),
    ...(messageIds.length > 0 ? { messageIds } : {}),
    ...(limit !== undefined ? { limit } : {}),
  });

  let outputPath: string | null = null;
  let evaluation: Awaited<ReturnType<typeof writeSampleRunEvaluation>> | null = null;
  let progress: Awaited<ReturnType<typeof writeSampleRunProgress>> | null = null;
  const runDir = path.join(selectedRunsDir, runId);
  if (partition === "samples") {
    const latestCases = new Map<
      string,
      Extract<Awaited<ReturnType<typeof readRunEvents>>[number], {
        type: "case_failed" | "case_succeeded";
      }>
    >();
    for (const event of await readRunEvents(path.join(runDir, "events.jsonl"))) {
      if (event.type === "case_failed" || event.type === "case_succeeded") {
        latestCases.set(event.messageId, event);
      }
    }
    progress = await writeSampleRunProgress({
      samples: index.dataset.samples,
      outcomes: [...latestCases.values()].map((event) =>
        event.type === "case_succeeded"
          ? {
              status: "succeeded" as const,
              prediction: decisionToPrediction(event.messageId, event.decision),
            }
          : {
              status: "failed" as const,
              messageId: event.messageId,
              attempt: event.attempt,
              error: event.error,
            },
      ),
      runDir,
    });
  }
  if (summary.status === "succeeded") {
    if (partition === "targets") {
      outputPath = path.join(runDir, "output.csv");
      await writeSuccessfulRunOutput({ index, runDir, outputPath });
    } else {
      const predictions = await readSuccessfulRunPredictions({
        index,
        runDir,
        messages,
      });
      evaluation = await writeSampleRunEvaluation({
        samples: index.dataset.samples,
        predictions,
        runDir,
      });
    }
  }

  console.log(
    JSON.stringify(
      {
        runId,
        partition,
        provider: summary.provider,
        model: summary.model,
        promptVersion: summary.promptVersion,
        routingSettings: summary.routingSettings,
        transcription: summary.transcription,
        status: summary.status,
        succeeded: summary.succeeded,
        failed: summary.failed,
        pending: summary.pending,
        outputPath,
        evaluation: evaluation
          ? {
              total: evaluation.total,
              actionCorrect: evaluation.actionCorrect,
              messageTypeCorrect: evaluation.messageTypeCorrect,
              exactCorrect: evaluation.exactCorrect,
            }
          : null,
        progress: progress
          ? {
              attempted: progress.attempted,
              technicalSucceeded: progress.technicalSucceeded,
              technicalFailed: progress.technicalFailed,
              actionCorrect: progress.evaluation.actionCorrect,
              messageTypeCorrect: progress.evaluation.messageTypeCorrect,
              exactCorrect: progress.evaluation.exactCorrect,
              report: path.join(runDir, "sample-progress.md"),
            }
          : null,
        dashboard: path.join(selectedRunsDir, "index.html"),
        report: path.join(runDir, "report.md"),
      },
      null,
      2,
    ),
  );
}

async function emitOutput(): Promise<void> {
  const runId = requiredRunId();
  const outputPath = path.resolve(requiredOption("--output"));
  const { datasetRoot, runsDir } = paths();
  const index = await buildDatasetIndex(await loadDataset(datasetRoot));
  await writeSuccessfulRunOutput({
    index,
    runDir: path.join(runsDir, runId),
    outputPath,
  });
  console.log(JSON.stringify({ status: "valid", runId, outputPath }, null, 2));
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "validate-data") {
    await validateData();
    return;
  }
  if (command === "validate-output") {
    await validateOutput();
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
  if (command === "route-targets") {
    await route("targets");
    return;
  }
  if (command === "route-samples") {
    await route("samples");
    return;
  }
  if (command === "emit-output") {
    await emitOutput();
    return;
  }
  if (command === "rebuild-runs") {
    const summaries = await rebuildRunHistory(paths().runsDir);
    console.log(`Rebuilt ${summaries.length} run(s).`);
    return;
  }
  throw new Error(
    "Usage: cli.js <validate-data|validate-output|seed|eval-sample-seed|route-targets|route-samples|emit-output|rebuild-runs> [--dataset PATH] [--input PATH] [--output PATH] [--runs PATH] [--eval-runs PATH] [--run-id ID] [--model ID] [--transcription-model ID] [--reasoning-effort EFFORT] [--message-id ID] [--limit N] [--timeout-ms N] [--recover-lock] [--retry-failures]",
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
