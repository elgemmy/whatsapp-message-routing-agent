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
import { fingerprintDataset, type DatasetIndex } from "./data.js";
import { decisionToPrediction, DecisionSchema, type Decision } from "./domain.js";
import { writeValidatedOutput } from "./contract.js";

const ModalitySchema = z.enum(["text", "image", "voice"]);
type Modality = z.infer<typeof ModalitySchema>;

const RunManifestSchema = z
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

export type RunManifest = z.infer<typeof RunManifestSchema>;

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
const CaseFailedEventSchema = z
  .object({
    type: z.literal("case_failed"),
    sequence: z.number().int().positive(),
    timestamp: z.string().datetime({ offset: true }),
    messageId: z.string().min(1),
    modality: ModalitySchema,
    attempt: z.number().int().positive(),
    retryable: z.boolean(),
    error: z
      .object({ code: z.string().min(1), message: z.string().min(1) })
      .strict(),
  })
  .strict();
const CaseSucceededEventSchema = z
  .object({
    type: z.literal("case_succeeded"),
    sequence: z.number().int().positive(),
    timestamp: z.string().datetime({ offset: true }),
    messageId: z.string().min(1),
    modality: ModalitySchema,
    attempt: z.number().int().positive(),
    durationMs: z.number().int().nonnegative(),
    decision: DecisionSchema,
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
  CaseFailedEventSchema,
  CaseSucceededEventSchema,
  RunCompletedEventSchema,
]);
export type RunEvent = z.infer<typeof RunEventSchema>;
type CaseEvent = Extract<RunEvent, { type: "case_failed" | "case_succeeded" }>;

export type RunSummary = {
  runId: string;
  createdAt: string;
  status: "succeeded" | "failed" | "in_progress";
  gitSha: string;
  gitDirty: boolean;
  datasetFingerprint: string;
  provider: string;
  model: string;
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

async function readManifest(runDir: string): Promise<RunManifest> {
  return RunManifestSchema.parse(
    JSON.parse(await readFile(path.join(runDir, "manifest.json"), "utf8")),
  );
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

export async function createSeedFailureRun(args: {
  index: DatasetIndex;
  runsDir: string;
  repoRoot: string;
  runId: string;
  recoverLock?: boolean;
  retryFailures?: boolean;
}): Promise<RunSummary> {
  const runId = safeRunId(args.runId);
  const runsDir = path.resolve(args.runsDir);
  const runDir = path.join(runsDir, runId);
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
      if (manifest.provider !== "none" || manifest.model !== "none") {
        throw new Error(`Cannot seed ${runId}: it belongs to another provider/model`);
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
      for (const message of args.index.dataset.messages) {
        modalityCounts[modalityFor(message.media_type)] += 1;
      }
      manifest = RunManifestSchema.parse({
        schemaVersion: 1,
        runId,
        createdAt: now(),
        gitSha: git.sha,
        gitDirty: git.dirty,
        datasetFingerprint: fingerprint,
        targetCount: args.index.dataset.messages.length,
        modalityCounts,
        targets: args.index.dataset.messages.map((message) => ({
          messageId: message.message_id,
          modality: modalityFor(message.media_type),
        })),
        provider: "none",
        model: "none",
        baselineRunId,
        notes: "Seeded harness run: no judgement provider is configured.",
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
    if (wasCompleted && args.retryFailures) {
      await appendEvent(eventsPath, {
        type: "run_resumed",
        sequence: (sequence += 1),
        timestamp: now(),
        retryFailures: true,
      });
    }

    const completedCases = foldCases(await readRunEvents(eventsPath));
    for (const message of args.index.dataset.messages) {
      const previous = completedCases.get(message.message_id);
      if (previous?.type === "case_succeeded") continue;
      if (previous?.type === "case_failed" && !args.retryFailures) continue;
      await appendEvent(eventsPath, {
        type: "case_failed",
        sequence: (sequence += 1),
        timestamp: now(),
        messageId: message.message_id,
        modality: modalityFor(message.media_type),
        attempt: (previous?.attempt ?? 0) + 1,
        retryable: true,
        error: {
          code: "judgement_provider_unavailable",
          message: "No judgement provider was configured for this seeded run.",
        },
      });
    }

    const latestEvents = await readRunEvents(eventsPath);
    if (!wasCompleted || args.retryFailures) {
      await appendEvent(eventsPath, {
        type: "run_completed",
        sequence: (sequence += 1),
        timestamp: now(),
        status: "failed",
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
- Git: \`${summary.gitSha}${summary.gitDirty ? " (dirty)" : ""}\`
- Dataset: \`${summary.datasetFingerprint}\`
- Baseline: ${summary.baselineRunId ? `\`${summary.baselineRunId}\`` : "none"}

${summary.notes}

## Outcome

- Total: ${summary.total}
- Succeeded: ${summary.succeeded}
- Failed: ${summary.failed}
- Pending: ${summary.pending}

${markdownTable([["Modality", "Total", "Succeeded", "Failed"], ...modalityRows])}

## Failure codes

${Object.keys(summary.failureCodes).length === 0 ? "None." : markdownTable([["Code", "Count"], ...Object.entries(summary.failureCodes).map(([key, value]) => [key, String(value)])])}

## Previous-run comparison

${summary.comparison ? `Compared ${summary.comparison.compared} cases with \`${summary.comparison.baselineRunId}\`: ${summary.comparison.changed} changed, ${summary.comparison.recovered} technically recovered, ${summary.comparison.newTechnicalFailures} new technical failures, ${summary.comparison.stillFailing} still failing.` : summary.comparisonUnavailableReason ? `Unavailable: ${summary.comparisonUnavailableReason}.` : "No baseline is available for this run."}

Action and message-type quality are unavailable when there are no valid judgements. The organizer's hidden ground truth is not available locally.
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
      return `<section id="${htmlEscape(summary.runId)}"><h2>${htmlEscape(summary.runId)}</h2><p>${htmlEscape(summary.notes)}</p><div class="cards"><div><strong>${summary.succeeded}</strong><span>Succeeded</span></div><div><strong>${summary.failed}</strong><span>Failed</span></div><div><strong>${summary.pending}</strong><span>Pending</span></div><div><strong>${summary.total}</strong><span>Total</span></div></div><div class="bar"><i style="width:${summary.total ? (summary.succeeded / summary.total) * 100 : 0}%"></i></div><p>${comparison}</p><table><thead><tr><th>Modality</th><th>Total</th><th>Succeeded</th><th>Failed</th></tr></thead><tbody>${Object.entries(summary.byModality).map(([key, value]) => `<tr><td>${key}</td><td>${value.total}</td><td>${value.succeeded}</td><td>${value.failed}</td></tr>`).join("")}</tbody></table><details><summary>Failure details (${summary.failed})</summary><table><thead><tr><th>Message</th><th>Modality</th><th>Code</th><th>Detail</th><th>Retryable</th></tr></thead><tbody>${failureRows}</tbody></table></details><p class="meta">Dataset <code>${htmlEscape(summary.datasetFingerprint)}</code><br>Git <code>${htmlEscape(summary.gitSha)}</code>${summary.gitDirty ? " (dirty)" : ""}</p></section>`;
    })
    .join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Message Router Run History</title><style>:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#0b1020;color:#e8ecf8}body{max-width:1200px;margin:auto;padding:32px}h1,h2{letter-spacing:-.02em}section{background:#121a2f;border:1px solid #26314d;border-radius:14px;padding:24px;margin:24px 0;scroll-margin-top:20px}.cards{display:grid;grid-template-columns:repeat(4,minmax(120px,1fr));gap:12px}.cards div{background:#0b1020;border-radius:10px;padding:16px}.cards strong{display:block;font-size:2rem}.cards span,.meta{color:#9ba8c7}.bar{height:10px;background:#3b2030;border-radius:10px;overflow:hidden;margin:16px 0}.bar i{display:block;height:100%;background:#54d08a}table{width:100%;border-collapse:collapse;margin:16px 0;font-size:.92rem}th,td{text-align:left;padding:9px;border-bottom:1px solid #26314d;vertical-align:top}a{color:#8bb8ff}.status{padding:3px 8px;border-radius:999px;background:#293451}.status.failed{background:#5a2531}.status.succeeded{background:#1f563e}code{overflow-wrap:anywhere}@media(max-width:700px){body{padding:16px}.cards{grid-template-columns:repeat(2,1fr)}table{display:block;overflow:auto}}</style></head><body><h1>Message Router Run History</h1><p>Generated from append-only run events. Interrupted runs can resume safely; a partial submission CSV is never emitted. <a href="../eval-runs/index.html">Sample evaluation history</a></p><section><h2>Runs</h2><table><thead><tr><th>Run</th><th>Status</th><th>Created</th><th>Provider/model</th><th>Success</th><th>Failures</th><th>Git</th></tr></thead><tbody>${historyRows}</tbody></table></section><section><h2>Restore a prior run</h2><p>Only restore an <strong>all-successful</strong> run whose dataset fingerprint matches the current dataset. Revalidate its 110-row <code>output.csv</code> before copying it to the submission path. Use the recorded Git SHA to restore source separately; this dashboard never mutates code or submission files.</p></section>${sections}</body></html>`;
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

export async function writeSuccessfulRunOutput(args: {
  index: DatasetIndex;
  runDir: string;
}): Promise<void> {
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
  const cases = foldCases(events);
  const rows = args.index.dataset.messages.map((message) => {
    const event = cases.get(message.message_id);
    if (!event || event.type !== "case_succeeded") {
      throw new Error(`Run is incomplete: ${message.message_id} has no valid judgement`);
    }
    return decisionToPrediction(message.message_id, event.decision as Decision);
  });
  await writeValidatedOutput({
    index: args.index,
    rows,
    outputPath: path.join(args.runDir, "output.csv"),
  });
}
