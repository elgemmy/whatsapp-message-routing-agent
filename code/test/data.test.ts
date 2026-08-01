import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  buildContext,
  fingerprintDatasetFiles,
  RequiredBinarySchema,
  RequiredNonnegativeIntegerSchema,
} from "../src/data.js";
import { normalizeMessageType, normalizeRawDecision } from "../src/domain.js";
import { resolveDatasetFile } from "../src/media.js";
import { datasetRoot, indexPromise } from "./helpers.js";

test("loads and indexes the real participant dataset", async () => {
  const index = await indexPromise;
  assert.equal(index.dataset.messages.length, 110);
  assert.equal(index.dataset.samples.length, 30);
  assert.equal(index.dataset.history.length, 412);
  assert.equal(index.dataset.events.length, 412);
  assert.equal(index.mediaById.size, 33);
  assert.ok(!fingerprintDatasetFiles(index.dataset).includes("output.csv"));
});

test("rejects blank required numeric and binary cells instead of fabricating zero", () => {
  assert.equal(RequiredNonnegativeIntegerSchema.safeParse("").success, false);
  assert.equal(RequiredNonnegativeIntegerSchema.safeParse("   ").success, false);
  assert.equal(RequiredBinarySchema.safeParse("").success, false);
  assert.equal(RequiredBinarySchema.safeParse("2").success, false);
  assert.equal(RequiredNonnegativeIntegerSchema.parse("0"), 0);
  assert.equal(RequiredBinarySchema.parse("1"), 1);
});

test("builds same-user, pre-target context with nullable business history", async () => {
  const index = await indexPromise;
  const target = index.dataset.messages.find(
    (message) =>
      message.conversation_type === "business" &&
      !index.userBusinessByUserBusiness.has(
        `${message.user_id}\0${message.business_id as string}`,
      ),
  );
  assert.ok(target, "expected a business target without relationship history");
  const context = buildContext(index, target);
  assert.equal(context.conversation.kind, "business");
  if (context.conversation.kind === "business") {
    assert.equal(context.conversation.relationship, null);
  }
  assert.ok(context.prior.length > 0);
  assert.ok(
    context.prior.every(
      (prior) =>
        prior.message.user_id === target.user_id &&
        prior.message.created_at < target.created_at,
    ),
  );
  assert.deepEqual(buildContext(index, target), context, "context must be deterministic");
});

test("all supplied sample evidence is same-user history before the sample", async () => {
  const index = await indexPromise;
  for (const sample of index.dataset.samples) {
    if (sample.evidence_message_ids === "none") continue;
    for (const evidenceId of sample.evidence_message_ids.split(";")) {
      const history = index.historyById.get(evidenceId);
      assert.ok(history);
      assert.equal(history.user_id, sample.user_id);
      assert.ok(history.created_at < sample.created_at);
    }
  }
});

test("flags extension mismatches without claiming decoding or semantic risk", async () => {
  const index = await indexPromise;
  const pngNamedJpg = index.mediaById.get("img_004");
  assert.ok(pngNamedJpg);
  assert.equal(pngNamedJpg.declaredFormat, "jpeg");
  assert.equal(pngNamedJpg.detectedFormat, "png");
  assert.equal(pngNamedJpg.extensionMismatch, true);
  assert.equal(pngNamedJpg.familyMismatch, false);
  assert.equal(pngNamedJpg.decodeStatus, "not_attempted");

  const wavNamedMp3 = index.mediaById.get("vn_005");
  assert.ok(wavNamedMp3);
  assert.equal(wavNamedMp3.declaredFormat, "mp3");
  assert.equal(wavNamedMp3.detectedFormat, "wav");
  assert.equal(wavNamedMp3.extensionMismatch, true);
  assert.equal(wavNamedMp3.familyMismatch, false);
  assert.equal(wavNamedMp3.decodeStatus, "not_attempted");
});

test("keeps participant media paths inside the dataset root", () => {
  assert.equal(
    resolveDatasetFile(datasetRoot, "media/images/example.png"),
    path.join(datasetRoot, "media/images/example.png"),
  );
  assert.throws(() => resolveDatasetFile(datasetRoot, "../organizer/labels.csv"), /escapes/);
  assert.throws(() => resolveDatasetFile(datasetRoot, "/tmp/labels.csv"), /must be relative/);
});

test("keeps payment canonical and falls back unknown types to unknown", () => {
  assert.equal(normalizeMessageType("payment"), "payment");
  assert.equal(normalizeMessageType("Payment"), "payment");
  assert.equal(normalizeMessageType("business update"), "business_update");
  assert.equal(normalizeMessageType("invoice_request"), "unknown");
  const normalized = normalizeRawDecision({
    action: "digest",
    messageType: "future_hidden_label",
    reason: "No known category is a reliable fit.",
    confidence: 0.2,
    evidenceMessageIds: [],
  });
  assert.equal(normalized.decision.messageType, "unknown");
  assert.equal(normalized.rawMessageType, "future_hidden_label");
  assert.equal(normalized.usedUnknownFallback, true);
  assert.throws(() =>
    normalizeRawDecision({
      action: "unknown",
      messageType: "unknown",
      reason: "The output contract has no unknown action.",
      confidence: 0,
      evidenceMessageIds: [],
    }),
  );
});
