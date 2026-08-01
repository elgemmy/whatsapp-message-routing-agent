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

## 2026-08-01 — First external review triage

Status: accepted

- Claude Fable at maximum effort reviewed committed baseline `31c37a5`; three project agents independently challenged its accuracy, simplicity, and test-harness findings. No reviewer found a blocker to beginning provider/routing work.
- Harden successful-run output emission now: require a matching dataset fingerprint, a valid journal, terminal success, complete target coverage, and the full output contract. Keep it covered by tests even though no provider-backed successful run exists yet.
- Add a read-only CLI output validator now. Defer the public emit command and final submission-path mutation until the provider can produce real judgements; require an explicit destination then rather than silently overwriting the dataset template.
- Constrain media paths lexically to the participant dataset root so CSV-provided absolute or parent-traversal paths cannot read organizer-only files.
- Cover hostile CSV round trips and compatible/incompatible baseline comparisons before trusting those claims in later runs.
- Defer confidence rounding, utility consolidation, dashboard expansion, and vocabulary deduplication until provider behavior gives them a concrete consumer or correctness benefit.

## 2026-08-01 — OpenRouter structured-routing baseline

Status: accepted; evaluate before expanding target spend

- Use one Vercel AI SDK v7 `generateText` call with `Output.object` per message and the official OpenRouter provider adapter. Keep provider details behind one injected `RoutingProvider`; do not introduce an agent loop, model council, registry, database, or concurrent batch scheduler.
- Require Node.js 22+, `OPENROUTER_API_KEY`, and an explicitly pinned `OPENROUTER_MODEL`. The initial documented candidate is `google/gemini-2.5-flash`, verified through OpenRouter's current models endpoint as supporting text, image, audio, and structured output; model support and pricing remain runtime facts to recheck.
- Prompt version `routing-v1` receives a deterministic compact case: at most 12 ranked same-user historical messages and 7 prior notification-load days. Sample label fields, output templates, raw media paths, secrets, and organizer-only data never enter prompts.
- Send readable image or voice bytes directly in the same bounded routing call using the byte-detected MIME type. Do not add separate OCR or transcription until case-level evaluation demonstrates a need.
- Normalize unrecognized model message types to `unknown`, preserve the raw value in the journal, and treat invalid actions or invalid/invented evidence as retryable technical failures. Evidence is restricted to the exact prompt shortlist.
- Generalize the existing append-only runner instead of building a provider-specific run path. Manifests bind provider, exact model, prompt version, partition, dataset fingerprint, and Git state; per-case events retain bounded usage metadata but never prompts or raw provider bodies.
- Run a small stratified sample smoke first, then all 30 illustrative samples. Evaluate labels only after inference. Start the 110 target run only after sample artifacts are structurally valid and inspected.
- A successful target run creates its canonical run-local `output.csv`. Publishing to the standalone submission path always requires an explicit CLI destination and revalidates the journal, dataset fingerprint, coverage, evidence, and CSV contract.

## 2026-08-01 — Luna text/image baseline and deferred speech-to-text

Status: accepted after first live smoke; do not expand to voice or targets yet

- Use `openai/gpt-5.6-luna` as the initial primary routing model. OpenRouter currently advertises text, image, file, and structured-output support for Luna, but not native audio input.
- Keep the runtime at one primary structured routing call per message. In the audio pass, add one bounded speech-to-text call for voice notes and pass the transcript into the same primary router; do not introduce a separate audio-routing agent.
- Keep a future Gemini image-understanding call as an evaluation-backed variant, not part of the current baseline.
- Live smoke `luna-routing-v1-smoke-3` attempted eight non-audio samples: seven technical successes and one repeated `invalid_output`; among successful predictions, action was correct for 5/7, type for 6/7, and exact action plus type for 5/7.
- Two image reasons reached the 240-character schema ceiling and ended abruptly. Treat this as a prompt/schema quality issue before broad evaluation, not as an acceptable final explanation.
- Do not resume the full 30 samples or 110 targets until the STT path exists. Continue with explicit non-audio IDs and inspect `sample-progress.md` after each bounded run.
