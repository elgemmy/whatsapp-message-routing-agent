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
  createSeedFailureRun,
  readRunEvents,
  repairTruncatedRunJournal,
  rebuildRunHistory,
  type RunEvent,
  writeSuccessfulRunOutput,
} from "../src/run-history.js";
import { parsePredictionCsv, validatePredictionSet } from "../src/contract.js";
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

  await createSeedFailureRun(args);
  assert.equal((await readRunEvents(eventsPath)).length, firstEvents.length);
  assert.equal((await rebuildRunHistory(temporaryRoot)).length, 1);

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
