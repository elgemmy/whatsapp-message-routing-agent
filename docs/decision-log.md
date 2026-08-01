# Decision Log

This file records decisions that should survive agent sessions. It is not a transcript and does not replace run manifests.

## 2026-08-01 — First harness scope

Status: accepted

- Build a batch TypeScript harness, not an autonomous runtime agent.
- Implement and measure dataset loading, joins, contract validation, evaluation plumbing, resumable run history, and a static HTML dashboard before adding judgement-provider calls.
- Prefer YAGNI: use flat files, Node's test runner, and generated HTML. Do not add a database, web framework, chart library, embeddings, an agent framework, or a model council in this pass.
- A seeded target run represents the absence of a judgement provider honestly: all 110 cases fail with `judgement_provider_unavailable`. It must not emit a partial `output.csv`.
- `events.jsonl` is the append-only source of truth for a run. Summaries, Markdown reports, and HTML dashboards are derived and may be rebuilt.

## 2026-08-01 — Message-type compatibility and fallback

Status: accepted; revisit when the routing prompt is implemented

- `payment` is a first-class allowed `message_type` even though the supplied 30-row sample has no payment example.
- The routing interface and future prompt must enumerate every contract value, including `payment` and `unknown`.
- The problem statement is authoritative for the closed output vocabulary. A raw model type outside that vocabulary is preserved in diagnostics and normalized to `unknown`; it is never silently promoted to a known semantic type.
- `unknown` is the graceful fallback for an undecidable or future/unrecognized message type. There is no unknown action in the contract: an undecidable action remains a retryable technical failure until a valid `notify`, `digest`, or `mute` decision exists.
- Future work: add explicit prompt examples or evaluation cases for payment-like messages and verify that new model/provider labels do not bypass normalization.

## 2026-08-01 — Media format mismatch is evidence, not a verdict

Status: accepted; revisit with the media adapter

- Inspect media bytes deterministically and record the extension-derived declared format, byte-detected format, whether their families are compatible, and whether the specific format differs from the extension.
- A mismatch is contextual evidence only. It must never directly choose `spam`, `scam`, `mute`, or any other semantic outcome.
- Routing context should combine this signal with file readability, eventual decoder outcome, message content, sender/business identity, and user relationship history.
- Header recognition is not decoding. Until a real image/audio adapter processes a file, expose `decodeStatus: not_attempted`; later record `succeeded` or `failed` from the adapter without changing the deterministic format evidence.
- Future work: measure whether mismatch plus other risk signals improves scam classification, and check benign mismatches to prevent false positives.
