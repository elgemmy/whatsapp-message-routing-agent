import assert from "node:assert/strict";
import {
  access,
  appendFile,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createOrResumeRun,
  createSeedFailureRun,
  readRunEvents,
  repairTruncatedRunJournal,
  rebuildRunHistory,
  type RunEvent,
  writeSuccessfulRunOutput,
} from "../src/run-history.js";
import { parsePredictionCsv, validatePredictionSet } from "../src/contract.js";
import {
  PROMPT_VERSION,
  type RoutingProvider,
  validateRoutingDecisionEvidence,
} from "../src/routing.js";
import { indexPromise, repoRoot } from "./helpers.js";

test("seeded run records 110 honest failures and resumes without duplication", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "message-router-runs-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const index = await indexPromise;
  const args = {
    index,
    runsDir: temporaryRoot,
    repoRoot,
    runId: "seed-test",
  };
  const summary = await createSeedFailureRun(args);
  assert.equal(summary.status, "failed");
  assert.equal(summary.total, 110);
  assert.equal(summary.succeeded, 0);
  assert.equal(summary.failed, 110);
  assert.equal(summary.pending, 0);
  assert.deepEqual(summary.byModality, {
    text: { total: 87, succeeded: 0, failed: 87 },
    image: { total: 15, succeeded: 0, failed: 15 },
    voice: { total: 8, succeeded: 0, failed: 8 },
  });

  const eventsPath = path.join(temporaryRoot, "seed-test", "events.jsonl");
  const firstEvents = await readRunEvents(eventsPath);
  assert.equal(firstEvents.length, 112);
  assert.ok(
    firstEvents
      .filter((event) => event.type === "case_failed")
      .every((event) => event.error.code === "judgement_provider_unavailable"),
  );
  await assert.rejects(access(path.join(temporaryRoot, "seed-test", "output.csv")));
  await access(path.join(temporaryRoot, "seed-test", "report.md"));
  await access(path.join(temporaryRoot, "history.md"));
  const dashboard = await readFile(path.join(temporaryRoot, "index.html"), "utf8");
  assert.match(dashboard, /Message Router Run History/);
  assert.match(dashboard, /judgement_provider_unavailable/);

  const manifestPath = path.join(temporaryRoot, "seed-test", "manifest.json");
  const legacyManifest = JSON.parse(
    await readFile(manifestPath, "utf8"),
  ) as Record<string, unknown>;
  legacyManifest.schemaVersion = 1;
  delete legacyManifest.promptVersion;
  delete legacyManifest.partition;
  await writeFile(manifestPath, `${JSON.stringify(legacyManifest, null, 2)}\n`, "utf8");

  await createSeedFailureRun(args);
  assert.equal((await readRunEvents(eventsPath)).length, firstEvents.length);
  assert.equal((await rebuildRunHistory(temporaryRoot)).length, 1);
  assert.equal(
    (JSON.parse(await readFile(manifestPath, "utf8")) as { schemaVersion: number })
      .schemaVersion,
    1,
    "legacy manifests are normalized in memory, not rewritten",
  );

  await createSeedFailureRun({ ...args, retryFailures: true });
  const retriedEvents = await readRunEvents(eventsPath);
  assert.equal(retriedEvents.length, 224);
  assert.equal(
    retriedEvents.filter(
      (event) => event.type === "case_failed" && event.attempt === 2,
    ).length,
    110,
  );

  await appendFile(
    eventsPath,
    `${JSON.stringify({
      type: "case_failed",
      sequence: 225,
      timestamp: new Date().toISOString(),
      messageId: index.dataset.messages[0]?.message_id,
      modality: "text",
      attempt: 3,
      retryable: true,
      error: { code: "invalid_test", message: "Case outside an open run." },
    })}\n`,
    "utf8",
  );
  await assert.rejects(rebuildRunHistory(temporaryRoot), /outside an open run/);
});

test("event reader tolerates only a truncated final JSONL line", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "message-router-jsonl-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const eventsPath = path.join(temporaryRoot, "events.jsonl");
  await writeFile(
    eventsPath,
    `${JSON.stringify({ type: "run_started", sequence: 1, timestamp: new Date().toISOString() })}\n{"type":"case_failed"`,
    "utf8",
  );
  const events = await readRunEvents(eventsPath);
  assert.equal(events.length, 1);
  assert.equal(await repairTruncatedRunJournal(eventsPath), true);
  await appendFile(
    eventsPath,
    `${JSON.stringify({ type: "run_completed", sequence: 2, timestamp: new Date().toISOString(), status: "failed" })}\n`,
    "utf8",
  );
  assert.equal((await readRunEvents(eventsPath)).length, 2);
  await writeFile(eventsPath, "not json\n", "utf8");
  await assert.rejects(readRunEvents(eventsPath), /Invalid event line 1/);
});

test("emits output only from a valid successful run on the current dataset", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "message-router-output-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const index = await indexPromise;
  const runId = "successful-fixture";
  await createSeedFailureRun({ index, runsDir: temporaryRoot, repoRoot, runId });
  const runDir = path.join(temporaryRoot, runId);
  const eventsPath = path.join(runDir, "events.jsonl");
  const successfulEvents: RunEvent[] = (await readRunEvents(eventsPath)).map((event) => {
    if (event.type === "case_failed") {
      return {
        type: "case_succeeded",
        sequence: event.sequence,
        timestamp: event.timestamp,
        messageId: event.messageId,
        modality: event.modality,
        attempt: event.attempt,
        durationMs: 0,
        decision: {
          action: "digest",
          messageType: "unknown",
          reason: "Contract fixture, not a routing judgement.",
          confidence: 0,
          evidenceMessageIds: [],
        },
        rawMessageType: "unknown",
        usedUnknownFallback: false,
      };
    }
    return event.type === "run_completed" ? { ...event, status: "succeeded" } : event;
  });
  await writeFile(
    eventsPath,
    `${successfulEvents.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8",
  );

  await writeSuccessfulRunOutput({ index, runDir });
  const outputPath = path.join(runDir, "output.csv");
  assert.equal(
    validatePredictionSet(index, await parsePredictionCsv(outputPath)).length,
    110,
  );

  await rm(outputPath);
  const partialEvents = successfulEvents
    .filter(
      (event) =>
        event.type !== "case_succeeded" ||
        event.messageId !== index.dataset.messages[0]?.message_id,
    )
    .map((event, position) => ({ ...event, sequence: position + 1 })) as RunEvent[];
  await writeFile(
    eventsPath,
    `${partialEvents.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8",
  );
  await assert.rejects(
    writeSuccessfulRunOutput({ index, runDir }),
    /completed with 109\/110 cases/,
  );
  await assert.rejects(access(outputPath));

  await writeFile(
    eventsPath,
    `${successfulEvents.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8",
  );
  const manifestPath = path.join(runDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.datasetFingerprint = "f".repeat(64);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await assert.rejects(
    writeSuccessfulRunOutput({ index, runDir }),
    /dataset fingerprint changed/,
  );
  await assert.rejects(access(outputPath));
});

test("compares compatible baselines and explains fingerprint mismatches", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "message-router-baseline-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const index = await indexPromise;
  await createSeedFailureRun({
    index,
    runsDir: temporaryRoot,
    repoRoot,
    runId: "baseline-a",
  });
  const baselineManifestPath = path.join(temporaryRoot, "baseline-a", "manifest.json");
  const baselineManifest = JSON.parse(
    await readFile(baselineManifestPath, "utf8"),
  ) as Record<string, unknown>;
  baselineManifest.createdAt = "2000-01-01T00:00:00.000Z";
  await writeFile(
    baselineManifestPath,
    `${JSON.stringify(baselineManifest, null, 2)}\n`,
    "utf8",
  );

  const current = await createSeedFailureRun({
    index,
    runsDir: temporaryRoot,
    repoRoot,
    runId: "baseline-b",
  });
  assert.deepEqual(current.comparison, {
    baselineRunId: "baseline-a",
    compared: 110,
    changed: 0,
    recovered: 0,
    newTechnicalFailures: 0,
    stillFailing: 110,
  });

  baselineManifest.datasetFingerprint = "f".repeat(64);
  await writeFile(
    baselineManifestPath,
    `${JSON.stringify(baselineManifest, null, 2)}\n`,
    "utf8",
  );
  const rebuilt = await rebuildRunHistory(temporaryRoot);
  const rebuiltCurrent = rebuilt.find((summary) => summary.runId === "baseline-b");
  assert.ok(rebuiltCurrent);
  assert.equal(rebuiltCurrent.comparison, null);
  assert.equal(
    rebuiltCurrent.comparisonUnavailableReason,
    "baseline_dataset_fingerprint_mismatch",
  );
});

test("provider runs resume safely and retry only retryable invalid decisions", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "message-router-provider-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const index = await indexPromise;
  const firstMessageId = index.dataset.messages[0]?.message_id as string;
  let repaired = false;
  let calls = 0;
  const provider: RoutingProvider = {
    provider: "fake",
    model: "fake/structured",
    promptVersion: PROMPT_VERSION,
    validateDecision: validateRoutingDecisionEvidence,
    classifyError() {
      return { code: "fake_failure", message: "Fake provider failure.", retryable: true };
    },
    async judge(context) {
      calls += 1;
      if (context.target.message_id === firstMessageId && !repaired) {
        return {
          rawDecision: {
            action: "invalid_action",
            messageType: "urgent",
            reason: "Invalid fixture.",
            confidence: 0.5,
            evidenceMessageIds: [],
          },
        };
      }
      return {
        rawDecision: {
          action: "digest",
          messageType:
            context.target.message_id === firstMessageId
              ? "future_hidden_label"
              : "unknown",
          reason: "Deterministic fake-provider fixture.",
          confidence: 0.5,
          evidenceMessageIds: [],
        },
        metadata: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      };
    },
  };
  const args = {
    index,
    messages: index.dataset.messages,
    runsDir: temporaryRoot,
    repoRoot,
    runId: "fake-provider",
    partition: "targets" as const,
    provider,
    notes: "Provider-run integration fixture.",
  };

  const first = await createOrResumeRun(args);
  assert.equal(first.status, "failed");
  assert.equal(first.succeeded, 109);
  assert.equal(first.failed, 1);
  assert.equal(calls, 110);
  const runDir = path.join(temporaryRoot, "fake-provider");
  await assert.rejects(access(path.join(runDir, "output.csv")));
  const failed = (await readRunEvents(path.join(runDir, "events.jsonl"))).find(
    (event) => event.type === "case_failed" && event.messageId === firstMessageId,
  );
  assert.equal(failed?.type, "case_failed");
  if (failed?.type === "case_failed") {
    assert.equal(failed.error.code, "invalid_decision");
    assert.equal(failed.retryable, true);
  }

  calls = 0;
  await createOrResumeRun(args);
  assert.equal(calls, 0, "ordinary resume must not rebill recorded outcomes");

  repaired = true;
  const completed = await createOrResumeRun({ ...args, retryFailures: true });
  assert.equal(calls, 1);
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.succeeded, 110);
  assert.equal(completed.failed, 0);
  const events = await readRunEvents(path.join(runDir, "events.jsonl"));
  const retried = events.find(
    (event) =>
      event.type === "case_succeeded" &&
      event.messageId === firstMessageId &&
      event.attempt === 2,
  );
  assert.equal(retried?.type, "case_succeeded");
  if (retried?.type === "case_succeeded") {
    assert.equal(retried.decision.messageType, "unknown");
    assert.equal(retried.rawMessageType, "future_hidden_label");
    assert.equal(retried.usedUnknownFallback, true);
  }

  await writeSuccessfulRunOutput({ index, runDir });
  assert.equal(
    validatePredictionSet(
      index,
      await parsePredictionCsv(path.join(runDir, "output.csv")),
    ).length,
    110,
  );

  await assert.rejects(
    createOrResumeRun({
      ...args,
      provider: { ...provider, model: "fake/changed" },
    }),
    /provider configuration changed/,
  );
});

test("terminal provider failures are never retried", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "message-router-terminal-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const index = await indexPromise;
  let calls = 0;
  const provider: RoutingProvider = {
    provider: "fake",
    model: "fake/terminal",
    promptVersion: PROMPT_VERSION,
    validateDecision: validateRoutingDecisionEvidence,
    classifyError() {
      return { code: "authentication_failed", message: "Authentication failed.", retryable: false };
    },
    async judge() {
      calls += 1;
      throw new Error("private provider detail");
    },
  };
  const args = {
    index,
    messages: index.dataset.messages.slice(0, 1),
    runsDir: temporaryRoot,
    repoRoot,
    runId: "terminal-provider",
    partition: "targets" as const,
    provider,
    notes: "Terminal failure fixture.",
  };
  await createOrResumeRun(args);
  assert.equal(calls, 1);
  calls = 0;
  const retried = await createOrResumeRun({ ...args, retryFailures: true });
  assert.equal(calls, 0);
  assert.equal(retried.status, "failed");
  const events = await readRunEvents(
    path.join(temporaryRoot, "terminal-provider", "events.jsonl"),
  );
  assert.equal(events.filter((event) => event.type === "case_failed").length, 1);
});

test("batch-pausing failures require an explicit retry before pending calls continue", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "message-router-paused-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const index = await indexPromise;
  let fixed = false;
  let calls = 0;
  const provider: RoutingProvider = {
    provider: "fake",
    model: "fake/paused",
    promptVersion: PROMPT_VERSION,
    validateDecision: validateRoutingDecisionEvidence,
    classifyError() {
      return {
        code: "network_error",
        message: "Temporary transport failure.",
        retryable: true,
        stopRun: true,
      };
    },
    async judge() {
      calls += 1;
      if (!fixed) throw new Error("private transport detail");
      return {
        rawDecision: {
          action: "digest",
          messageType: "unknown",
          reason: "Recovered fake-provider fixture.",
          confidence: 0.5,
          evidenceMessageIds: [],
        },
      };
    },
  };
  const args = {
    index,
    messages: index.dataset.messages.slice(0, 2),
    runsDir: temporaryRoot,
    repoRoot,
    runId: "paused-provider",
    partition: "targets" as const,
    provider,
    notes: "Paused failure fixture.",
  };
  const paused = await createOrResumeRun(args);
  assert.equal(calls, 1);
  assert.equal(paused.status, "in_progress");
  assert.equal(paused.failed, 1);
  assert.equal(paused.pending, 1);
  await assert.rejects(createOrResumeRun(args), /use --retry-failures/);
  assert.equal(calls, 1);

  fixed = true;
  const completed = await createOrResumeRun({ ...args, retryFailures: true });
  assert.equal(calls, 3);
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.succeeded, 2);
});

test("nonretryable batch stops never advance pending cases", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "message-router-stopped-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const index = await indexPromise;
  let calls = 0;
  const provider: RoutingProvider = {
    provider: "fake",
    model: "fake/invalid",
    promptVersion: PROMPT_VERSION,
    validateDecision: validateRoutingDecisionEvidence,
    classifyError() {
      return {
        code: "invalid_model",
        message: "The model is invalid.",
        retryable: false,
        stopRun: true,
      };
    },
    async judge() {
      calls += 1;
      throw new Error("private provider detail");
    },
  };
  const args = {
    index,
    messages: index.dataset.messages.slice(0, 2),
    runsDir: temporaryRoot,
    repoRoot,
    runId: "stopped-provider",
    partition: "targets" as const,
    provider,
    notes: "Nonretryable stop fixture.",
  };
  const stopped = await createOrResumeRun(args);
  assert.equal(stopped.status, "in_progress");
  assert.equal(calls, 1);
  await assert.rejects(createOrResumeRun(args), /create a new run/);
  await assert.rejects(
    createOrResumeRun({ ...args, retryFailures: true }),
    /create a new run/,
  );
  assert.equal(calls, 1);
});
