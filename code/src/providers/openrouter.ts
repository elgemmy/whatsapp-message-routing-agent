import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import {
  APICallError,
  EmptyResponseBodyError,
  generateText,
  InvalidPromptError,
  LoadAPIKeyError,
  NoContentGeneratedError,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  NoSuchModelError,
  Output,
  RetryError,
  TypeValidationError,
} from "ai";
import { ZodError } from "zod";
import type { RoutingContext } from "../data.js";
import { MAX_REASON_CHARACTERS } from "../domain.js";
import {
  buildRoutingMessages,
  ProviderRoutingDecisionSchema,
  PROMPT_VERSION,
  ROUTING_SYSTEM_PROMPT,
  RoutingDecisionOutputSchema,
  validateRoutingDecisionEvidence,
  type RoutingCallMetadata,
  type RoutingProvider,
} from "../routing.js";

export type ClassifiedOpenRouterError = {
  code: string;
  message: string;
  retryable: boolean;
  stopRun?: boolean;
};

type OpenRouterFailureEnvelope = {
  openRouterFailure: unknown;
  routingMetadata?: RoutingCallMetadata;
};

function isOpenRouterFailureEnvelope(
  error: unknown,
): error is OpenRouterFailureEnvelope {
  return (
    typeof error === "object" &&
    error !== null &&
    "openRouterFailure" in error
  );
}

export function classifyOpenRouterError(error: unknown): ClassifiedOpenRouterError {
  if (isOpenRouterFailureEnvelope(error)) {
    return classifyOpenRouterError(error.openRouterFailure);
  }
  if (RetryError.isInstance(error)) return classifyOpenRouterError(error.lastError);
  if (LoadAPIKeyError.isInstance(error)) {
    return { code: "missing_api_key", message: "OpenRouter API key is missing.", retryable: true, stopRun: true };
  }
  if (NoSuchModelError.isInstance(error)) {
    return { code: "invalid_model", message: "OpenRouter model is unavailable or invalid.", retryable: false, stopRun: true };
  }
  if (APICallError.isInstance(error)) {
    const data =
      typeof error.data === "object" && error.data !== null
        ? (error.data as Record<string, unknown>)
        : undefined;
    const nestedError =
      typeof data?.error === "object" && data.error !== null
        ? (data.error as Record<string, unknown>)
        : undefined;
    const providerError = nestedError ?? data;
    const providerCode = providerError?.code;
    const parsedProviderCode =
      typeof providerCode === "number"
        ? providerCode
        : typeof providerCode === "string" && /^\d+$/.test(providerCode)
          ? Number(providerCode)
          : undefined;
    const status = parsedProviderCode ?? error.statusCode;
    const metadata =
      typeof providerError?.metadata === "object" && providerError.metadata !== null
        ? (providerError.metadata as Record<string, unknown>)
        : undefined;
    const errorType = [providerError?.type, metadata?.error_type]
      .filter((value): value is string => typeof value === "string")
      .join(" ");
    const providerMessage =
      typeof providerError?.message === "string" ? providerError.message : "";
    if (status === 401) {
      return { code: "authentication_failed", message: "OpenRouter authentication failed.", retryable: true, stopRun: true };
    }
    if (status === 402) {
      return { code: "insufficient_credits", message: "OpenRouter credits are insufficient.", retryable: true, stopRun: true };
    }
    if (status === 403 && /moderation|content|policy|guardrail|safety|refusal/i.test(errorType)) {
      return { code: "content_blocked", message: "The provider blocked this message for content policy reasons.", retryable: false };
    }
    if (status === 403) {
      return { code: "authentication_failed", message: "OpenRouter permission or authentication failed.", retryable: true, stopRun: true };
    }
    if (status === 404) {
      if (/requested parameters|support.*parameters/i.test(providerMessage)) {
        return { code: "unsupported_parameters", message: "No OpenRouter endpoint supports the requested model parameters.", retryable: false, stopRun: true };
      }
      return { code: "invalid_model", message: "OpenRouter model is unavailable or invalid.", retryable: false, stopRun: true };
    }
    if (status === 429) {
      return { code: "rate_limited", message: "OpenRouter rate limit reached.", retryable: true, stopRun: true };
    }
    if (status !== undefined && status >= 500) {
      return { code: "provider_unavailable", message: "OpenRouter is temporarily unavailable.", retryable: true, stopRun: true };
    }
    if (error.isRetryable || status === undefined) {
      return { code: "network_error", message: "OpenRouter request failed temporarily.", retryable: true, stopRun: true };
    }
    return { code: "provider_rejected", message: "OpenRouter rejected the request.", retryable: true, stopRun: true };
  }
  if (
    NoObjectGeneratedError.isInstance(error) ||
    NoOutputGeneratedError.isInstance(error) ||
    NoContentGeneratedError.isInstance(error) ||
    TypeValidationError.isInstance(error)
  ) {
    return { code: "invalid_output", message: "The model did not return a valid routing decision.", retryable: true };
  }
  if (error instanceof ZodError) {
    const issues = error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join(".") || "root"}:${issue.code}`)
      .join(", ");
    return {
      code: "invalid_output",
      message: `The model decision failed local validation (${issues}).`,
      retryable: true,
    };
  }
  if (InvalidPromptError.isInstance(error)) {
    return { code: "invalid_prompt", message: "The local routing prompt is invalid.", retryable: false, stopRun: true };
  }
  if (EmptyResponseBodyError.isInstance(error)) {
    return { code: "network_error", message: "OpenRouter returned an empty response.", retryable: true, stopRun: true };
  }
  if (
    (error instanceof DOMException &&
      (error.name === "AbortError" || error.name === "TimeoutError")) ||
    (error instanceof Error && /timeout|timed out|network|fetch failed/i.test(error.message))
  ) {
    return { code: "network_error", message: "OpenRouter request timed out or lost its connection.", retryable: true, stopRun: true };
  }
  return { code: "unknown_provider_error", message: "OpenRouter request failed.", retryable: false };
}

export type OpenRouterRoutingProviderOptions = {
  modelId: string;
  apiKey?: string;
  timeoutMs?: number;
  maxRetries?: number;
  temperature?: number;
  maxOutputTokens?: number;
  reasoningEffort?: ReasoningEffort;
  fetch?: typeof globalThis.fetch;
};

export type ReasoningEffort =
  | "max"
  | "xhigh"
  | "high"
  | "medium"
  | "low"
  | "minimal"
  | "none";

export function boundProviderReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed.length <= MAX_REASON_CHARACTERS) return trimmed;

  const candidate = trimmed.slice(0, MAX_REASON_CHARACTERS - 1);
  const lastSpace = candidate.lastIndexOf(" ");
  const cutoff =
    lastSpace >= Math.floor(MAX_REASON_CHARACTERS * 0.6)
      ? lastSpace
      : candidate.length;
  const stem = candidate
    .slice(0, cutoff)
    .replace(/[\s,;:.!?-]+$/u, "");
  return `${stem}.`;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safeMetadata(result: {
  response: { id?: string | undefined };
  finishReason: string;
  rawFinishReason?: string | undefined;
  usage: {
    inputTokens?: number | undefined;
    outputTokens?: number | undefined;
    totalTokens?: number | undefined;
  };
  warnings?: Array<{ type: string }> | undefined;
  providerMetadata?: Record<string, unknown> | undefined;
}): RoutingCallMetadata {
  const openrouter = result.providerMetadata?.openrouter as
    | { provider?: unknown; usage?: { cost?: unknown } }
    | undefined;
  const inputTokens = finiteNumber(result.usage.inputTokens);
  const outputTokens = finiteNumber(result.usage.outputTokens);
  const totalTokens = finiteNumber(result.usage.totalTokens);
  const costUsd = finiteNumber(openrouter?.usage?.cost);
  return {
    ...(result.response.id ? { responseId: result.response.id } : {}),
    finishReason: result.finishReason,
    ...(result.rawFinishReason ? { rawFinishReason: result.rawFinishReason } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(typeof openrouter?.provider === "string" && openrouter.provider !== ""
      ? { routedProvider: openrouter.provider }
      : {}),
    ...(result.warnings && result.warnings.length > 0
      ? { warnings: result.warnings.slice(0, 8).map((warning) => warning.type) }
      : {}),
  };
}

export function createOpenRouterRoutingProvider(
  options: OpenRouterRoutingProviderOptions,
): RoutingProvider {
  const modelId = options.modelId.trim();
  if (modelId === "") throw new Error("OpenRouter model ID must not be blank.");
  const openrouter = createOpenRouter({
    compatibility: "strict",
    ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
  });
  const reasoningEffort = options.reasoningEffort ?? "medium";
  const maxOutputTokens = options.maxOutputTokens ?? 8_000;
  const model = openrouter(modelId, {
    provider: { require_parameters: true },
    usage: { include: true },
    // The installed adapter's typed union predates OpenRouter's literal "max".
    // extraBody is the adapter's documented path for current raw API fields.
    extraBody: { reasoning: { effort: reasoningEffort, exclude: true } },
  });

  return {
    provider: "openrouter",
    model: modelId,
    promptVersion: PROMPT_VERSION,
    settings: {
      reasoningEffort,
      maxOutputTokens,
      temperature: options.temperature ?? null,
    },
    validateDecision: validateRoutingDecisionEvidence,
    classifyError: classifyOpenRouterError,
    async judge(
      context: RoutingContext,
      datasetRoot: string,
      voiceTranscript?: string,
    ) {
      let result: Awaited<ReturnType<typeof generateText>>;
      try {
        result = await generateText({
          model,
          instructions: ROUTING_SYSTEM_PROMPT,
          messages: await buildRoutingMessages(context, datasetRoot, voiceTranscript),
          output: Output.object({
            schema: ProviderRoutingDecisionSchema,
            name: "routing_decision",
            description: "A personalized message notification routing decision.",
          }),
          timeout: options.timeoutMs ?? 60_000,
          maxRetries: options.maxRetries ?? 2,
          ...(options.temperature !== undefined
            ? { temperature: options.temperature }
            : {}),
          maxOutputTokens,
        });
      } catch (error) {
        if (NoObjectGeneratedError.isInstance(error) && error.usage) {
          throw {
            openRouterFailure: error,
            routingMetadata: safeMetadata({
              response: error.response ?? {},
              finishReason: error.finishReason ?? "unknown",
              usage: error.usage,
            }),
          } satisfies OpenRouterFailureEnvelope;
        }
        throw error;
      }
      let rawDecision: unknown;
      try {
        const structuralDecision = ProviderRoutingDecisionSchema.parse(result.output);
        rawDecision = RoutingDecisionOutputSchema.parse({
          ...structuralDecision,
          reason: boundProviderReason(structuralDecision.reason),
        });
      } catch (error) {
        throw {
          openRouterFailure: error,
          routingMetadata: safeMetadata({
            response: result.finalStep.response,
            finishReason: result.finishReason,
            rawFinishReason: result.rawFinishReason,
            usage: result.usage,
            warnings: result.warnings,
            providerMetadata: result.finalStep.providerMetadata,
          }),
        } satisfies OpenRouterFailureEnvelope;
      }
      return {
        rawDecision,
        metadata: safeMetadata({
          response: result.finalStep.response,
          finishReason: result.finishReason,
          rawFinishReason: result.rawFinishReason,
          usage: result.usage,
          warnings: result.warnings,
          providerMetadata: result.finalStep.providerMetadata,
        }),
      };
    },
  };
}
