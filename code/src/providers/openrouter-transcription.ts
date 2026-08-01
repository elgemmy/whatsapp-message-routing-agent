import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { resolveDatasetFile, type MediaFormat } from "../media.js";
import type {
  TranscriptionCallMetadata,
  TranscriptionProvider,
} from "../routing.js";

const TranscriptionResponseSchema = z
  .object({
    text: z.string().trim().min(1),
    usage: z
      .object({
        cost: z.number().finite().nonnegative().optional(),
        input_tokens: z.number().int().nonnegative().optional(),
        output_tokens: z.number().int().nonnegative().optional(),
        total_tokens: z.number().int().nonnegative().optional(),
        seconds: z.number().finite().nonnegative().optional(),
      })
      .loose()
      .optional(),
  })
  .loose();

const TRANSCRIPTION_FORMATS: Partial<Record<MediaFormat, string>> = {
  mp3: "mp3",
  wav: "wav",
  m4a: "m4a",
  mp4: "m4a",
};

class OpenRouterTranscriptionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly stopRun: boolean,
  ) {
    super(message);
  }
}

function metadataFrom(
  response: Response,
  usage: z.infer<typeof TranscriptionResponseSchema>["usage"],
): TranscriptionCallMetadata | undefined {
  const metadata = {
    ...(response.headers.get("x-generation-id")
      ? { responseId: response.headers.get("x-generation-id") as string }
      : {}),
    ...(usage?.input_tokens !== undefined
      ? { inputTokens: usage.input_tokens }
      : {}),
    ...(usage?.output_tokens !== undefined
      ? { outputTokens: usage.output_tokens }
      : {}),
    ...(usage?.total_tokens !== undefined
      ? { totalTokens: usage.total_tokens }
      : {}),
    ...(usage?.cost !== undefined ? { costUsd: usage.cost } : {}),
    ...(usage?.seconds !== undefined
      ? { durationSeconds: usage.seconds }
      : {}),
  };
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function httpFailure(status: number): OpenRouterTranscriptionError {
  if (status === 401 || status === 403) {
    return new OpenRouterTranscriptionError(
      "transcription_authentication_failed",
      "OpenRouter transcription authentication failed.",
      false,
      true,
    );
  }
  if (status === 402) {
    return new OpenRouterTranscriptionError(
      "transcription_insufficient_credits",
      "OpenRouter transcription credits are insufficient.",
      true,
      true,
    );
  }
  if (status === 404) {
    return new OpenRouterTranscriptionError(
      "transcription_model_unavailable",
      "The OpenRouter transcription model is unavailable or invalid.",
      false,
      true,
    );
  }
  if (status === 429) {
    return new OpenRouterTranscriptionError(
      "transcription_rate_limited",
      "OpenRouter transcription rate limit reached.",
      true,
      true,
    );
  }
  if (status >= 500) {
    return new OpenRouterTranscriptionError(
      "transcription_provider_unavailable",
      "OpenRouter transcription is temporarily unavailable.",
      true,
      true,
    );
  }
  return new OpenRouterTranscriptionError(
    "transcription_rejected",
    "OpenRouter rejected the transcription request.",
    false,
    false,
  );
}

export type OpenRouterTranscriptionProviderOptions = {
  modelId: string;
  apiKey?: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
};

export function createOpenRouterTranscriptionProvider(
  options: OpenRouterTranscriptionProviderOptions,
): TranscriptionProvider {
  const modelId = options.modelId.trim();
  if (modelId === "") throw new Error("OpenRouter transcription model ID must not be blank.");
  const apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY;
  const fetcher = options.fetch ?? globalThis.fetch;

  return {
    provider: "openrouter",
    model: modelId,
    classifyError(error: unknown) {
      if (error instanceof OpenRouterTranscriptionError) {
        return {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
          ...(error.stopRun ? { stopRun: true } : {}),
        };
      }
      if (
        (error instanceof DOMException && error.name === "AbortError") ||
        (error instanceof Error && /timeout|timed out|network|fetch failed/i.test(error.message))
      ) {
        return {
          code: "transcription_network_error",
          message: "OpenRouter transcription timed out or lost its connection.",
          retryable: true,
          stopRun: true,
        };
      }
      return {
        code: "transcription_failed",
        message: "The voice note could not be transcribed.",
        retryable: false,
      };
    },
    async transcribe(media, datasetRoot) {
      if (!apiKey?.trim()) {
        throw new OpenRouterTranscriptionError(
          "transcription_missing_api_key",
          "OpenRouter API key is missing for transcription.",
          false,
          true,
        );
      }
      if (media.kind !== "voice" || media.readStatus !== "readable") {
        throw new OpenRouterTranscriptionError(
          "transcription_input_unavailable",
          "The voice-note media is not readable.",
          false,
          false,
        );
      }
      const detectedFormat =
        media.detectedFormat === "unknown"
          ? media.declaredFormat
          : media.detectedFormat;
      const format = TRANSCRIPTION_FORMATS[detectedFormat];
      if (format === undefined) {
        throw new OpenRouterTranscriptionError(
          "transcription_format_unsupported",
          "The detected voice-note format is unsupported for transcription.",
          false,
          false,
        );
      }
      const audio = await readFile(resolveDatasetFile(datasetRoot, media.relativePath));
      const audioSha256 = createHash("sha256").update(audio).digest("hex");
      const response = await fetcher(
        "https://openrouter.ai/api/v1/audio/transcriptions",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: modelId,
            input_audio: { data: audio.toString("base64"), format },
          }),
          signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
        },
      );
      if (!response.ok) throw httpFailure(response.status);
      let parsed: z.infer<typeof TranscriptionResponseSchema>;
      try {
        parsed = TranscriptionResponseSchema.parse(await response.json());
      } catch {
        throw new OpenRouterTranscriptionError(
          "transcription_invalid_output",
          "OpenRouter returned an invalid transcription response.",
          true,
          false,
        );
      }
      const metadata = metadataFrom(response, parsed.usage);
      return {
        transcript: parsed.text,
        audioSha256,
        detectedFormat,
        ...(metadata ? { metadata } : {}),
      };
    },
  };
}
