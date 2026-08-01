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

## 2026-08-02 — Qwen STT and Luna Max complete-sample baseline

Status: accepted for gradual sample evaluation

- Use OpenRouter's dedicated `/api/v1/audio/transcriptions` endpoint with `qwen/qwen3-asr-flash-2026-02-10`. Qwen was selected over `x-ai/grok-stt-1.0` for its documented multilingual, dialect, background-music, noisy, and far-field coverage; both remain interchangeable configuration candidates for a later measured comparison.
- Keep one primary router. Voice notes receive one bounded STT call, then the journaled transcript becomes untrusted media context for Luna. This is a tool call, not a second routing agent. Do not send audio bytes to Luna.
- Journal a successful transcript before routing, including the STT model, media hash, detected format, duration, and bounded usage. Resume and Luna retries reuse that event. A crash after the provider responds but before the event is fsynced may still rebill once; provider-side idempotency is outside the harness.
- Request Luna reasoning effort `max` through the OpenRouter adapter's documented raw `extraBody` escape hatch. The installed adapter's convenience type currently omits the literal `max`, although OpenRouter's current API accepts it.
- Advance to prompt `routing-v2`, require one complete concise reason, increase the reason schema ceiling from 240 to 400 characters, and allow up to 2,000 output tokens so Max reasoning does not inherit the earlier truncation-prone ceiling.
- Run manifests now bind routing effort/output settings and transcription provider/model. Run summaries distinguish routing calls from transcription calls and aggregate all journaled call metadata, including locally invalid routing attempts.
- Keep separate Gemini image comprehension deferred. First complete all 30 supplied samples with Luna image input and compare the image cases before adding another model call.
- Claude Fable/Max review of `881f4e4` confirmed the main boundaries and led to four pre-smoke corrections: a generic STT 4xx now pauses and remains retryable after correction; AI SDK structured-output failures retain bounded usage when exposed; journal fields distinguish byte-detected format from the format sent to STT; and reports distinguish orchestration attempts from attempts with provider-reported usage.
- The review's stale-transcript concern does not apply: `fingerprintDataset()` already hashes every referenced image and voice file in addition to participant CSVs, so changed audio bytes reject resume before transcript reuse.
- Keep the 2,000-token Luna ceiling for the one-voice smoke only. Inspect finish reason and output usage before creating the long-lived full-sample run; raise it under a new manifest identity only if Max reasoning shows real ceiling pressure.

## 2026-08-02 — Grok STT supersedes Qwen for the complete-sample baseline

Status: accepted after format-compatibility probes

- Keep the same single-router architecture and OpenRouter transcription endpoint, but use `x-ai/grok-stt-1.0` as the default STT model. No format router, transcoder, or fallback chain is warranted for the current dataset.
- Qwen successfully transcribed the two real MP3 samples, but rejected `sample_msg_043`, whose bytes are M4A/AAC despite its `.mp3` filename. The failure is consistent with Qwen3-ASR-Flash's published container list, which omits M4A; a retryable stop preserved the run instead of fabricating a transcript.
- A bounded Grok probe transcribed the same M4A bytes successfully and Luna then produced the exact expected `mute / spam` classification. xAI documents Grok STT support for both MP3 and M4A, so one Grok configuration covers all supplied voice formats with less code and fewer failure modes.
- Preserve Qwen as an explicit `--transcription-model` experiment. Changing the STT model creates a different run manifest; never resume a Qwen run as Grok.
- Raise Luna's output ceiling from 2,000 to 8,000 for the durable baseline. In the six-case gate, `sample_msg_048` consumed exactly 2,000 output tokens and ended with `finishReason=length`; at 4,000, `sample_msg_048` recovered but `sample_msg_044` reached the ceiling on both its initial call and isolated retry. These are budget failures, not evidence that Luna cannot understand the images. Each bound is manifest-pinned and its run remains inspectable before considering a separate image model.
