# Message Notification Router Harness

This directory is the complete runnable TypeScript submission: dataset loading, deterministic context construction, multimodal routing through OpenRouter, local validation, resumable artifacts, output generation, and tests. The final policy prompt is compiled into `src/routing.ts`; runtime never reads files outside `code/` except the supplied dataset.

## Setup

Requirements: Node.js 22 or newer. The installed OpenRouter provider is ESM-only and requires Node 22+.

```sh
cd code
npm ci
npm test
```

Copy `.env.example` to `.env` and set your OpenRouter key before live routing. The key is the only required environment value. `.env` is ignored and must never be committed.

```text
OPENROUTER_API_KEY=...

# Optional development overrides:
# OPENROUTER_MODEL=openai/gpt-5.6-luna
# OPENROUTER_TRANSCRIPTION_MODEL=x-ai/grok-stt-1.0
```

With no overrides, routing uses `anthropic/claude-opus-5` at Medium reasoning and transcription uses `x-ai/grok-stt-1.0`. Resolution is explicit CLI option, then environment variable, then code default. For example, `--model` overrides `OPENROUTER_MODEL`, while `--transcription-model` overrides `OPENROUTER_TRANSCRIPTION_MODEL`. The resolved models and reasoning setting are pinned in every run manifest. Use a new run ID when changing one, and confirm current capabilities and pricing through OpenRouter before a paid run.

The provider-facing structured-output schema intentionally declares only the object shape and action enum. Complete reason, confidence, evidence-count, normalization, and evidence-allowlist checks still run locally with Zod before a case can succeed. This keeps the same validated output contract across providers whose strict JSON Schema subsets differ.

## Commands

From `code/`:

```sh
npm run typecheck
npm test
npm run verify:harness
npm run validate:data
npm run validate:output
npm run route:samples -- --run-id sample-routing-v1-smoke
npm run route -- --run-id target-routing-v1
npm run output:emit -- --run-id target-routing-v1 --output ../output.csv
npm run eval:seed
npm run eval:sample-seed
npm run runs:rebuild
```

`npm run eval:seed` creates or resumes `runs/seed-no-judgement`. The run deliberately records one retryable `judgement_provider_unavailable` failure for every target message because no judgement provider exists yet. It does not guess labels and does not emit a partial `output.csv`.

Open `runs/index.html` in a browser for the generated dashboard. `runs/history.md` and each run's `report.md` provide human-readable alternatives.

`npm run eval:sample-seed` creates `eval-runs/seed-all-wrong` with deliberately incorrect, contract-shaped predictions for the 30 provided examples plus 16 curated counterfactuals. Its expected 0/46 action, type, and exact scores prove the evaluator reports failures. Pass `--run-id` when the dataset changes, for example `npm run eval:sample-seed -- --run-id seed-augmented-v2`. It is a harness self-check, never a routing baseline. Open `eval-runs/index.html` for its case-level dashboard.

`npm run verify:harness` is the single clean-check command. `npm run validate:output` validates `dataset/output.csv` against the exact headers, target coverage/order, allowed values, and historical-evidence boundary. It intentionally fails while the starter template is blank.

## Live routing

Start with supplied samples so label quality can be measured after inference without leaking labels into prompts:

```sh
npm run route:samples -- \
  --run-id sample-routing-v1-smoke \
  --message-id sample_msg_001 \
  --message-id sample_msg_007 \
  --message-id sample_msg_015 \
  --message-id sample_msg_019 \
  --message-id sample_msg_046 \
  --message-id sample_msg_047 \
  --message-id sample_msg_048 \
  --message-id sample_msg_049
```

This bounded smoke covers text and image cases across all actions, group/business/personal relationships, opt-in and opt-out promotions, scam pressure, a legitimate safety advisory, an unfamiliar sender, and benign extension mismatches. Artifacts live inside `eval-runs/live/<run-id>/`; `sample-progress.md` and `sample-progress.json` compare attempted cases only after inference and keep technical failures separate from semantic accuracy.

Voice notes use one bounded OpenRouter speech-to-text call before the primary router. The default is `x-ai/grok-stt-1.0`; override it with `OPENROUTER_TRANSCRIPTION_MODEL` or `--transcription-model`. Grok is the complete-sample default because the dataset contains both MP3 and M4A audio: Qwen remains a valid opt-in experiment for supported formats, but its OpenRouter endpoint rejected the sample M4A file. The append-only journal records each transcript, detected format, audio hash, model identity, duration, and reported usage before routing, so a routing retry or resumed run reuses the transcript instead of rebilling STT. Audio bytes are never sent to the primary router.

Routing defaults to OpenRouter reasoning effort `medium`. Override it with `--reasoning-effort`; run manifests bind that setting, the 8,000-token output ceiling, prompt version, and STT model, so a resume rejects configuration drift. Prompt `routing-v5` is self-contained in `src/routing.ts` and applies explicit independent type/action policies, conservative tie-breakers, input grounding, a 200-character reason limit, and up to 12 materially useful evidence IDs without padding. All output limits are enforced locally.

Effort is part of manifest identity, so never change it while resuming a run.

For the final complete-sample validation, reuse one run ID so successful calls and transcripts remain resumable:

```sh
npm run route:samples -- --run-id final-sample-v5
```

When all 46 sample cases succeed, the run directory receives `sample-predictions.csv`, `sample-metrics.json`, and `sample-report.md`. Labels are evaluated only after provider calls have been journaled. Metrics report the 30 provided examples, 16 curated counterfactuals, and 46-case micro-total separately. Evidence gets exact-set and reference-overlap scores; reasons get a bounded complete-sentence style check and side-by-side human review; confidence gets Brier score and five-bin expected calibration error against exact action + type.

After inspecting that evaluation, run all targets under a distinct run ID:

```sh
npm run route -- --run-id submission-v5
```

Use `--limit N` or repeated `--message-id ID` options for bounded runs. An ordinary resume skips every recorded outcome. `--retry-failures` retries only failures marked retryable; successful and nonretryable cases are never rebilled. Transport, authentication, and rate-limit failures pause the batch instead of repeating the same failure across remaining cases; fix the external cause, then resume explicitly with `--retry-failures`.

A completely successful target run automatically creates its canonical `runs/<run-id>/output.csv`. Publishing remains explicit:

```sh
npm run output:emit -- \
  --run-id submission-v5 \
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

## Submission package

Package this `code/` directory alongside a sibling `dataset/` directory at evaluation time. Include `src/`, `test/`, `README.md`, `.env.example`, `package.json`, `package-lock.json`, and `tsconfig.json`. Exclude `.env`, `node_modules/`, `dist/`, `runs/`, `eval-runs/`, `evaluation/`, logs, and local agent/editor state. The included `.gitignore` records these boundaries.

The evaluator can reproduce the submission from a clean extraction with:

```sh
cd code
npm ci
npm run verify:harness
OPENROUTER_API_KEY=... npm run route -- --run-id judge-run
npm run output:emit -- --run-id judge-run --output ../output.csv
npm run validate:output -- --input ../output.csv
```

If the dataset is not a sibling of `code/`, pass `--dataset /path/to/dataset` to routing and validation commands. No policy or prompt file outside this directory is required.

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
- The 30 provided samples and 16 curated counterfactuals are illustrative regression sets, not organizer ground truth or training data.
- Evidence overlap compares one reference set and may miss other relevant history. Reason style is not semantic usefulness. Hidden target quality cannot be measured locally without trusted labels or the organizer rubric.
- Media extension mismatches are deterministic context signals, never automatic spam/scam decisions. Header recognition is not decoding; the current harness reports `decodeStatus: not_attempted` honestly.
- Model prompts contain only a capped deterministic context: at most 12 eligible historical messages and 7 prior notification-load days. Supplied sample labels are never serialized into provider input.
