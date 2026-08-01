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
OPENROUTER_MODEL=google/gemini-2.5-flash
```

The model is configurable and pinned in every run manifest. Confirm its current modalities, structured-output support, and pricing through OpenRouter before a paid run.

## Commands

From `code/`:

```sh
npm run typecheck
npm test
npm run verify:harness
npm run validate:data
npm run validate:output
npm run route:samples -- --run-id gemini25flash-routing-v1
npm run route -- --run-id gemini25flash-routing-v1
npm run output:emit -- --run-id gemini25flash-routing-v1 --output ../output.csv
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
  --run-id gemini25flash-routing-v1 \
  --message-id sample_msg_001 \
  --message-id sample_msg_015 \
  --message-id sample_msg_019 \
  --message-id sample_msg_041 \
  --message-id sample_msg_046 \
  --message-id sample_msg_049
```

This bounded smoke records six real responses covering all modalities and actions plus an opted-out business promotion, an unfamiliar sender, an unknown-type fallback, and the benign extension-mismatch case. Artifacts live inside `eval-runs/live/<run-id>/`. Resume the same run without message filters to process the remaining samples:

```sh
npm run route:samples -- --run-id gemini25flash-routing-v1
```

When all 30 sample cases succeed, the run directory receives `sample-predictions.csv`, `sample-metrics.json`, and `sample-report.md`. Labels are evaluated only after provider calls have been journaled.

After inspecting that evaluation, run targets under a distinct run ID:

```sh
npm run route -- --run-id gemini25flash-target-routing-v1
```

Use `--limit N` or repeated `--message-id ID` options for bounded runs. An ordinary resume skips every recorded outcome. `--retry-failures` retries only failures marked retryable; successful and nonretryable cases are never rebilled. Transport, authentication, and rate-limit failures pause the batch instead of repeating the same failure across remaining cases; fix the external cause, then resume explicitly with `--retry-failures`.

A completely successful target run automatically creates its canonical `runs/<run-id>/output.csv`. Publishing remains explicit:

```sh
npm run output:emit -- \
  --run-id gemini25flash-target-routing-v1 \
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
  events.jsonl    append-only source of truth
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
