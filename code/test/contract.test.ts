import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  parsePredictionCsv,
  serializePredictions,
  validatePredictionSet,
} from "../src/contract.js";
import {
  evaluateSamples,
  createSeedSampleEvaluation,
  makeDeliberatelyWrongSamplePredictions,
  writeSampleRunEvaluation,
  writeSampleRunProgress,
} from "../src/evaluate.js";
import { PredictionRowSchema, type PredictionRow } from "../src/domain.js";
import { indexPromise } from "./helpers.js";

function placeholderRows(messageIds: readonly string[]): PredictionRow[] {
  return messageIds.map((messageId) =>
    PredictionRowSchema.parse({
      message_id: messageId,
      action: "digest",
      message_type: "unknown",
      reason: "Contract-only fixture, not a routing judgement.",
      confidence: 0,
      evidence_message_ids: "none",
    }),
  );
}

test("round-trips hostile CSV text through parsing and full validation", async (t) => {
  const index = await indexPromise;
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "message-router-csv-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const rows = placeholderRows(index.dataset.messages.map((message) => message.message_id));
  rows[0] = PredictionRowSchema.parse({
    ...rows[0],
    reason: 'Contains a comma, "quote", and\na newline.',
  });
  assert.equal(validatePredictionSet(index, rows).length, 110);
  const csv = serializePredictions(rows);
  assert.ok(csv.startsWith("message_id,action,message_type,reason,confidence,evidence_message_ids\n"));
  assert.ok(csv.includes('"Contains a comma, ""quote"", and\na newline."'));
  const outputPath = path.join(temporaryRoot, "output.csv");
  await writeFile(outputPath, csv, "utf8");
  const parsed = validatePredictionSet(index, await parsePredictionCsv(outputPath));
  assert.deepEqual(parsed, rows);

  await writeFile(
    outputPath,
    csv.replace("message_id,action", "action,message_id"),
    "utf8",
  );
  await assert.rejects(parsePredictionCsv(outputPath), /Prediction headers/);
});

test("rejects missing rows, wrong order, and ineligible evidence", async () => {
  const index = await indexPromise;
  const rows = placeholderRows(index.dataset.messages.map((message) => message.message_id));
  assert.throws(() => validatePredictionSet(index, rows.slice(1)), /Expected 110/);
  assert.throws(
    () => validatePredictionSet(index, [rows[1], rows[0], ...rows.slice(2)]),
    /Prediction row 1/,
  );
  const badEvidence = [...rows];
  badEvidence[0] = PredictionRowSchema.parse({
    ...badEvidence[0],
    evidence_message_ids: index.dataset.history.find(
      (history) => history.user_id !== index.dataset.messages[0]?.user_id,
    )?.message_id,
  });
  assert.throws(() => validatePredictionSet(index, badEvidence), /not same-user history/);
});

test("rejects blank CSV confidence rather than coercing it to zero", () => {
  assert.equal(
    PredictionRowSchema.safeParse({
      message_id: "msg_test",
      action: "digest",
      message_type: "unknown",
      reason: "Incomplete output fixture.",
      confidence: "",
      evidence_message_ids: "none",
    }).success,
    false,
  );
});

test("enforces the submission reason and evidence limits", () => {
  const base = {
    message_id: "msg_test",
    action: "digest" as const,
    message_type: "unknown" as const,
    reason: "x".repeat(200),
    confidence: 0.5,
    evidence_message_ids: "none",
  };
  assert.equal(PredictionRowSchema.safeParse(base).success, true);
  assert.equal(
    PredictionRowSchema.safeParse({ ...base, reason: "x".repeat(201) }).success,
    false,
  );
});

test("sample evaluator self-check can guarantee zero action and type matches", async () => {
  const index = await indexPromise;
  const predictions = makeDeliberatelyWrongSamplePredictions(index.dataset.samples);
  const evaluation = evaluateSamples(index.dataset.samples, predictions);
  assert.equal(evaluation.label, "illustrative_sample_regression");
  assert.equal(evaluation.total, 46);
  assert.equal(evaluation.actionCorrect, 0);
  assert.equal(evaluation.messageTypeCorrect, 0);
  assert.equal(evaluation.exactCorrect, 0);
  assert.equal(evaluation.bySampleSet.provided.total, 30);
  assert.equal(evaluation.bySampleSet.counterfactual.total, 16);
});

test("sample evaluator reports evidence, reason-style, and confidence proxies", async () => {
  const index = await indexPromise;
  const provided = index.dataset.samples.find(
    (sample) => sample.message_id === "sample_msg_001",
  )!;
  const counterfactual = index.dataset.samples.find(
    (sample) => sample.message_id === "cf_msg_003",
  )!;
  const predictions = [
    PredictionRowSchema.parse({
      message_id: provided.message_id,
      action: provided.action,
      message_type: provided.message_type,
      reason: "This is a complete and useful sentence.",
      confidence: 0.8,
      evidence_message_ids: provided.evidence_message_ids,
    }),
    PredictionRowSchema.parse({
      message_id: counterfactual.message_id,
      action: "notify",
      message_type: "urgent",
      reason: "This explanation lacks terminal punctuation",
      confidence: 0.6,
      evidence_message_ids: "none",
    }),
  ];
  const evaluation = evaluateSamples([provided, counterfactual], predictions);
  assert.equal(evaluation.schemaVersion, 2);
  assert.equal(evaluation.bySampleSet.provided.total, 1);
  assert.equal(evaluation.bySampleSet.counterfactual.total, 1);
  assert.equal(evaluation.evidence.exactSetMatches, 2);
  assert.equal(evaluation.evidence.f1, 1);
  assert.equal(evaluation.reasonStyle.completeSentenceStyle, 1);
  assert.ok(Math.abs(evaluation.confidenceCalibration.brierScore - 0.2) < 1e-12);
  assert.equal(evaluation.cases[1]?.evidence.f1, null);
});

test("evidence reference metrics score a missing prediction as zero recall", async () => {
  const index = await indexPromise;
  const sample = index.dataset.samples.find(
    (candidate) => candidate.evidence_message_ids !== "none",
  )!;
  const prediction = PredictionRowSchema.parse({
    message_id: sample.message_id,
    action: sample.action,
    message_type: sample.message_type,
    reason: "The decision is supported by the available context.",
    confidence: 0.9,
    evidence_message_ids: "none",
  });
  const evaluation = evaluateSamples([sample], [prediction]);
  assert.equal(evaluation.evidence.precision, null);
  assert.equal(evaluation.evidence.recall, 0);
  assert.equal(evaluation.evidence.f1, 0);
  assert.equal(evaluation.evidence.exactSetMatches, 0);
});

test("persists the all-wrong sample evaluator seed and readable history", async (t) => {
  const index = await indexPromise;
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "message-router-eval-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const evaluation = await createSeedSampleEvaluation({
    samples: index.dataset.samples,
    evalRunsDir: temporaryRoot,
    runId: "seed-all-wrong",
    datasetFingerprint: "0".repeat(64),
  });
  assert.equal(evaluation.exactCorrect, 0);
  await access(path.join(temporaryRoot, "seed-all-wrong", "metrics.json"));
  await access(path.join(temporaryRoot, "seed-all-wrong", "predictions.csv"));
  assert.match(await readFile(path.join(temporaryRoot, "history.md"), "utf8"), /0\/46/);
  assert.match(await readFile(path.join(temporaryRoot, "index.html"), "utf8"), /seed-all-wrong/);
});

test("writes post-inference sample metrics beside a provider run", async (t) => {
  const index = await indexPromise;
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "message-router-live-eval-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const predictions = makeDeliberatelyWrongSamplePredictions(index.dataset.samples);
  const evaluation = await writeSampleRunEvaluation({
    samples: index.dataset.samples,
    predictions,
    runDir: temporaryRoot,
  });
  assert.equal(evaluation.exactCorrect, 0);
  await access(path.join(temporaryRoot, "sample-predictions.csv"));
  await access(path.join(temporaryRoot, "sample-metrics.json"));
  assert.match(
    await readFile(path.join(temporaryRoot, "sample-report.md"), "utf8"),
    /labels were not included in provider prompts/,
  );
});

test("writes readable partial sample progress with failures kept separate", async (t) => {
  const index = await indexPromise;
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "message-router-progress-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const prediction = makeDeliberatelyWrongSamplePredictions(index.dataset.samples)[0]!;
  const progress = await writeSampleRunProgress({
    samples: index.dataset.samples,
    outcomes: [
      { status: "succeeded", prediction },
      {
        status: "failed",
        messageId: index.dataset.samples[1]!.message_id,
        attempt: 2,
        error: { code: "invalid_output", message: "Invalid structured output." },
      },
    ],
    runDir: temporaryRoot,
  });
  assert.equal(progress.attempted, 2);
  assert.equal(progress.technicalSucceeded, 1);
  assert.equal(progress.technicalFailed, 1);
  assert.equal(progress.evaluation.total, 1);
  const report = await readFile(path.join(temporaryRoot, "sample-progress.md"), "utf8");
  assert.match(report, /Accuracy below uses technically successful predictions only/);
  assert.match(report, /semantic mismatch/);
  assert.match(report, /technical failure/);
  await access(path.join(temporaryRoot, "sample-progress.json"));
});
