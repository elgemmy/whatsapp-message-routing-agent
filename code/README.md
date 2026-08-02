# Message Notification Router Harness

This directory contains the deterministic TypeScript harness for loading the challenge data, validating contracts, recording resumable runs, and inspecting run history. Judgement-provider integration comes after this harness is verified.

## Setup

Requirements: Node.js 22 or newer. The installed OpenRouter provider is ESM-only and requires Node 22+.

```sh
cd code
npm ci
npm test
```

Copy `.env.example` to `.env` and set your OpenRouter key before live routing. `.env` is ignored and must never be committed.

```text
OPENROUTER_API_KEY=...
OPENROUTER_MODEL=openai/gpt-5.6-luna
OPENROUTER_TRANSCRIPTION_MODEL=x-ai/grok-stt-1.0
```

The model is configurable and pinned in every run manifest. Confirm its current modalities, structured-output support, and pricing through OpenRouter before a paid run.

The provider-facing structured-output schema intentionally declares only the object shape and action enum. Complete reason, confidence, evidence-count, normalization, and evidence-allowlist checks still run locally with Zod before a case can succeed. This keeps the same validated output contract across providers whose strict JSON Schema subsets differ.

## Commands

From `code/`:

```sh
npm run typecheck
npm test
npm run verify:harness
npm run validate:data
npm run validate:output
npm run route:samples -- --run-id luna-routing-v1-smoke
npm run route -- --run-id luna-target-routing-v1
npm run output:emit -- --run-id luna-target-routing-v1 --output ../output.csv
npm run eval:seed
npm run eval:sample-seed
npm run runs:rebuild
```

`npm run eval:seed` creates or resumes `runs/seed-no-judgement`. The run deliberately records one retryable `judgement_provider_unavailable` failure for every target message because no judgement provider exists yet. It does not guess labels and does not emit a partial `output.csv`.

Open `runs/index.html` in a browser for the generated dashboard. `runs/history.md` and each run's `report.md` provide human-readable alternatives.

`npm run eval:sample-seed` creates `eval-runs/seed-all-wrong` with deliberately incorrect, contract-shaped predictions for the 30 solved examples. Its expected 0/30 action, type, and exact scores prove the evaluator reports failures. It is a harness self-check, never a routing baseline. Open `eval-runs/index.html` for its case-level dashboard.

`npm run verify:harness` is the single clean-check command. `npm run validate:output` validates `dataset/output.csv` against the exact headers, target coverage/order, allowed values, and historical-evidence boundary. It intentionally fails while the starter template is blank.

## Live routing

Start with supplied samples so label quality can be measured after inference without leaking labels into prompts:

```sh
npm run route:samples -- \
  --run-id luna-routing-v1-smoke \
  --message-id sample_msg_001 \
  --message-id sample_msg_007 \
  --message-id sample_msg_015 \
  --message-id sample_msg_019 \
  --message-id sample_msg_046 \
  --message-id sample_msg_047 \
  --message-id sample_msg_048 \
  --message-id sample_msg_049
```

This bounded Luna smoke covers text and image cases across all actions, group/business/personal relationships, opt-in and opt-out promotions, scam pressure, a legitimate safety advisory, an unfamiliar sender, and benign extension mismatches. Artifacts live inside `eval-runs/live/<run-id>/`; `sample-progress.md` and `sample-progress.json` compare attempted cases only after inference and keep technical failures separate from semantic accuracy.

Voice notes use one bounded OpenRouter speech-to-text call before Luna. The default is `x-ai/grok-stt-1.0`; override it with `OPENROUTER_TRANSCRIPTION_MODEL` or `--transcription-model`. Grok is the complete-sample default because the dataset contains both MP3 and M4A audio: Qwen remains a valid opt-in experiment for supported formats, but its OpenRouter endpoint rejected the sample M4A file. The append-only journal records each transcript, detected format, audio hash, model identity, duration, and reported usage before routing, so a Luna retry or resumed run reuses the transcript instead of rebilling STT. Audio bytes are never sent to Luna.

Luna routing uses OpenRouter reasoning effort `max`. Run manifests bind that setting, the 8,000-token output ceiling, prompt version, and STT model, so a resume rejects configuration drift. The ceiling was measured rather than guessed: image smokes exhausted 2,000 and then 4,000 tokens with `finishReason=length`; those immutable runs remain available for inspection. Prompt `routing-v2` asks for a complete short reason and allows enough schema headroom to avoid the prior 240-character truncation boundary.

Use `--reasoning-effort high` for a separate measured variant when Max repeatedly exhausts the output budget. Effort is part of manifest identity, so never change it while resuming a run. Max remains the default; this option exists to compare reliability and accuracy without changing models or code.

For a gradual complete-sample run, reuse one run ID so successful calls and transcripts remain resumable:

```sh
npm run route:samples -- --run-id luna-max-grok-stt-v1 --message-id sample_msg_042
npm run route:samples -- --run-id luna-max-grok-stt-v1 --retry-failures \
  --message-id sample_msg_041 --message-id sample_msg_042 \
  --message-id sample_msg_043 --message-id sample_msg_007 \
  --message-id sample_msg_048 --message-id sample_msg_049
npm run route:samples -- --run-id luna-max-grok-stt-v1 --retry-failures
```

When all 30 sample cases succeed, the run directory receives `sample-predictions.csv`, `sample-metrics.json`, and `sample-report.md`. Labels are evaluated only after provider calls have been journaled.

After inspecting that evaluation, run targets under a distinct run ID:

```sh
npm run route -- --run-id luna-target-routing-v1 --message-id NON_AUDIO_MESSAGE_ID
```

Use `--limit N` or repeated `--message-id ID` options for bounded runs. An ordinary resume skips every recorded outcome. `--retry-failures` retries only failures marked retryable; successful and nonretryable cases are never rebilled. Transport, authentication, and rate-limit failures pause the batch instead of repeating the same failure across remaining cases; fix the external cause, then resume explicitly with `--retry-failures`.

A completely successful target run automatically creates its canonical `runs/<run-id>/output.csv`. Publishing remains explicit:

```sh
npm run output:emit -- \
  --run-id luna-target-routing-v1 \
  --output ../output.csv
npm run validate:output -- --input ../output.csv
```

`output:emit` regenerates the requested file from the journal and rechecks its dataset fingerprint, terminal state, target coverage, evidence boundaries, and CSV contract. It never silently overwrites the starter template.

To validate a standalone submission file instead, pass its path explicitly:

```sh
npm run validate:output -- --input ../output.csv
```

The required file has exactly 110 prediction rows in target order and this header:

```text
message_id,action,message_type,reason,confidence,evidence_message_ids
```

## Run durability

Each run uses:

```text
runs/<run-id>/
  manifest.json   immutable run and reproducibility metadata
  events.jsonl    append-only decisions and reusable voice transcripts
  summary.json    rebuildable projection
  report.md       rebuildable human-readable report
```

Complete JSONL events are flushed before processing continues. A truncated final line is removed before a resumed writer appends new events. Resume skips cases that already have an outcome and continues missing cases; `--retry-failures` explicitly reopens a completed run and appends another attempt for failed cases. A run lock prevents concurrent writers; `--recover-lock` is available only for explicit recovery after confirming no writer remains.

Generated summaries, reports, dashboards, sample metrics, and output files are projections. A submission `output.csv` is emitted only when all target messages have valid judgements and the complete output contract passes.

## Evaluation boundaries

- Contract and data-integrity checks are objective.
- The 30 solved samples are an illustrative regression set, not organizer ground truth or training data.
- Hidden target action/type quality, reason usefulness, and confidence calibration cannot be measured locally without trusted labels.
- Media extension mismatches are deterministic context signals, never automatic spam/scam decisions. Header recognition is not decoding; the current harness reports `decodeStatus: not_attempted` honestly.
- Model prompts contain only a capped deterministic context: at most 12 eligible historical messages and 7 prior notification-load days. Supplied sample labels are never serialized into provider input.
