import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_REASONING_EFFORT,
  DEFAULT_ROUTING_MODEL,
  DEFAULT_TRANSCRIPTION_MODEL,
  resolveModelConfig,
} from "../src/model-config.js";

test("uses evaluator-safe hardcoded model defaults", () => {
  assert.deepEqual(resolveModelConfig({}), {
    routingModel: "anthropic/claude-opus-5",
    transcriptionModel: "x-ai/grok-stt-1.0",
  });
  assert.equal(DEFAULT_ROUTING_MODEL, "anthropic/claude-opus-5");
  assert.equal(DEFAULT_TRANSCRIPTION_MODEL, "x-ai/grok-stt-1.0");
  assert.equal(DEFAULT_REASONING_EFFORT, "high");
});

test("environment values override each model default independently", () => {
  assert.deepEqual(
    resolveModelConfig({
      routingEnvironment: " openai/gpt-5.6-luna ",
      transcriptionEnvironment: " qwen/qwen3-asr-flash-2026-02-10 ",
    }),
    {
      routingModel: "openai/gpt-5.6-luna",
      transcriptionModel: "qwen/qwen3-asr-flash-2026-02-10",
    },
  );
  assert.deepEqual(resolveModelConfig({ routingEnvironment: "openai/gpt-5.6-luna" }), {
    routingModel: "openai/gpt-5.6-luna",
    transcriptionModel: DEFAULT_TRANSCRIPTION_MODEL,
  });
});

test("CLI values take precedence over conflicting environment values", () => {
  assert.deepEqual(
    resolveModelConfig({
      routingCli: "anthropic/claude-opus-5",
      routingEnvironment: "openai/gpt-5.6-luna",
      transcriptionCli: "x-ai/grok-stt-1.0",
      transcriptionEnvironment: "qwen/qwen3-asr-flash-2026-02-10",
    }),
    {
      routingModel: "anthropic/claude-opus-5",
      transcriptionModel: "x-ai/grok-stt-1.0",
    },
  );
});

test("blank environment overrides fall back while blank CLI values fail", () => {
  assert.deepEqual(
    resolveModelConfig({
      routingEnvironment: "   ",
      transcriptionEnvironment: "\t",
    }),
    {
      routingModel: DEFAULT_ROUTING_MODEL,
      transcriptionModel: DEFAULT_TRANSCRIPTION_MODEL,
    },
  );
  assert.throws(() => resolveModelConfig({ routingCli: " " }), /--model requires/);
  assert.throws(
    () => resolveModelConfig({ transcriptionCli: "\t" }),
    /--transcription-model requires/,
  );
});
