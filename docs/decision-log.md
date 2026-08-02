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
- At 8,000 Max-effort tokens, `sample_msg_044` again consumed the entire budget without structured output. Stop doubling the ceiling. Keep Max as the requested default and expose a validated `--reasoning-effort` variant so a separate High-effort manifest can test reliability on the same Luna model before adding an image model.

## 2026-08-02 — Complete Grok STT baseline and Luna effort findings

Status: measured; preserve both variants before prompt iteration

- `luna-high8000-grok-stt-full-1` is the first complete provider-backed sample run: 30/30 technical success, 26/30 action matches, 23/30 message-type matches, and 21/30 exact pairs. Its reported usage is 71,936 input tokens, 8,867 output tokens, 47.92 transcribed audio seconds, and $0.015641 total provider cost.
- All three voice cases are exact. Grok transcribed both real MP3s and the M4A/AAC file hidden behind an `.mp3` filename; transcripts were journaled before Luna and the format mismatch remained visible as a non-conclusive signal.
- High-effort image routing is 4/5 exact. The one miss, `sample_msg_044`, correctly recognized an ordinary kurta-set sale but over-prioritized it and called it personal. This is a routing-policy/context error, not a demonstrated image-comprehension failure; do not add Gemini yet.
- The near-complete 4,000-token Max run produced 29 valid cases with 28 action matches, 22 type matches, and 22 exact pairs, but `sample_msg_044` failed at the ceiling twice and again at an isolated 8,000-token Max probe. Max therefore looks somewhat stronger on action accuracy among successful cases but is not a complete operational baseline.
- Keep the complete High run and the failed Max runs immutable. The next pass should study the text/type boundary errors and Max reliability before changing the model topology. Any Gemini image experiment must be a separately manifested comparison against the five supplied image cases.

## 2026-08-02 — Terra High three-run model-strength comparison

Status: measured; do not replace Luna based on model strength alone

- Ran three fresh, clean, manifest-identical sample evaluations with `openai/gpt-5.6-terra`, reasoning `high`, 8,000 output tokens, prompt `routing-v2`, and Grok STT. Every run completed 30/30 on its first attempt against dataset fingerprint `c10eb077a726136aea3aa65980997d2da23ea705173c1a9b8d8697694a2f029f`.
- Results were 24/24/21, 24/22/19, and 25/23/21 for action/type/exact. Means were 24.33 action, 23 type, and 20.33 exact, versus the single Luna High baseline's 26/23/21. Terra therefore did not produce an average semantic gain.
- Pairwise Terra disagreement covered 6, 8, and 9 of 30 exact action/type pairs. Only 19 cases had a unanimous pair; 10 split 2–1 and one produced three different pairs. A resolved majority scored 22 exact, only one above Luna, while fixing four Luna misses (`007`, `009`, `013`, `044`) and stably regressing two Luna-correct cases (`011`, `012`).
- Five Luna misses remained wrong in all three Terra runs: `002`, `005`, `006`, `010`, and `049`. These preserve the same event/urgent/business/personal/unknown and digest/mute/notify boundaries, supporting the context/prompt/taxonomy hypothesis more than a raw-capability hypothesis.
- Terra image exact scores were 5/5, 4/5, and 5/5, so it improved the small image subset. Text was 13/22, 14/22, and 14/22 versus Luna's 14/22. Voice was 3/3, 1/3, and 2/3 versus Luna's 3/3 even though all three Grok transcripts were text-identical, showing router variability rather than STT variance.
- Provider-reported cost across the three Terra runs was $0.200877 ($0.121793, $0.040004, and $0.039080). The large first-run difference makes cost comparison sensitive to provider caching or transient pricing; retain the reported values without inferring a permanent rate.
- Do not change the documented default model or add a Terra ensemble. The next pass should audit compact-context construction, relationship joins/ranking, and label definitions using the stable shared misses and regressions. The 30 participant-visible samples remain illustrative and do not establish hidden-target accuracy.

## 2026-08-02 — Opus 5 High three-run upper-bound comparison

Status: measured; keep as a stable upper-bound benchmark, not the default

- Verified `anthropic/claude-opus-5` supports text, image, file, structured output, and reasoning effort `high`. The regular model—not the 2x-priced Fast variant—was used with the same prompt `routing-v2`, 8,000 output-token ceiling, Grok STT, dataset fingerprint, and clean Git state.
- The initial compatibility run produced no judgements: Anthropic rejected the provider JSON Schema because numeric `minimum`/`maximum` keywords are unsupported. A sanitized one-case diagnostic exposed only that provider message. The provider schema is now structural while the full Zod bounds and evidence allowlist remain mandatory locally; generic correctable 4xx routing failures also pause the batch instead of repeating across every case. This fix is commit `2a8521d` and passed 34/34 tests.
- Three fresh corrected runs each completed 30/30 on the first attempt and independently produced the same 26 action matches, 24 type matches, and 23 exact pairs. All 30 action/type pairs were identical across all three runs: zero pairwise disagreement and zero score variance.
- Relative to Luna High's 21 exact pairs, Opus stably fixed `006`, `007`, `009`, `010`, and `044`, while stably regressing `004`, `011`, and `043`, for a net gain of two. Seven cases were wrong in all three Opus runs: `002`, `004`, `005`, `011`, `013`, `043`, and `049`.
- By modality, every Opus run scored text 16/22 exact, image 5/5, and voice 2/3. Grok transcripts were identical except for terminal punctuation on `043`; Opus chose `mute/scam` all three times instead of the sample's `mute/spam`, so this is a stable taxonomy boundary rather than material STT variance.
- Opus improved three Terra-majority misses (`006`, `010`, `012`) and regressed two Terra-majority correct cases (`004`, `013`). Four cases stayed wrong under both (`002`, `005`, `011`, `049`); Terra had no majority for `043`.
- Provider-reported cost was $0.734466, $0.734896, and $0.726391: $2.195753 total and $0.731918 mean. That is about 47x the recorded Luna High run cost for a two-case exact gain. Anthropic tokenization also reported about 120k input tokens per run versus about 72k for OpenAI models over the same logical prompt data.
- Model tier is therefore a real but bounded factor: Opus is more accurate and dramatically more stable than Terra, but seven unanimous misses and three regressions show that model strength does not remove the context/policy bottleneck. Keep Opus as an upper-bound oracle for the next context-construction pass; do not change the default or add an ensemble yet.

## 2026-08-02 — Evaluator-safe model defaults with local overrides

Status: accepted

- Require only `OPENROUTER_API_KEY` from the evaluation environment. Hardcode `anthropic/claude-opus-5` as the primary routing default and `x-ai/grok-stt-1.0` as the transcription default so a tester does not need to reconstruct the measured model configuration.
- Resolve each model independently in this order: explicit CLI option, non-blank environment override, then code default. Keep `OPENROUTER_MODEL` available for casual Luna development and `OPENROUTER_TRANSCRIPTION_MODEL` for measured STT variants.
- Default reasoning effort to `high`, matching the three stable Opus runs and the complete Luna baseline. A Luna Max experiment remains explicit and receives a fresh run ID because manifests reject configuration drift.
- Keep `.env.example` credential-safe: the API key field is empty and optional model overrides are commented. Never modify or commit a user's real `.env`.
- Do not add an oracle or model council now. Opus remains the evaluator-safe default and informative upper-bound model; Luna remains the inexpensive development override while context construction is iterated.

## 2026-08-02 — Luna/Opus context-flow diagnosis

Status: measured; use this order for the next accuracy pass

- Consolidated the Luna High baseline, three corrected Opus 5 High runs, current context pipeline, final AI SDK request boundary, and prioritized weak points in `docs/analysis-dashboard.html`.
- Opus's stable gain remains bounded: 23/30 exact versus Luna's 21/30, with five fixes, three regressions, unchanged action accuracy, and about 46.8 times the reported cost. No calibrated or narrow failure signal exists yet for a selective oracle gate.
- The current 12-message retrieval cap affects 19/30 samples. It retains 29/31 evidence references supplied by the illustrative labels; the two omitted references belong to cases both model families classify exactly. Every supplied evidence reference for the 12 Luna/Opus error-delta cases is present in the shortlist.
- Do not expand raw history or add an oracle first. The stronger immediate hypothesis is underspecified action precedence and type boundaries, especially event/urgent, personal/event, greeting/forward, spam/scam, and unknown/personal.
- First add inspectable context snapshots or hashes so retrieval changes can be compared. Then test a compact action/type decision matrix with Luna under a new prompt version, protecting currently correct cases. Add deterministic relationship/repetition/engagement summaries only if that measured prompt pass leaves context-dependent misses.

## 2026-08-02 — Luna structural-schema stability experiment

Status: measured; structural schema accepted, semantic variance remains

- Ran three fresh clean Luna High sample replications at commit `4c1ffb1`, with `routing-v2`, 8,000 output tokens, Grok STT, and the same dataset fingerprint as the old Luna baseline. All 90 routing calls and nine transcriptions succeeded on the first attempt with stop finishes; the structural provider schema caused no technical regression.
- Results were 26/23/22, 27/22/20, and 26/25/22 for action/type/exact. Means were 26.33/23.33/21.33 versus the old single run's 26/23/21, and every old score lies within the new range. There is no measured aggregate schema-driven accuracy shift.
- Luna pairwise action/type disagreement was 7, 4, and 4 of 30 cases; only 23/30 pairs were unanimous across the three new runs. Opus had zero pair disagreement across its three structural-schema runs, so the schema does not explain Opus's unusual semantic stability.
- Variability is concentrated in `007`, `009`, `011`, `012`, `013`, `044`, and `049`. There are no stable exact fixes over the old Luna run. `011` is the only stable action regression: old `digest/business_update` became `mute` in all three runs, with type still variable.
- All three voice transcripts exactly match the old baseline and voice remains 3/3 exact in every run, isolating the observed variance to the router. Text exact ranged 13–15/22 and image 4–5/5.
- Full decisions are not deterministic for either family: every pairwise complete decision differs. Luna changes action in 6/90 pair comparisons, type in 10/90, evidence order in 39/90, and evidence set in 24/90; Opus changes 0/90 action/type pairs, 19/90 evidence orders, and 14/90 evidence sets.
- Reported new-run cost was $0.015142, $0.007537, and $0.007330 despite identical input tokens and the same routed provider. Preserve these artifact values without inferring a new permanent price; caching or provider accounting may explain the spread.
- This is an operational before/after comparison, not causal proof: the pre-schema condition has only one older run. A matched old-schema replication would require an isolated historical worktree and fresh contemporaneous spend.

## 2026-08-02 — Augmented local evaluation and output-quality proxies

Status: accepted for the next Luna/Opus comparison; labels remain illustrative

- Preserve `docs/counterfactual_sample_messages.csv` as the curated source and append its 16 text cases to `dataset/sample_messages.csv`, yielding 30 provided cases plus 16 counterfactuals. Reports must show both slices and the 46-case micro-total separately.
- Treat all sample labels as indicative rather than organizer ground truth. Several counterfactuals deliberately probe ambiguous policy boundaries, including spam/promotion, personal/unknown, personal/event, event/urgent, and payment/scam.
- Correct `cf_msg_011` and `cf_msg_012` from `message_0001` to `message_0130`: both references were valid same-user history, but only the latter is present in the router's bounded 12-message shortlist. All counterfactual reference evidence is now visible to the model.
- Extend the local evaluator without a second judging model. Evidence receives exact-set agreement plus reference-only micro precision/recall/F1; confidence receives Brier score and five-bin expected calibration error against exact action + type. Reason evaluation enforces the 200-character/complete-sentence style boundary and exposes expected/predicted reasons side by side, but does not pretend to measure semantic usefulness.
- Advance to prompt `routing-v3`. Enforce at most 200 reason characters and at most 12 evidence IDs throughout local Zod/output validation. Ask the model to include only materially useful evidence and never pad the list.
- Keep these limitations explicit: another historical ID may be relevant even when it differs from the single sample reference; structural reason style is not the hidden judge's usefulness score; the organizer's weighting and rubric remain unknown.

## 2026-08-02 — Luna and Opus routing-v3 augmented comparison

Status: measured; use as the pre-policy baseline

- Both matched High-effort runs completed 46/46 cases with prompt `routing-v3`, 8,000 output tokens, Grok STT, and dataset fingerprint `f006bf062cbb5fc28a49aef111a34e4cab0347721beb71dc45f11bfee872a8c3`.
- Luna scored 40 action, 34 type, and 32 exact overall: 26/22/21 on the 30 provided examples and 14/12/11 on the 16 counterfactuals. Opus scored 41/37/35 overall: 26/24/23 provided and 15/13/12 counterfactual.
- At case level, both are exact on 27 cases, Opus alone on eight, Luna alone on five, and neither on six. Opus therefore gains three exact cases net, but it is not a monotonic upgrade.
- Both models changed the expected action/type pair direction on most counterfactual pairs: Luna 7/8 and Opus 8/8. Each classified both pair members exactly in 4/8 pairs. The known-versus-unfamiliar volunteer pair remains especially diagnostic: Luna returns `notify/event` for both; Opus changes the action but returns `personal` rather than the indicative `unknown` label for the unfamiliar sender.
- Evidence is a separate weakness. Luna selected 116 IDs and achieved 33.3% reference precision, 78.3% recall, 46.8% F1, and 14/46 exact sets. Opus selected 151 IDs, reaching 29.4% precision, 91.3% recall, 44.4% F1, and only 8/46 exact sets. Higher recall through longer lists is not automatically more useful evidence.
- All 92 reasons satisfied the 200-character complete-sentence style proxy. Luna averaged 151 characters with a maximum of 183; Opus averaged 163 with a maximum of 198. Do not equate this with semantic quality: Opus's exact `cf_msg_001` rationale claims a differing link domain even though the target contains no link.
- Opus confidence was materially better calibrated against exact action + type: Brier 0.165 and five-bin ECE 0.086 versus Luna 0.278 and 0.274. Luna assigned every case confidence above 0.8 despite 14 exact misses, so its confidence is not a safe oracle gate.
- Reported all-in cost was $0.023054 for Luna and $1.119196 for Opus, about 48.5 times higher for three additional exact pairs. Luna recorded one initial sandbox-network failure without reported usage, then succeeded on all 46 cases; Opus succeeded on every routing attempt.
- The manifests are marked dirty because the user's policy drafts were intentionally left untracked during the runs. The committed routing/evaluator source and dataset fingerprint are pinned. Luna's successful calls ran after the history-only compatibility commit `b385960`, while its manifest retains creation SHA `45b52c8`; no routing or prompt code changed between those commits.

## 2026-08-02 — Ordered policy guidance experiment

Status: accepted as a prompt-only `routing-v4` experiment

- Track the user's three guidance documents and embed their ordered action, type-precedence, and payment rules directly in the system prompt. Keeping the runtime prompt self-contained preserves the submission archive and avoids a policy loader or another dependency.
- Keep context construction, provider topology, models, schemas, evidence selection, and output validation unchanged so the paired Luna and Opus runs isolate the effect of guidance wording.
- Explicitly decide action and type independently. Type uncertainty does not choose the action, forwarding alone does not choose the type, and a sender-controlled payment channel remains scam regardless of familiarity.
- Preserve the guidance as written for this measurement rather than silently repairing its edge cases. Known indicative-label tensions include a non-today scheduled event (`cf_msg_010`), an immediate broadcast emergency not explicitly covered by the ordered action rules (`cf_msg_012`), and ambiguous same-day timing for the known/unfamiliar volunteer pair (`cf_msg_007`/`cf_msg_008`).
- Compare fresh High-effort, 8,000-token, Grok-STT Luna and Opus runs against the immutable `routing-v3` augmented baselines, reporting the 30 provided and 16 counterfactual slices separately.
