export const DEFAULT_ROUTING_MODEL = "anthropic/claude-opus-5";
export const DEFAULT_TRANSCRIPTION_MODEL = "x-ai/grok-stt-1.0";
export const DEFAULT_REASONING_EFFORT = "medium" as const;

type ModelConfigInput = {
  routingCli?: string | undefined;
  routingEnvironment?: string | undefined;
  transcriptionCli?: string | undefined;
  transcriptionEnvironment?: string | undefined;
};

export type ModelConfig = {
  routingModel: string;
  transcriptionModel: string;
};

function environmentOverride(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

function cliOverride(name: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!value.trim()) {
    throw new Error(`${name} requires a non-blank value`);
  }
  return value.trim();
}

export function resolveModelConfig(input: ModelConfigInput): ModelConfig {
  return {
    routingModel:
      cliOverride("--model", input.routingCli) ??
      environmentOverride(input.routingEnvironment) ??
      DEFAULT_ROUTING_MODEL,
    transcriptionModel:
      cliOverride("--transcription-model", input.transcriptionCli) ??
      environmentOverride(input.transcriptionEnvironment) ??
      DEFAULT_TRANSCRIPTION_MODEL,
  };
}
