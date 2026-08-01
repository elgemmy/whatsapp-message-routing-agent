import assert from "node:assert/strict";
import test from "node:test";
import {
  APICallError,
  EmptyResponseBodyError,
  NoContentGeneratedError,
  type FilePart,
} from "ai";
import { buildContext, type RoutingContext } from "../src/data.js";
import type { Decision } from "../src/domain.js";
import { classifyOpenRouterError } from "../src/providers/openrouter.js";
import {
  buildRoutingCase,
  buildRoutingMessages,
  MAX_NOTIFICATION_DAYS,
  MAX_PRIOR_MESSAGES,
  PROMPT_VERSION,
  ROUTING_SYSTEM_PROMPT,
  RoutingDecisionOutputSchema,
  type RoutingProvider,
  validateRoutingDecisionEvidence,
} from "../src/routing.js";
import { datasetRoot, indexPromise } from "./helpers.js";

const TYPES = [
  "personal",
  "urgent",
  "event",
  "payment",
  "business_update",
  "promotion",
  "greeting",
  "forward",
  "spam",
  "scam",
  "unknown",
];

test("routing-v1 prompt states the complete, injection-safe decision boundary", () => {
  assert.equal(PROMPT_VERSION, "routing-v1");
  for (const action of ["notify", "digest", "mute"]) {
    assert.match(ROUTING_SYSTEM_PROMPT, new RegExp(`\\b${action}\\b`));
  }
  for (const type of TYPES) assert.ok(ROUTING_SYSTEM_PROMPT.includes(type));
  assert.match(ROUTING_SYSTEM_PROMPT, /prompt-injection/i);
  assert.match(ROUTING_SYSTEM_PROMPT, /eligibleEvidenceMessageIds allowlist/);
  assert.match(ROUTING_SYSTEM_PROMPT, /not proof of spam or scam/i);
});

test("model case is compact, deterministic, label-free, and preserves ranked order", async () => {
  const index = await indexPromise;
  const context = index.dataset.messages
    .map((target) => buildContext(index, target))
    .find(
      (candidate) =>
        candidate.prior.length > MAX_PRIOR_MESSAGES &&
        candidate.notificationLoad.length > MAX_NOTIFICATION_DAYS,
    );
  assert.ok(context, "expected a real context exceeding both caps");
  const routingCase = buildRoutingCase(context);
  assert.equal(routingCase.prior.length, MAX_PRIOR_MESSAGES);
  assert.equal(routingCase.notificationLoad.length, MAX_NOTIFICATION_DAYS);
  assert.deepEqual(
    routingCase.eligibleEvidenceMessageIds,
    context.prior.slice(0, MAX_PRIOR_MESSAGES).map((item) => item.message.message_id),
  );
  assert.deepEqual(buildRoutingCase(context), routingCase);
  const serialized = JSON.stringify(routingCase);
  assert.ok(!serialized.includes("relativePath"));
  assert.ok(!serialized.includes("file_path"));
  assert.ok(!serialized.includes('"action"'));
  assert.ok(!serialized.includes('"message_type"'));

  const sampleCase = buildRoutingCase(buildContext(index, index.dataset.samples[0]!));
  assert.deepEqual(Object.keys(sampleCase.target).sort(), [
    "conversationType",
    "createdAt",
    "forwardedCount",
    "mediaType",
    "messageId",
    "senderUserId",
    "text",
  ]);
  const keys = new Set<string>();
  function collectKeys(value: unknown): void {
    if (Array.isArray(value)) {
      for (const item of value) collectKeys(item);
    } else if (typeof value === "object" && value !== null) {
      for (const [key, child] of Object.entries(value)) {
        keys.add(key);
        collectKeys(child);
      }
    }
  }
  collectKeys(sampleCase);
  for (const labelField of [
    "action",
    "message_type",
    "reason",
    "confidence",
    "evidence_message_ids",
  ]) {
    assert.equal(keys.has(labelField), false);
  }
});

test("multimodal messages carry safe local bytes with detected MIME type", async () => {
  const index = await indexPromise;
  const context = buildContext(
    index,
    index.dataset.samples.find((sample) => sample.message_id === "sample_msg_046")!,
  );
  assert.ok(context?.media);
  assert.equal(context.media.mediaId, "img_011");
  assert.equal(context.media.extensionMismatch, true);
  assert.equal(context.media.familyMismatch, false);
  const messages = await buildRoutingMessages(context, datasetRoot);
  const user = messages[1];
  assert.equal(user?.role, "user");
  assert.ok(Array.isArray(user.content));
  const file = user.content.find((part) => part.type === "file") as FilePart | undefined;
  assert.ok(file);
  assert.ok(Buffer.isBuffer(file.data));
  assert.equal(file.mediaType, "image/png");
  assert.ok((file.data as Buffer).length > 0);

  const escapingContext: RoutingContext = {
    ...context,
    media: { ...context.media, relativePath: "../organizer/labels.csv" },
  };
  await assert.rejects(
    buildRoutingMessages(escapingContext, datasetRoot),
    /escapes the dataset root/,
  );
});

test("decision schema preserves new labels and evidence is limited to unique shortlist IDs", async () => {
  const index = await indexPromise;
  const context = index.dataset.messages
    .map((message) => buildContext(index, message))
    .find((candidate) => candidate.prior.length > MAX_PRIOR_MESSAGES)!;
  const allowed = context.prior.slice(0, MAX_PRIOR_MESSAGES).map((item) => item.message.message_id);
  const rawDecision = RoutingDecisionOutputSchema.parse({
    action: "digest",
    messageType: "future_hidden_label",
    reason: "Useful later, but not interruptive.",
    confidence: 0.7,
    evidenceMessageIds: allowed.slice(0, 1),
  });
  validateRoutingDecisionEvidence(context, rawDecision as Decision);
  assert.equal(rawDecision.messageType, "future_hidden_label");

  assert.throws(
    () =>
      validateRoutingDecisionEvidence(context, {
        evidenceMessageIds: ["not_in_shortlist"],
      }),
    /outside the capped shortlist/,
  );
  assert.throws(
    () =>
      validateRoutingDecisionEvidence(context, {
        evidenceMessageIds: [context.prior[MAX_PRIOR_MESSAGES]!.message.message_id],
      }),
    /outside the capped shortlist/,
  );
  if (allowed[0]) {
    const firstAllowed = allowed[0];
    assert.throws(
      () =>
        validateRoutingDecisionEvidence(context, {
          evidenceMessageIds: [firstAllowed, firstAllowed],
        }),
      /duplicate/,
    );
  }
});

test("RoutingProvider exposes only raw decision and bounded metadata", async () => {
  const index = await indexPromise;
  const context = buildContext(index, index.dataset.messages[0]!);
  const fake: RoutingProvider = {
    provider: "fake",
    model: "fake/test",
    promptVersion: PROMPT_VERSION,
    validateDecision: validateRoutingDecisionEvidence,
    classifyError: classifyOpenRouterError,
    async judge() {
      return {
        rawDecision: {
          action: "notify",
          messageType: "urgent",
          reason: "Time-sensitive request.",
          confidence: 0.9,
          evidenceMessageIds: [],
        },
        metadata: {
          responseId: "response-safe-id",
          finishReason: "stop",
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
          routedProvider: "example",
          costUsd: 0.001,
        },
      };
    },
  };
  const result = await fake.judge(context, datasetRoot);
  assert.deepEqual(Object.keys(result).sort(), ["metadata", "rawDecision"]);
  assert.equal(result.metadata?.totalTokens, 120);
  assert.equal("requestBody" in (result.metadata ?? {}), false);
});

test("provider errors are reduced to stable retry policy without raw payloads", () => {
  assert.deepEqual(classifyOpenRouterError(new Error("fetch failed: secret body")), {
    code: "network_error",
    message: "OpenRouter request timed out or lost its connection.",
    retryable: true,
    stopRun: true,
  });
  assert.deepEqual(classifyOpenRouterError(new Error("contains a private token")), {
    code: "unknown_provider_error",
    message: "OpenRouter request failed.",
    retryable: false,
  });
  const apiError = (statusCode: number, data?: unknown) =>
    new APICallError({
      message: "private provider detail",
      url: "https://openrouter.ai/api/v1/chat/completions",
      requestBodyValues: { secret: "not persisted" },
      statusCode,
      data,
    });
  assert.deepEqual(
    classifyOpenRouterError(apiError(200, { code: 429 })),
    {
      code: "rate_limited",
      message: "OpenRouter rate limit reached.",
      retryable: true,
      stopRun: true,
    },
  );
  assert.equal(
    classifyOpenRouterError(apiError(400, { error: { code: 502 } })).code,
    "provider_unavailable",
  );
  assert.equal(classifyOpenRouterError(apiError(402)).code, "insufficient_credits");
  assert.deepEqual(
    classifyOpenRouterError(
      apiError(403, { code: 403, metadata: { error_type: "content_policy" } }),
    ),
    {
      code: "content_blocked",
      message: "The provider blocked this message for content policy reasons.",
      retryable: false,
    },
  );
  assert.equal(
    classifyOpenRouterError(new NoContentGeneratedError({})).code,
    "invalid_output",
  );
  assert.equal(
    classifyOpenRouterError(new EmptyResponseBodyError({})).code,
    "network_error",
  );
});
