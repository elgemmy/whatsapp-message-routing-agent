import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { serializePredictions, validatePredictionSet } from "../src/contract.js";
import {
  evaluateSamples,
  createSeedSampleEvaluation,
  makeDeliberatelyWrongSamplePredictions,
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

test("validates exact target coverage and serializes escaped CSV", async () => {
  const index = await indexPromise;
  const rows = placeholderRows(index.dataset.messages.map((message) => message.message_id));
  rows[0] = PredictionRowSchema.parse({
    ...rows[0],
    reason: 'Contains a comma, "quote", and\na newline.',
  });
  assert.equal(validatePredictionSet(index, rows).length, 110);
  const csv = serializePredictions(rows);
  assert.ok(csv.startsWith("message_id,action,message_type,reason,confidence,evidence_message_ids\n"));
  assert.ok(csv.includes('"Contains a comma, ""quote"", and\na newline."'));
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

test("sample evaluator self-check can guarantee zero action and type matches", async () => {
  const index = await indexPromise;
  const predictions = makeDeliberatelyWrongSamplePredictions(index.dataset.samples);
  const evaluation = evaluateSamples(index.dataset.samples, predictions);
  assert.equal(evaluation.label, "illustrative_sample_regression");
  assert.equal(evaluation.total, 30);
  assert.equal(evaluation.actionCorrect, 0);
  assert.equal(evaluation.messageTypeCorrect, 0);
  assert.equal(evaluation.exactCorrect, 0);
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
  assert.match(await readFile(path.join(temporaryRoot, "history.md"), "utf8"), /0\/30/);
  assert.match(await readFile(path.join(temporaryRoot, "index.html"), "utf8"), /seed-all-wrong/);
});
