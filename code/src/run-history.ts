import { execFileSync } from "node:child_process";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  buildContext,
  fingerprintDataset,
  type DatasetIndex,
  type Message,
} from "./data.js";
import {
  decisionToPrediction,
  DecisionSchema,
  normalizeRawDecision,
  type Decision,
  type PredictionRow,
} from "./domain.js";
import { writeValidatedOutput } from "./contract.js";
import type {
  RoutingCallMetadata,
  RoutingProvider,
  TranscriptionProvider,
} from "./routing.js";

const ModalitySchema = z.enum(["text", "image", "voice"]);
type Modality = z.infer<typeof ModalitySchema>;

const RunManifestV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string().min(1),
    createdAt: z.string().datetime({ offset: true }),
    gitSha: z.string(),
    gitDirty: z.boolean(),
    datasetFingerprint: z.string().length(64),
    targetCount: z.number().int().nonnegative(),
    modalityCounts: z.record(ModalitySchema, z.number().int().nonnegative()),
    targets: z.array(
      z
        .object({ messageId: z.string().min(1), modality: ModalitySchema })
        .strict(),
    ),
    provider: z.string(),
    model: z.string(),
    baselineRunId: z.string().nullable(),
    notes: z.string(),
  })
  .strict();

const RunManifestV2Schema = RunManifestV1Schema.omit({ schemaVersion: true }).extend({
  schemaVersion: z.literal(2),
  promptVersion: z.string().min(1),
  partition: z.enum(["targets", "samples"]),
}).strict();

const RoutingSettingsSchema = z
  .object({
    reasoningEffort: z.string().nullable(),
    maxOutputTokens: z.number().int().positive(),
    temperature: z.number().finite().nullable(),
  })
  .strict();

const TranscriptionSettingsSchema = z
  .object({ provider: z.string().min(1), model: z.string().min(1) })
  .strict();

const RunManifestV3Schema = RunManifestV2Schema.omit({ schemaVersion: true })
  .extend({
    schemaVersion: z.literal(3),
    routingSettings: RoutingSettingsSchema,
    transcription: TranscriptionSettingsSchema.nullable(),
  })
  .strict();

const StoredRunManifestSchema = z.union([
  RunManifestV1Schema,
  RunManifestV2Schema,
  RunManifestV3Schema,
]);
export type RunManifest = z.infer<typeof RunManifestV3Schema>;

const CallMetadataSchema = z
  .object({
    responseId: z.string().optional(),
    finishReason: z.string().optional(),
    rawFinishReason: z.string().optional(),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
    costUsd: z.number().nonnegative().optional(),
    routedProvider: z.string().optional(),
    warnings: z.array(z.string()).optional(),
  })
  .strict();

const TranscriptionMetadataSchema = z
  .object({
    responseId: z.string().optional(),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
    costUsd: z.number().nonnegative().optional(),
    durationSeconds: z.number().nonnegative().optional(),
  })
  .strict();

const RunStartedEventSchema = z
  .object({
    type: z.literal("run_started"),
    sequence: z.number().int().positive(),
    timestamp: z.string().datetime({ offset: true }),
  })
  .strict();
const RunResumedEventSchema = z
  .object({
    type: z.literal("run_resumed"),
    sequence: z.number().int().positive(),
    timestamp: z.string().datetime({ offset: true }),
    retryFailures: z.boolean(),
  })
  .strict();
const CaseTranscribedEventSchema = z
  .object({
    type: z.literal("case_transcribed"),
    sequence: z.number().int().positive(),
    timestamp: z.string().datetime({ offset: true }),
    messageId: z.string().min(1),
    mediaId: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    durationMs: z.number().int().nonnegative(),
    transcript: z.string().trim().min(1),
    audioSha256: z.string().length(64),
    detectedFormat: z.string().min(1),
    transcriptionFormat: z.string().min(1),
    metadata: TranscriptionMetadataSchema.optional(),
  })
  .strict();
const CaseFailedEventSchema = z
  .object({
    type: z.literal("case_failed"),
    sequence: z.number().int().positive(),
    timestamp: z.string().datetime({ offset: true }),
    messageId: z.string().min(1),
    modality: ModalitySchema,
    attempt: z.number().int().positive(),
    stage: z.enum(["transcription", "routing"]).optional(),
    retryable: z.boolean(),
    stopsRun: z.boolean().optional(),
    error: z
      .object({ code: z.string().min(1), message: z.string().min(1) })
      .strict(),
    metadata: CallMetadataSchema.optional(),
  })
  .strict();
// Older immutable routing-v2 journals allowed reasons up to 400 characters.
// New provider/output paths enforce 200, but history rebuilding must remain
// backward-compatible with those already-paid artifacts.
const StoredDecisionSchema = DecisionSchema.extend({
  reason: z.string().trim().min(1).max(400),
});
const CaseSucceededEventSchema = z
  .object({
    type: z.literal("case_succeeded"),
    sequence: z.number().int().positive(),
    timestamp: z.string().datetime({ offset: true }),
    messageId: z.string().min(1),
    modality: ModalitySchema,
    attempt: z.number().int().positive(),
    durationMs: z.number().int().nonnegative(),
    decision: StoredDecisionSchema,
    rawMessageType: z.string(),
    usedUnknownFallback: z.boolean(),
    metadata: CallMetadataSchema.optional(),
  })
  .strict();
const RunCompletedEventSchema = z
  .object({
    type: z.literal("run_completed"),
    sequence: z.number().int().positive(),
    timestamp: z.string().datetime({ offset: true }),
    status: z.enum(["succeeded", "failed"]),
  })
  .strict();

export const RunEventSchema = z.discriminatedUnion("type", [
  RunStartedEventSchema,
  RunResumedEventSchema,
  CaseTranscribedEventSchema,
  CaseFailedEventSchema,
  CaseSucceededEventSchema,
  RunCompletedEventSchema,
]);
export type RunEvent = z.infer<typeof RunEventSchema>;
type CaseEvent = Extract<RunEvent, { type: "case_failed" | "case_succeeded" }>;
type TranscriptionEvent = Extract<RunEvent, { type: "case_transcribed" }>;

export type RunSummary = {
  runId: string;
  createdAt: string;
  status: "succeeded" | "failed" | "in_progress";
  gitSha: string;
  gitDirty: boolean;
  datasetFingerprint: string;
  provider: string;
  model: string;
  promptVersion: string;
  routingSettings: z.infer<typeof RoutingSettingsSchema>;
  transcription: z.infer<typeof TranscriptionSettingsSchema> | null;
  partition: "targets" | "samples";
  baselineRunId: string | null;
  notes: string;
  total: number;
  succeeded: number;
  failed: number;
  pending: number;
  byModality: Record<Modality, { total: number; succeeded: number; failed: number }>;
  actions: Record<string, number>;
  messageTypes: Record<string, number>;
  failureCodes: Record<string, number>;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUsd: number;
    routing: {
      attempts: number;
      reportedUsageAttempts: number;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      costUsd: number;
    };
    transcription: {
      attempts: number;
      reportedUsageAttempts: number;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      costUsd: number;
      durationSeconds: number;
    };
  };
  comparison: null | {
    baselineRunId: string;
    compared: number;
    changed: number;
    recovered: number;
    newTechnicalFailures: number;
    stillFailing: number;
  };
  comparisonUnavailableReason: string | null;
};

function now(): string {
  return new Date().toISOString();
}

function safeRunId(runId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)) {
    throw new Error(`Unsafe run ID: ${runId}`);
  }
  return runId;
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const handle = await open(temporary, "w");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, filePath);
}

async function appendEvent(filePath: string, event: RunEvent): Promise<void> {
  const handle = await open(filePath, "a");
  try {
    await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function readRunEvents(filePath: string): Promise<RunEvent[]> {
  let input: string;
  try {
    input = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const lines = input.split("\n");
  const events: RunEvent[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    try {
      events.push(RunEventSchema.parse(JSON.parse(line)));
    } catch (error) {
      const isTruncatedFinalLine = index === lines.length - 1 && !input.endsWith("\n");
      if (isTruncatedFinalLine) break;
      throw new Error(`Invalid event line ${index + 1} in ${filePath}`, { cause: error });
    }
  }
  return events;
}

export async function repairTruncatedRunJournal(filePath: string): Promise<boolean> {
  let input: Buffer;
  try {
    input = await readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (input.length === 0 || input[input.length - 1] === 0x0a) return false;
  const lastNewline = input.lastIndexOf(0x0a);
  const handle = await open(filePath, "r+");
  try {
    await handle.truncate(lastNewline + 1);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return true;
}

function foldCases(events: readonly RunEvent[]): Map<string, CaseEvent> {
  const cases = new Map<string, CaseEvent>();
  for (const event of events) {
    if (event.type === "case_failed" || event.type === "case_succeeded") {
      cases.set(event.messageId, event);
    }
  }
  return cases;
}

function foldTranscriptions(
  events: readonly RunEvent[],
): Map<string, TranscriptionEvent> {
  const transcriptions = new Map<string, TranscriptionEvent>();
  for (const event of events) {
    if (event.type === "case_transcribed") {
      transcriptions.set(event.messageId, event);
    }
  }
  return transcriptions;
}

async function readManifest(runDir: string): Promise<RunManifest> {
  const stored = StoredRunManifestSchema.parse(
    JSON.parse(await readFile(path.join(runDir, "manifest.json"), "utf8")),
  );
  if (stored.schemaVersion === 3) return stored;
  const v2 =
    stored.schemaVersion === 2
      ? stored
      : {
          ...stored,
          schemaVersion: 2 as const,
          promptVersion: "no-judgement-v1",
          partition: "targets" as const,
        };
  return {
    ...v2,
    schemaVersion: 3,
    routingSettings: {
      reasoningEffort: null,
      maxOutputTokens: 300,
      temperature: null,
    },
    transcription: null,
  };
}

async function runDirectories(runsDir: string): Promise<string[]> {
  await mkdir(runsDir, { recursive: true });
  const entries = await readdir(runsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(runsDir, entry.name));
}

async function latestRunId(runsDir: string): Promise<string | null> {
  const manifests: RunManifest[] = [];
  for (const runDir of await runDirectories(runsDir)) {
    try {
      manifests.push(await readManifest(runDir));
    } catch {
      // Ignore incomplete directories; the dashboard will not present them as runs.
    }
  }
  manifests.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return manifests[0]?.runId ?? null;
}

function gitMetadata(repoRoot: string): { sha: string; dirty: boolean } {
  const gitOutput = (args: string[]): string => {
    try {
      return execFileSync("git", args, {
        cwd: repoRoot,
        encoding: "utf8",
      });
    } catch (error) {
      // Some agent sandboxes report EPERM after a successful child process.
      // Preserve its captured stdout when the command itself exited cleanly.
      const result = error as Error & { status?: number | null; stdout?: string };
      if (result.status === 0 && typeof result.stdout === "string") {
        return result.stdout;
      }
      throw error;
    }
  };
  try {
    const sha = gitOutput(["rev-parse", "HEAD"]).trim();
    const status = gitOutput(["status", "--porcelain"]);
    return { sha, dirty: status.trim().length > 0 };
  } catch {
    return { sha: "unknown", dirty: true };
  }
}

function modalityFor(mediaType: "image" | "voice" | null): Modality {
  return mediaType ?? "text";
}

async function acquireLock(runDir: string, recoverLock: boolean): Promise<() => Promise<void>> {
  const lockPath = path.join(runDir, ".lock");
  if (recoverLock) {
    await unlink(lockPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  let handle;
  try {
    handle = await open(lockPath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Run is locked: ${runDir}. Use --recover-lock only after confirming no writer is active.`);
    }
    throw error;
  }
  await handle.writeFile(`${process.pid}\n`, "utf8");
  await handle.sync();
  return async () => {
    await handle.close();
    await unlink(lockPath);
  };
}

export async function createOrResumeRun(args: {
  index: DatasetIndex;
  messages: readonly Message[];
  runsDir: string;
  repoRoot: string;
  runId: string;
  partition: "targets" | "samples";
  provider: RoutingProvider;
  transcriber?: TranscriptionProvider;
  notes: string;
  recoverLock?: boolean;
  retryFailures?: boolean;
  messageIds?: readonly string[];
  limit?: number;
}): Promise<RunSummary> {
  const runId = safeRunId(args.runId);
  const runsDir = path.resolve(args.runsDir);
  const runDir = path.join(runsDir, runId);
  if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1)) {
    throw new Error("Run limit must be a positive integer");
  }
  const messageById = new Map(args.messages.map((message) => [message.message_id, message]));
  if (messageById.size !== args.messages.length) {
    throw new Error("Run messages contain duplicate IDs");
  }
  const selectedIds = args.messageIds ? new Set(args.messageIds) : null;
  for (const messageId of selectedIds ?? []) {
    if (!messageById.has(messageId)) throw new Error(`Unknown selected message: ${messageId}`);
  }
  await mkdir(runDir, { recursive: true });
  const releaseLock = await acquireLock(runDir, args.recoverLock ?? false);

  try {
    const manifestPath = path.join(runDir, "manifest.json");
    const fingerprint = await fingerprintDataset(args.index.dataset);
    let manifest: RunManifest;
    try {
      manifest = await readManifest(runDir);
      if (manifest.datasetFingerprint !== fingerprint) {
        throw new Error(`Cannot resume ${runId}: dataset fingerprint changed`);
      }
      if (
        manifest.provider !== args.provider.provider ||
        manifest.model !== args.provider.model ||
        manifest.promptVersion !== args.provider.promptVersion ||
        manifest.partition !== args.partition ||
        JSON.stringify(manifest.routingSettings) !==
          JSON.stringify(args.provider.settings) ||
        JSON.stringify(manifest.transcription) !==
          JSON.stringify(
            args.transcriber
              ? {
                  provider: args.transcriber.provider,
                  model: args.transcriber.model,
                }
              : null,
          )
      ) {
        throw new Error(`Cannot resume ${runId}: provider configuration changed`);
      }
      const expectedTargets = args.messages.map((message) => ({
        messageId: message.message_id,
        modality: modalityFor(message.media_type),
      }));
      if (JSON.stringify(manifest.targets) !== JSON.stringify(expectedTargets)) {
        throw new Error(`Cannot resume ${runId}: target partition changed`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        const missingManifest = await readFile(manifestPath, "utf8").then(
          () => false,
          (readError: NodeJS.ErrnoException) => readError.code === "ENOENT",
        );
        if (!missingManifest) throw error;
      }
      const git = gitMetadata(args.repoRoot);
      const baselineRunId = await latestRunId(runsDir);
      const modalityCounts = { text: 0, image: 0, voice: 0 };
      for (const message of args.messages) {
        modalityCounts[modalityFor(message.media_type)] += 1;
      }
      manifest = RunManifestV3Schema.parse({
        schemaVersion: 3,
        runId,
        createdAt: now(),
        gitSha: git.sha,
        gitDirty: git.dirty,
        datasetFingerprint: fingerprint,
        targetCount: args.messages.length,
        modalityCounts,
        targets: args.messages.map((message) => ({
          messageId: message.message_id,
          modality: modalityFor(message.media_type),
        })),
        provider: args.provider.provider,
        model: args.provider.model,
        promptVersion: args.provider.promptVersion,
        routingSettings: args.provider.settings,
        transcription: args.transcriber
          ? {
              provider: args.transcriber.provider,
              model: args.transcriber.model,
            }
          : null,
        partition: args.partition,
        baselineRunId,
        notes: args.notes,
      });
      await atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    }

    const eventsPath = path.join(runDir, "events.jsonl");
    await repairTruncatedRunJournal(eventsPath);
    const events = await readRunEvents(eventsPath);
    let sequence = Math.max(0, ...events.map((event) => event.sequence));
    if (!events.some((event) => event.type === "run_started")) {
      await appendEvent(eventsPath, {
        type: "run_started",
        sequence: (sequence += 1),
        timestamp: now(),
      });
    }

    const eventsAfterStart = await readRunEvents(eventsPath);
    const wasCompleted = eventsAfterStart.at(-1)?.type === "run_completed";
    const lastEvent = eventsAfterStart.at(-1);
    if (lastEvent?.type === "case_failed" && lastEvent.stopsRun) {
      if (!lastEvent.retryable) {
        throw new Error(
          `Run ${runId} stopped after nonretryable ${lastEvent.error.code}; create a new run`,
        );
      }
      if (!args.retryFailures) {
        throw new Error(
          `Run ${runId} paused after ${lastEvent.error.code}; fix the cause and use --retry-failures`,
        );
      }
    }
    if (wasCompleted && args.retryFailures) {
      await appendEvent(eventsPath, {
        type: "run_resumed",
        sequence: (sequence += 1),
        timestamp: now(),
        retryFailures: true,
      });
    }

    const persistedEvents = await readRunEvents(eventsPath);
    const completedCases = foldCases(persistedEvents);
    const completedTranscriptions = foldTranscriptions(persistedEvents);
    let processed = 0;
    for (const message of args.messages) {
      if (selectedIds && !selectedIds.has(message.message_id)) continue;
      const previous = completedCases.get(message.message_id);
      if (previous?.type === "case_succeeded") continue;
      if (previous?.type === "case_failed") {
        if (!args.retryFailures || !previous.retryable) continue;
      }
      if (args.limit !== undefined && processed >= args.limit) break;
      processed += 1;
      const context = buildContext(args.index, message);
      const startedAt = performance.now();
      let voiceTranscript: string | undefined;
      if (message.media_type === "voice" && args.transcriber) {
        const persisted = completedTranscriptions.get(message.message_id);
        if (persisted) {
          voiceTranscript = persisted.transcript;
        } else {
          const transcriptionStartedAt = performance.now();
          try {
            if (!context.media) {
              throw new Error("Voice message has no indexed media.");
            }
            const transcription = await args.transcriber.transcribe(
              context.media,
              args.index.dataset.root,
            );
            const event: TranscriptionEvent = {
              type: "case_transcribed",
              sequence: (sequence += 1),
              timestamp: now(),
              messageId: message.message_id,
              mediaId: context.media.mediaId,
              provider: args.transcriber.provider,
              model: args.transcriber.model,
              durationMs: Math.max(
                0,
                Math.round(performance.now() - transcriptionStartedAt),
              ),
              transcript: transcription.transcript,
              audioSha256: transcription.audioSha256,
              detectedFormat: transcription.detectedFormat,
              transcriptionFormat: transcription.transcriptionFormat,
              ...(transcription.metadata
                ? { metadata: transcription.metadata }
                : {}),
            };
            await appendEvent(eventsPath, event);
            completedTranscriptions.set(message.message_id, event);
            voiceTranscript = event.transcript;
          } catch (error) {
            const failure = args.transcriber.classifyError(error);
            await appendEvent(eventsPath, {
              type: "case_failed",
              sequence: (sequence += 1),
              timestamp: now(),
              messageId: message.message_id,
              modality: "voice",
              attempt: (previous?.attempt ?? 0) + 1,
              stage: "transcription",
              retryable: failure.retryable,
              ...(failure.stopRun ? { stopsRun: true } : {}),
              error: { code: failure.code, message: failure.message },
            });
            if (failure.stopRun) break;
            continue;
          }
        }
      }
      try {
        const result = await args.provider.judge(
          context,
          args.index.dataset.root,
          voiceTranscript,
        );
        let normalized: ReturnType<typeof normalizeRawDecision>;
        try {
          normalized = normalizeRawDecision(result.rawDecision);
          args.provider.validateDecision(context, normalized.decision);
        } catch {
          throw {
            routingValidationFailure: true,
            metadata: result.metadata,
          };
        }
        await appendEvent(eventsPath, {
          type: "case_succeeded",
          sequence: (sequence += 1),
          timestamp: now(),
          messageId: message.message_id,
          modality: modalityFor(message.media_type),
          attempt: (previous?.attempt ?? 0) + 1,
          durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
          decision: normalized.decision,
          rawMessageType: normalized.rawMessageType,
          usedUnknownFallback: normalized.usedUnknownFallback,
          ...(result.metadata ? { metadata: result.metadata } : {}),
        });
      } catch (error) {
        const failure =
          typeof error === "object" &&
          error !== null &&
          "routingValidationFailure" in error
            ? {
                code: "invalid_decision",
                message: "The model returned a decision that failed local validation.",
                retryable: true,
              }
            : args.provider.classifyError(error);
        const metadata =
          typeof error === "object" && error !== null
            ? "routingValidationFailure" in error && "metadata" in error
              ? (error.metadata as RoutingCallMetadata | undefined)
              : "routingMetadata" in error
                ? (error.routingMetadata as RoutingCallMetadata | undefined)
                : undefined
            : undefined;
        await appendEvent(eventsPath, {
          type: "case_failed",
          sequence: (sequence += 1),
          timestamp: now(),
          messageId: message.message_id,
          modality: modalityFor(message.media_type),
          attempt: (previous?.attempt ?? 0) + 1,
          stage: "routing",
          retryable: failure.retryable,
          ...(failure.stopRun ? { stopsRun: true } : {}),
          error: { code: failure.code, message: failure.message },
          ...(metadata ? { metadata } : {}),
        });
        if (failure.stopRun) break;
      }
    }

    const currentCases = foldCases(await readRunEvents(eventsPath));
    if (currentCases.size === args.messages.length && (!wasCompleted || args.retryFailures)) {
      const hasFailures = [...currentCases.values()].some(
        (event) => event.type === "case_failed",
      );
      await appendEvent(eventsPath, {
        type: "run_completed",
        sequence: (sequence += 1),
        timestamp: now(),
        status: hasFailures ? "failed" : "succeeded",
      });
    }
  } finally {
    await releaseLock();
  }

  await rebuildRunHistory(args.runsDir);
  return JSON.parse(
    await readFile(path.join(runDir, "summary.json"), "utf8"),
  ) as RunSummary;
}

export async function createSeedFailureRun(args: {
  index: DatasetIndex;
  runsDir: string;
  repoRoot: string;
  runId: string;
  recoverLock?: boolean;
  retryFailures?: boolean;
}): Promise<RunSummary> {
  const provider: RoutingProvider = {
    provider: "none",
    model: "none",
    promptVersion: "no-judgement-v1",
    settings: {
      reasoningEffort: null,
      maxOutputTokens: 300,
      temperature: null,
    },
    async judge() {
      throw new Error("No judgement provider was configured for this seeded run.");
    },
    classifyError() {
      return {
        code: "judgement_provider_unavailable",
        message: "No judgement provider was configured for this seeded run.",
        retryable: true,
      };
    },
    validateDecision() {},
  };
  return createOrResumeRun({
    ...args,
    messages: args.index.dataset.messages,
    partition: "targets",
    provider,
    notes: "Seeded harness run: no judgement provider is configured.",
  });
}

function increment(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

function compareCases(
  baselineRunId: string | null,
  current: Map<string, CaseEvent>,
  baseline: Map<string, CaseEvent> | null,
): RunSummary["comparison"] {
  if (!baselineRunId || !baseline) return null;
  let compared = 0;
  let changed = 0;
  let recovered = 0;
  let newTechnicalFailures = 0;
  let stillFailing = 0;
  for (const [messageId, currentCase] of current) {
    const previousCase = baseline.get(messageId);
    if (!previousCase) continue;
    compared += 1;
    const currentSignature = JSON.stringify(
      currentCase.type === "case_succeeded"
        ? { type: currentCase.type, decision: currentCase.decision }
        : { type: currentCase.type, errorCode: currentCase.error.code },
    );
    const previousSignature = JSON.stringify(
      previousCase.type === "case_succeeded"
        ? { type: previousCase.type, decision: previousCase.decision }
        : { type: previousCase.type, errorCode: previousCase.error.code },
    );
    changed += Number(currentSignature !== previousSignature);
    recovered += Number(
      previousCase.type === "case_failed" && currentCase.type === "case_succeeded",
    );
    newTechnicalFailures += Number(
      previousCase.type === "case_succeeded" && currentCase.type === "case_failed",
    );
    stillFailing += Number(
      previousCase.type === "case_failed" && currentCase.type === "case_failed",
    );
  }
  return {
    baselineRunId,
    compared,
    changed,
    recovered,
    newTechnicalFailures,
    stillFailing,
  };
}

function validateJournal(manifest: RunManifest, events: readonly RunEvent[]): void {
  const targets = new Map(manifest.targets.map((target) => [target.messageId, target]));
  if (targets.size !== manifest.targetCount || manifest.targets.length !== manifest.targetCount) {
    throw new Error(`${manifest.runId}: manifest target list is inconsistent`);
  }
  const counted = { text: 0, image: 0, voice: 0 };
  for (const target of manifest.targets) counted[target.modality] += 1;
  if (JSON.stringify(counted) !== JSON.stringify(manifest.modalityCounts)) {
    throw new Error(`${manifest.runId}: manifest modality counts are inconsistent`);
  }
  if (events.length === 0) return;

  let openRun = false;
  let starts = 0;
  const cases = new Map<string, CaseEvent>();
  const transcriptions = new Set<string>();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index] as RunEvent;
    if (event.sequence !== index + 1) {
      throw new Error(`${manifest.runId}: event sequence is not contiguous at ${event.sequence}`);
    }
    if (event.type === "run_started") {
      starts += 1;
      if (index !== 0 || starts !== 1) throw new Error(`${manifest.runId}: invalid run_started event`);
      openRun = true;
    } else if (event.type === "run_resumed") {
      if (openRun) throw new Error(`${manifest.runId}: run_resumed while run is open`);
      openRun = true;
    } else if (event.type === "case_transcribed") {
      if (!openRun) throw new Error(`${manifest.runId}: transcription outside an open run`);
      const target = targets.get(event.messageId);
      if (!target || target.modality !== "voice") {
        throw new Error(`${manifest.runId}: transcription for invalid ${event.messageId}`);
      }
      if (
        !manifest.transcription ||
        event.provider !== manifest.transcription.provider ||
        event.model !== manifest.transcription.model
      ) {
        throw new Error(`${manifest.runId}: transcription provider mismatch`);
      }
      if (transcriptions.has(event.messageId)) {
        throw new Error(`${manifest.runId}: duplicate transcription for ${event.messageId}`);
      }
      transcriptions.add(event.messageId);
    } else if (event.type === "case_failed" || event.type === "case_succeeded") {
      if (!openRun) throw new Error(`${manifest.runId}: case event outside an open run`);
      const target = targets.get(event.messageId);
      if (!target) throw new Error(`${manifest.runId}: event for unknown ${event.messageId}`);
      if (target.modality !== event.modality) {
        throw new Error(`${manifest.runId}: modality mismatch for ${event.messageId}`);
      }
      const previous = cases.get(event.messageId);
      if (event.attempt !== (previous?.attempt ?? 0) + 1) {
        throw new Error(`${manifest.runId}: invalid attempt for ${event.messageId}`);
      }
      cases.set(event.messageId, event);
    } else {
      if (!openRun) throw new Error(`${manifest.runId}: duplicate run_completed event`);
      if (cases.size !== manifest.targetCount) {
        throw new Error(`${manifest.runId}: completed with ${cases.size}/${manifest.targetCount} cases`);
      }
      const hasFailure = [...cases.values()].some((item) => item.type === "case_failed");
      const expectedStatus = hasFailure ? "failed" : "succeeded";
      if (event.status !== expectedStatus) {
        throw new Error(`${manifest.runId}: completion status contradicts case outcomes`);
      }
      openRun = false;
    }
  }
  if (starts !== 1) throw new Error(`${manifest.runId}: missing run_started event`);
}

async function buildSummary(
  runDir: string,
  baselineCases: Map<string, CaseEvent> | null,
  comparisonUnavailableReason: string | null,
): Promise<{ summary: RunSummary; cases: Map<string, CaseEvent> }> {
  const manifest = await readManifest(runDir);
  const events = await readRunEvents(path.join(runDir, "events.jsonl"));
  validateJournal(manifest, events);
  const cases = foldCases(events);
  const byModality: RunSummary["byModality"] = {
    text: { total: manifest.modalityCounts.text, succeeded: 0, failed: 0 },
    image: { total: manifest.modalityCounts.image, succeeded: 0, failed: 0 },
    voice: { total: manifest.modalityCounts.voice, succeeded: 0, failed: 0 },
  };
  const actions: Record<string, number> = {};
  const messageTypes: Record<string, number> = {};
  const failureCodes: Record<string, number> = {};
  const routingUsage = {
    attempts: 0,
    reportedUsageAttempts: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
  };
  const transcriptionUsage = {
    attempts: 0,
    reportedUsageAttempts: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    durationSeconds: 0,
  };
  let succeeded = 0;
  let failed = 0;
  for (const event of cases.values()) {
    if (event.type === "case_succeeded") {
      succeeded += 1;
      byModality[event.modality].succeeded += 1;
      increment(actions, event.decision.action);
      increment(messageTypes, event.decision.messageType);
    } else {
      failed += 1;
      byModality[event.modality].failed += 1;
      increment(failureCodes, event.error.code);
    }
  }
  for (const event of events) {
    if (event.type === "case_transcribed") {
      transcriptionUsage.attempts += 1;
      transcriptionUsage.reportedUsageAttempts += Number(event.metadata !== undefined);
      transcriptionUsage.inputTokens += event.metadata?.inputTokens ?? 0;
      transcriptionUsage.outputTokens += event.metadata?.outputTokens ?? 0;
      transcriptionUsage.totalTokens += event.metadata?.totalTokens ?? 0;
      transcriptionUsage.costUsd += event.metadata?.costUsd ?? 0;
      transcriptionUsage.durationSeconds += event.metadata?.durationSeconds ?? 0;
    } else if (event.type === "case_failed" && event.stage === "transcription") {
      transcriptionUsage.attempts += 1;
    } else if (event.type === "case_succeeded" || event.type === "case_failed") {
      routingUsage.attempts += 1;
      routingUsage.reportedUsageAttempts += Number(event.metadata !== undefined);
      routingUsage.inputTokens += event.metadata?.inputTokens ?? 0;
      routingUsage.outputTokens += event.metadata?.outputTokens ?? 0;
      routingUsage.totalTokens += event.metadata?.totalTokens ?? 0;
      routingUsage.costUsd += event.metadata?.costUsd ?? 0;
    }
  }
  const usage = {
    inputTokens: routingUsage.inputTokens + transcriptionUsage.inputTokens,
    outputTokens: routingUsage.outputTokens + transcriptionUsage.outputTokens,
    totalTokens: routingUsage.totalTokens + transcriptionUsage.totalTokens,
    costUsd: routingUsage.costUsd + transcriptionUsage.costUsd,
    routing: routingUsage,
    transcription: transcriptionUsage,
  };
  let completed: Extract<RunEvent, { type: "run_completed" }> | undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "run_completed") {
      completed = event;
      break;
    }
  }
  const summary: RunSummary = {
    runId: manifest.runId,
    createdAt: manifest.createdAt,
    status: completed?.status ?? "in_progress",
    gitSha: manifest.gitSha,
    gitDirty: manifest.gitDirty,
    datasetFingerprint: manifest.datasetFingerprint,
    provider: manifest.provider,
    model: manifest.model,
    promptVersion: manifest.promptVersion,
    routingSettings: manifest.routingSettings,
    transcription: manifest.transcription,
    partition: manifest.partition,
    baselineRunId: manifest.baselineRunId,
    notes: manifest.notes,
    total: manifest.targetCount,
    succeeded,
    failed,
    pending: manifest.targetCount - cases.size,
    byModality,
    actions,
    messageTypes,
    failureCodes,
    usage,
    comparison: compareCases(manifest.baselineRunId, cases, baselineCases),
    comparisonUnavailableReason,
  };
  return { summary, cases };
}

function markdownTable(rows: string[][]): string {
  if (rows.length === 0) return "";
  const header = rows[0] as string[];
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.slice(1).map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function renderReport(summary: RunSummary): string {
  const modalityRows = Object.entries(summary.byModality).map(([name, value]) => [
    name,
    String(value.total),
    String(value.succeeded),
    String(value.failed),
  ]);
  return `# Run ${summary.runId}

- Status: **${summary.status}**
- Provider/model: \`${summary.provider}\` / \`${summary.model}\`
- Prompt/partition: \`${summary.promptVersion}\` / \`${summary.partition}\`
- Routing settings: reasoning \`${summary.routingSettings.reasoningEffort ?? "provider-default"}\`, max output ${summary.routingSettings.maxOutputTokens}, temperature ${summary.routingSettings.temperature ?? "provider-default"}
- Transcription: ${summary.transcription ? `\`${summary.transcription.provider}\` / \`${summary.transcription.model}\`` : "none"}
- Git: \`${summary.gitSha}${summary.gitDirty ? " (dirty)" : ""}\`
- Dataset: \`${summary.datasetFingerprint}\`
- Baseline: ${summary.baselineRunId ? `\`${summary.baselineRunId}\`` : "none"}

${summary.notes}

## Outcome

- Total: ${summary.total}
- Succeeded: ${summary.succeeded}
- Failed: ${summary.failed}
- Pending: ${summary.pending}
- Usage: ${summary.usage.inputTokens} input / ${summary.usage.outputTokens} output tokens${summary.usage.costUsd > 0 ? ` / $${summary.usage.costUsd.toFixed(6)}` : ""}
- Routing attempts: ${summary.usage.routing.attempts} (${summary.usage.routing.reportedUsageAttempts} with reported usage); transcription attempts: ${summary.usage.transcription.attempts} (${summary.usage.transcription.reportedUsageAttempts} with reported usage)${summary.usage.transcription.durationSeconds > 0 ? ` / ${summary.usage.transcription.durationSeconds.toFixed(2)} audio seconds` : ""}

${markdownTable([["Modality", "Total", "Succeeded", "Failed"], ...modalityRows])}

## Failure codes

${Object.keys(summary.failureCodes).length === 0 ? "None." : markdownTable([["Code", "Count"], ...Object.entries(summary.failureCodes).map(([key, value]) => [key, String(value)])])}

## Previous-run comparison

${summary.comparison ? `Compared ${summary.comparison.compared} cases with \`${summary.comparison.baselineRunId}\`: ${summary.comparison.changed} changed, ${summary.comparison.recovered} technically recovered, ${summary.comparison.newTechnicalFailures} new technical failures, ${summary.comparison.stillFailing} still failing.` : summary.comparisonUnavailableReason ? `Unavailable: ${summary.comparisonUnavailableReason}.` : "No baseline is available for this run."}

${summary.partition === "samples" && summary.succeeded > 0 ? "For post-inference comparison of attempted sample labels, see `sample-progress.md` in this run directory." : "Action and message-type quality are unavailable when there are no valid judgements."} The organizer's hidden ground truth is not available locally.
`;
}

function htmlEscape(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderDashboard(
  runs: Array<{ summary: RunSummary; cases: Map<string, CaseEvent> }>,
): string {
  const sampleHistory =
    runs.length > 0 && runs.every(({ summary }) => summary.partition === "samples");
  const historyRows = runs
    .map(
      ({ summary }) => `<tr><td><a href="#${htmlEscape(summary.runId)}">${htmlEscape(summary.runId)}</a></td><td><span class="status ${summary.status}">${summary.status}</span></td><td>${htmlEscape(summary.createdAt)}</td><td>${htmlEscape(`${summary.provider}/${summary.model}`)}</td><td>${summary.succeeded}/${summary.total}</td><td>${summary.failed}</td><td><code>${htmlEscape(summary.gitSha.slice(0, 12))}${summary.gitDirty ? "*" : ""}</code></td></tr>`,
    )
    .join("\n");
  const sections = runs
    .map(({ summary, cases }) => {
      const failureRows = [...cases.values()]
        .filter((event): event is Extract<CaseEvent, { type: "case_failed" }> => event.type === "case_failed")
        .map(
          (event) => `<tr><td><code>${htmlEscape(event.messageId)}</code></td><td>${event.modality}</td><td><code>${htmlEscape(event.error.code)}</code></td><td>${htmlEscape(event.error.message)}</td><td>${event.retryable ? "yes" : "no"}</td></tr>`,
        )
        .join("\n");
      const comparison = summary.comparison
        ? `${summary.comparison.changed} changed · ${summary.comparison.recovered} technically recovered · ${summary.comparison.newTechnicalFailures} new technical failures · ${summary.comparison.stillFailing} still failing versus <code>${htmlEscape(summary.comparison.baselineRunId)}</code>`
        : summary.comparisonUnavailableReason
          ? `Comparison unavailable: ${htmlEscape(summary.comparisonUnavailableReason)}`
          : "No baseline";
      const sampleProgressLink =
        summary.partition === "samples" && summary.succeeded > 0
          ? `<p><a href="${encodeURIComponent(summary.runId)}/sample-progress.md">Review attempted sample decisions</a></p>`
          : "";
      return `<section id="${htmlEscape(summary.runId)}"><h2>${htmlEscape(summary.runId)}</h2><p>${htmlEscape(summary.notes)}</p>${sampleProgressLink}<p class="meta">Prompt <code>${htmlEscape(summary.promptVersion)}</code> · reasoning <code>${htmlEscape(summary.routingSettings.reasoningEffort ?? "provider-default")}</code> · partition <code>${htmlEscape(summary.partition)}</code>${summary.transcription ? ` · STT <code>${htmlEscape(summary.transcription.model)}</code>` : ""} · ${summary.usage.inputTokens} input / ${summary.usage.outputTokens} output tokens${summary.usage.costUsd > 0 ? ` · $${summary.usage.costUsd.toFixed(6)}` : ""}<br>${summary.usage.routing.attempts} routing attempts (${summary.usage.routing.reportedUsageAttempts} with usage) · ${summary.usage.transcription.attempts} transcription attempts (${summary.usage.transcription.reportedUsageAttempts} with usage)</p><div class="cards"><div><strong>${summary.succeeded}</strong><span>Succeeded</span></div><div><strong>${summary.failed}</strong><span>Failed</span></div><div><strong>${summary.pending}</strong><span>Pending</span></div><div><strong>${summary.total}</strong><span>Total</span></div></div><div class="bar"><i style="width:${summary.total ? (summary.succeeded / summary.total) * 100 : 0}%"></i></div><p>${comparison}</p><table><thead><tr><th>Modality</th><th>Total</th><th>Succeeded</th><th>Failed</th></tr></thead><tbody>${Object.entries(summary.byModality).map(([key, value]) => `<tr><td>${key}</td><td>${value.total}</td><td>${value.succeeded}</td><td>${value.failed}</td></tr>`).join("")}</tbody></table><details><summary>Failure details (${summary.failed})</summary><table><thead><tr><th>Message</th><th>Modality</th><th>Code</th><th>Detail</th><th>Retryable</th></tr></thead><tbody>${failureRows}</tbody></table></details><p class="meta">Dataset <code>${htmlEscape(summary.datasetFingerprint)}</code><br>Git <code>${htmlEscape(summary.gitSha)}</code>${summary.gitDirty ? " (dirty)" : ""}</p></section>`;
    })
    .join("\n");
  const intro = sampleHistory
    ? "Generated from append-only sample run events. Labels are evaluated only after inference, and successful runs keep their metrics beside the journal."
    : 'Generated from append-only target run events. Interrupted runs can resume safely; a partial submission CSV is never emitted. <a href="../eval-runs/index.html">Sample evaluation history</a>';
  const restore = sampleHistory
    ? ""
    : '<section><h2>Restore a prior run</h2><p>Only restore an <strong>all-successful</strong> run whose dataset fingerprint matches the current dataset. Revalidate its 110-row <code>output.csv</code> before copying it to the submission path. Use the recorded Git SHA to restore source separately; this dashboard never mutates code or submission files.</p></section>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Message Router Run History</title><style>:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#0b1020;color:#e8ecf8}body{max-width:1200px;margin:auto;padding:32px}h1,h2{letter-spacing:-.02em}section{background:#121a2f;border:1px solid #26314d;border-radius:14px;padding:24px;margin:24px 0;scroll-margin-top:20px}.cards{display:grid;grid-template-columns:repeat(4,minmax(120px,1fr));gap:12px}.cards div{background:#0b1020;border-radius:10px;padding:16px}.cards strong{display:block;font-size:2rem}.cards span,.meta{color:#9ba8c7}.bar{height:10px;background:#3b2030;border-radius:10px;overflow:hidden;margin:16px 0}.bar i{display:block;height:100%;background:#54d08a}table{width:100%;border-collapse:collapse;margin:16px 0;font-size:.92rem}th,td{text-align:left;padding:9px;border-bottom:1px solid #26314d;vertical-align:top}a{color:#8bb8ff}.status{padding:3px 8px;border-radius:999px;background:#293451}.status.failed{background:#5a2531}.status.succeeded{background:#1f563e}code{overflow-wrap:anywhere}@media(max-width:700px){body{padding:16px}.cards{grid-template-columns:repeat(2,1fr)}table{display:block;overflow:auto}}</style></head><body><h1>Message Router Run History</h1><p>${intro}</p><section><h2>Runs</h2><table><thead><tr><th>Run</th><th>Status</th><th>Created</th><th>Provider/model</th><th>Success</th><th>Failures</th><th>Git</th></tr></thead><tbody>${historyRows}</tbody></table></section>${restore}${sections}</body></html>`;
}

export async function rebuildRunHistory(runsDirInput: string): Promise<RunSummary[]> {
  const runsDir = path.resolve(runsDirInput);
  const directories = await runDirectories(runsDir);
  const manifests = (
    await Promise.all(
      directories.map(async (runDir) => {
        try {
          return { runDir, manifest: await readManifest(runDir) };
        } catch {
          return null;
        }
      }),
    )
  )
    .filter((item): item is { runDir: string; manifest: RunManifest } => item !== null)
    .sort((left, right) => left.manifest.createdAt.localeCompare(right.manifest.createdAt));

  const built: Array<{ summary: RunSummary; cases: Map<string, CaseEvent> }> = [];
  const casesByRun = new Map<
    string,
    { fingerprint: string; cases: Map<string, CaseEvent> }
  >();
  for (const { runDir, manifest } of manifests) {
    const baseline = manifest.baselineRunId
      ? casesByRun.get(manifest.baselineRunId)
      : undefined;
    const baselineCases =
      baseline?.fingerprint === manifest.datasetFingerprint ? baseline.cases : null;
    const comparisonUnavailableReason = !manifest.baselineRunId
      ? null
      : !baseline
        ? "baseline_run_missing"
        : baseline.fingerprint !== manifest.datasetFingerprint
          ? "baseline_dataset_fingerprint_mismatch"
          : null;
    const projection = await buildSummary(
      runDir,
      baselineCases,
      comparisonUnavailableReason,
    );
    casesByRun.set(manifest.runId, {
      fingerprint: manifest.datasetFingerprint,
      cases: projection.cases,
    });
    built.push(projection);
    await atomicWrite(
      path.join(runDir, "summary.json"),
      `${JSON.stringify(projection.summary, null, 2)}\n`,
    );
    await atomicWrite(path.join(runDir, "report.md"), renderReport(projection.summary));
  }

  const newestFirst = [...built].reverse();
  const history = markdownTable([
    ["Run", "Status", "Created", "Provider/model", "Succeeded", "Failed", "Baseline"],
    ...newestFirst.map(({ summary }) => [
      summary.runId,
      summary.status,
      summary.createdAt,
      `${summary.provider}/${summary.model}`,
      `${summary.succeeded}/${summary.total}`,
      String(summary.failed),
      summary.baselineRunId ?? "none",
    ]),
  ]);
  await atomicWrite(
    path.join(runsDir, "history.md"),
    `# Run History\n\n${history || "No runs yet."}\n`,
  );
  await atomicWrite(path.join(runsDir, "index.html"), renderDashboard(newestFirst));
  return newestFirst.map(({ summary }) => summary);
}

export async function readSuccessfulRunPredictions(args: {
  index: DatasetIndex;
  runDir: string;
  messages: readonly Message[];
}): Promise<PredictionRow[]> {
  const manifest = await readManifest(args.runDir);
  const currentFingerprint = await fingerprintDataset(args.index.dataset);
  if (manifest.datasetFingerprint !== currentFingerprint) {
    throw new Error("Cannot emit output: dataset fingerprint changed");
  }
  const events = await readRunEvents(path.join(args.runDir, "events.jsonl"));
  validateJournal(manifest, events);
  const completion = events.at(-1);
  if (completion?.type !== "run_completed" || completion.status !== "succeeded") {
    throw new Error("Cannot emit output: run is not completed successfully");
  }
  const expectedTargets = args.messages.map((message) => ({
    messageId: message.message_id,
    modality: modalityFor(message.media_type),
  }));
  if (JSON.stringify(manifest.targets) !== JSON.stringify(expectedTargets)) {
    throw new Error("Cannot emit output: run target partition does not match");
  }
  const cases = foldCases(events);
  return args.messages.map((message) => {
    const event = cases.get(message.message_id);
    if (!event || event.type !== "case_succeeded") {
      throw new Error(`Run is incomplete: ${message.message_id} has no valid judgement`);
    }
    return decisionToPrediction(message.message_id, event.decision as Decision);
  });
}

export async function writeSuccessfulRunOutput(args: {
  index: DatasetIndex;
  runDir: string;
  outputPath?: string;
}): Promise<void> {
  const rows = await readSuccessfulRunPredictions({
    index: args.index,
    runDir: args.runDir,
    messages: args.index.dataset.messages,
  });
  await writeValidatedOutput({
    index: args.index,
    rows,
    outputPath: args.outputPath ?? path.join(args.runDir, "output.csv"),
  });
}
