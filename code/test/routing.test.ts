import assert from "node:assert/strict";
import test from "node:test";
import {
  APICallError,
  EmptyResponseBodyError,
  InvalidPromptError,
  NoContentGeneratedError,
  type FilePart,
} from "ai";
import { buildContext, type RoutingContext } from "../src/data.js";
import type { Decision } from "../src/domain.js";
import {
  classifyOpenRouterError,
  createOpenRouterRoutingProvider,
} from "../src/providers/openrouter.js";
import { createOpenRouterTranscriptionProvider } from "../src/providers/openrouter-transcription.js";
import {
  buildRoutingCase,
  buildRoutingMessages,
  MAX_NOTIFICATION_DAYS,
  MAX_PRIOR_MESSAGES,
  ProviderRoutingDecisionSchema,
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

test("routing-v3 prompt states the complete, injection-safe decision boundary", () => {
  assert.equal(PROMPT_VERSION, "routing-v3");
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
  assert.equal(messages.length, 1);
  assert.ok(messages.every((message) => message.role !== "system"));
  const user = messages[0];
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

test("voice transcripts are untrusted case data and audio bytes never reach Luna", async () => {
  const index = await indexPromise;
  const context = buildContext(
    index,
    index.dataset.samples.find((sample) => sample.message_id === "sample_msg_043")!,
  );
  await assert.rejects(
    buildRoutingMessages(context, datasetRoot),
    /voice transcript is required/i,
  );
  const transcript = "Limited offer, reply STOP if you do not want more calls.";
  const routingCase = buildRoutingCase(context, transcript);
  assert.equal(routingCase.media?.decodeStatus, "succeeded");
  assert.equal(routingCase.media?.transcript, transcript);
  assert.equal(routingCase.media?.detectedFormat, "m4a");
  assert.equal(routingCase.media?.extensionMismatch, true);

  const messages = await buildRoutingMessages(context, datasetRoot, transcript);
  const user = messages[0];
  assert.equal(user?.role, "user");
  assert.ok(Array.isArray(user.content));
  assert.equal(user.content.some((part) => part.type === "file"), false);
  const text = user.content.find((part) => part.type === "text");
  assert.equal(text?.type, "text");
  if (text?.type === "text") assert.match(text.text, /Limited offer/);
});

test("OpenRouter STT uses detected audio format and returns sanitized usage", async () => {
  const index = await indexPromise;
  const context = buildContext(
    index,
    index.dataset.samples.find((sample) => sample.message_id === "sample_msg_043")!,
  );
  assert.ok(context.media);
  let requestBody: unknown;
  let requestUrl = "";
  let requestHeaders = new Headers();
  const transcriber = createOpenRouterTranscriptionProvider({
    modelId: "qwen/qwen3-asr-flash-2026-02-10",
    apiKey: "test-key-not-persisted",
    fetch: async (input, init) => {
      requestUrl = String(input);
      requestHeaders = new Headers(init?.headers);
      requestBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          text: "A complete transcript.",
          usage: {
            cost: 0.0001,
            input_tokens: 3,
            output_tokens: 4,
            total_tokens: 7,
            seconds: 41.15,
          },
        }),
        { status: 200, headers: { "x-generation-id": "gen-safe" } },
      );
    },
  });
  const result = await transcriber.transcribe(context.media, datasetRoot);
  assert.equal(result.transcript, "A complete transcript.");
  assert.equal(result.detectedFormat, "m4a");
  assert.equal(result.transcriptionFormat, "m4a");
  assert.equal(result.audioSha256.length, 64);
  assert.deepEqual(result.metadata, {
    responseId: "gen-safe",
    inputTokens: 3,
    outputTokens: 4,
    totalTokens: 7,
    costUsd: 0.0001,
    durationSeconds: 41.15,
  });
  const body = requestBody as {
    model: string;
    input_audio: { data: string; format: string };
  };
  assert.equal(body.model, "qwen/qwen3-asr-flash-2026-02-10");
  assert.equal(body.input_audio.format, "m4a");
  assert.ok(body.input_audio.data.length > 1_000);
  assert.equal(requestUrl, "https://openrouter.ai/api/v1/audio/transcriptions");
  assert.equal(requestHeaders.get("content-type"), "application/json");
  assert.equal(requestHeaders.get("authorization"), "Bearer test-key-not-persisted");
  assert.equal(JSON.stringify(result).includes("test-key-not-persisted"), false);

  const unknownDetection = await transcriber.transcribe(
    { ...context.media, detectedFormat: "unknown", declaredFormat: "mp3" },
    datasetRoot,
  );
  assert.equal(unknownDetection.detectedFormat, "unknown");
  assert.equal(unknownDetection.transcriptionFormat, "mp3");

  const rejected = createOpenRouterTranscriptionProvider({
    modelId: "qwen/qwen3-asr-flash-2026-02-10",
    apiKey: "test-key-not-persisted",
    fetch: async () => new Response("bad request", { status: 400 }),
  });
  let rejection: unknown;
  try {
    await rejected.transcribe(context.media, datasetRoot);
  } catch (error) {
    rejection = error;
  }
  assert.deepEqual(rejected.classifyError(rejection), {
    code: "transcription_rejected",
    message: "OpenRouter rejected the transcription request.",
    retryable: true,
    stopRun: true,
  });
  assert.equal(
    rejected.classifyError(new DOMException("deadline", "TimeoutError")).code,
    "transcription_network_error",
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
    settings: { reasoningEffort: null, maxOutputTokens: 300, temperature: null },
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

test("OpenRouter routing sends literal Max reasoning through the adapter", async () => {
  const index = await indexPromise;
  const context = buildContext(index, index.dataset.samples[0]!);
  let requestBody: Record<string, unknown> | undefined;
  const provider = createOpenRouterRoutingProvider({
    modelId: "openai/gpt-5.6-luna",
    apiKey: "test-key-not-persisted",
    maxRetries: 0,
    fetch: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          id: "gen-routing-safe",
          model: "openai/gpt-5.6-luna",
          object: "chat.completion",
          created: 1,
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: JSON.stringify({
                  action: "notify",
                  messageType: "urgent",
                  reason: "A trusted admin sent a time-sensitive update.",
                  confidence: 0.9,
                  evidenceMessageIds: [],
                }),
              },
            },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  const result = await provider.judge(context, datasetRoot);
  assert.deepEqual(result.rawDecision, {
    action: "notify",
    messageType: "urgent",
    reason: "A trusted admin sent a time-sensitive update.",
    confidence: 0.9,
    evidenceMessageIds: [],
  });
  assert.deepEqual(requestBody?.reasoning, { effort: "max", exclude: true });
  assert.equal(requestBody?.max_tokens, 8_000);
  const serializedRequest = JSON.stringify(requestBody);
  for (const unsupportedKeyword of [
    '"minimum"',
    '"maximum"',
    '"minLength"',
    '"maxLength"',
    '"maxItems"',
  ]) {
    assert.equal(serializedRequest.includes(unsupportedKeyword), false);
  }
  assert.deepEqual(provider.settings, {
    reasoningEffort: "max",
    maxOutputTokens: 8_000,
    temperature: null,
  });
});

test("provider schema stays structural while local decision bounds remain strict", () => {
  const structurallyValid = {
    action: "notify" as const,
    messageType: "urgent",
    reason: "x".repeat(201),
    confidence: 2,
    evidenceMessageIds: Array.from({ length: MAX_PRIOR_MESSAGES + 1 }, (_, index) => `message_${index}`),
  };
  assert.equal(ProviderRoutingDecisionSchema.safeParse(structurallyValid).success, true);
  assert.equal(RoutingDecisionOutputSchema.safeParse(structurallyValid).success, false);
});

test("routing prompt asks for useful bounded evidence and a 200-character reason", () => {
  assert.match(ROUTING_SYSTEM_PROMPT, /up to 12 evidence IDs/);
  assert.match(ROUTING_SYSTEM_PROMPT, /never pad the list/);
  assert.match(ROUTING_SYSTEM_PROMPT, /at most 200 characters/);
});

test("invalid structured output retains bounded failed-call usage", async () => {
  const index = await indexPromise;
  const context = buildContext(index, index.dataset.samples[0]!);
  const provider = createOpenRouterRoutingProvider({
    modelId: "openai/gpt-5.6-luna",
    apiKey: "test-key-not-persisted",
    maxRetries: 0,
    fetch: async () =>
      new Response(
        JSON.stringify({
          id: "gen-invalid-safe",
          model: "openai/gpt-5.6-luna",
          object: "chat.completion",
          created: 1,
          choices: [
            {
              index: 0,
              finish_reason: "length",
              message: { role: "assistant", content: "not-json" },
            },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 20,
            total_tokens: 30,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  });
  let failure: unknown;
  try {
    await provider.judge(context, datasetRoot);
  } catch (error) {
    failure = error;
  }
  assert.equal(classifyOpenRouterError(failure).code, "invalid_output");
  assert.deepEqual(
    (failure as { routingMetadata?: unknown }).routingMetadata,
    {
      responseId: "gen-invalid-safe",
      finishReason: "length",
      rawFinishReason: "length",
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
    },
  );
  assert.equal(JSON.stringify(failure).includes("not-json"), false);
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
  assert.deepEqual(classifyOpenRouterError(apiError(400)), {
    code: "provider_rejected",
    message: "OpenRouter rejected the request.",
    retryable: true,
    stopRun: true,
  });
  assert.deepEqual(
    classifyOpenRouterError(
      apiError(404, {
        error: {
          code: 404,
          message: "No endpoints found that can handle the requested parameters.",
        },
      }),
    ),
    {
      code: "unsupported_parameters",
      message: "No OpenRouter endpoint supports the requested model parameters.",
      retryable: false,
      stopRun: true,
    },
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
  assert.deepEqual(
    classifyOpenRouterError(
      new InvalidPromptError({ prompt: [], message: "private prompt detail" }),
    ),
    {
      code: "invalid_prompt",
      message: "The local routing prompt is invalid.",
      retryable: false,
      stopRun: true,
    },
  );
});
