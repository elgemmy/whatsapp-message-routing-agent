# HackerRank Orchestrate: Message Notification Router

## Ideation and decision handoff for local Codex

This handoff reconstructs the useful parts of the initial ideation and the subsequent discussion. It is meant to be added to the original local Codex conversation before implementation continues.

Status: pre-implementation. Treat architectural choices as working decisions until `problem_statement.md`, all dataset schemas, starter code, competition rules, and evaluation details have been inspected.

## 1. Known Limitation

the visible sample dataset has only 32 rows. That is far too small to justify training a task-specific supervised classifier from scratch. It can be used as a regression/evaluation suite, but it is not statistically representative and should not be overfit. Hidden evaluation data may be larger or different.

## 2. Reconstructed discussion

### User: initial interpretation and questions

I initially saw two broad solution directions:

1. Build something closer to a conventional ML/Kaggle classification pipeline.
2. Use pretrained model intelligence through a structured agentic system.

The main unresolved questions were:

- For image messages, should I integrate a dedicated OCR model/service or use a strong multimodal model, such as a Gemini Flash-class model, that can both read the image and understand its meaning?
- For voice notes, should I transcribe first or pass native audio to a model that can reason about the content and tone?
- Should routing be one structured model call, a master agent with specialized tools, or a council of focused agents/models similar in spirit to Karpathy's LLM Council?
- Does “deterministic where possible” mean that I need deterministic routing rules, even though semantic prediction cannot be completely deterministic?
- Should I build the model integration by hand or use an SDK?
- I initially mentioned Cursor's SDK intentionally, then considered OpenRouter for provider choice and price control. Vercel AI SDK also appeared potentially more suitable (mainly because of the Structured Output feature).

My early architectural intuition was to build user/context profiles, let one or more LLMs classify each message, and potentially aggregate their predictions. I expected the multi-model route to be much easier than developing a specialized ML solution.

### Assistant: initial answer

The first recommendation was a hybrid semantic pipeline:

- Deterministic code loads and joins the supplied data, selects relevant history, validates evidence IDs, and writes the CSV.
- An LLM/VLM normalizes multimodal content and extracts semantic routing signals.
- Deterministic policy thresholds convert those signals into `notify`, `digest`, or `mute`.
- Model outputs are cached and logged with model/prompt metadata.
- Multiple models are compared during development, with an optional stronger fallback for uncertain cases.

The answer argued against both a full autonomous agent and a Kaggle-style ML system. It also recommended starting with a multimodal model for images because the task requires interpretation, not OCR alone. A dedicated OCR component would be justified only if evaluation showed systematic failures on dense screenshots, tiny text, or stylized posters.

It advised against a runtime LLM council because models can make correlated errors, multiple calls increase cost and variance, and majority voting can complicate explanations. It suggested using several models as development-time experiments instead.

This answer also proposed production-oriented pieces such as a database/cache, policy thresholds, prompt versions, retries, fallbacks, and extensive failure handling.

### User: pushback and revised proposition

The 32-row sample essentially removes task-specific supervised ML as a credible foundation. A pretrained model-based solution is more reasonable.

However, the first answer overcomplicated a 24-hour batch prediction task. A SQL database, elaborate policy thresholds, heavy fallback infrastructure, and production-style observability did not seem necessary. A prediction cannot be known to be semantically wrong at runtime without a human/reference label.

My preferred direction became:

- A master routing agent or one complete structured model call.
- Image understanding as a tool/call, not necessarily a separate agent.
- Possibly native multimodal routing in one call if the chosen model handles all modalities well.
- A multi-agent/council variant only as an experiment if it measurably improves results.
- Git commits or a lightweight log for change history rather than a separate metadata system.
- An evaluation runner with historical results and visualizations so I can see what changed, which cases improved, and which regressed. It does not need to be polished production infrastructure in the first runnable version.

I agreed that deterministic code still matters but wanted clarity on which deterministic parts are actually useful.

### Assistant: corrected and simplified answer

The correction accepted that the initial design imported too many production concerns. It also challenged one inference:

> A 32-row sample rules out task-specific supervised learning, but it does not by itself prove that multiple runtime agents are useful.

The agreed v1 runtime became:

| Component | Likely implementation | Responsibility |
| --- | --- | --- |
| Context builder | Ordinary TypeScript | Join and select relevant user, sender, group, business, history, and interaction records |
| Media understanding | Conditional model call/tool | Interpret an image or transcribe/understand a voice note when needed |
| Routing model | One structured model call | Produce action, reason, confidence, and evidence IDs |
| Output validator | Ordinary TypeScript | Enforce the output schema and reject invented evidence IDs |
| Eval runner | Script plus flat files | Compare runs and create a compact report/visualization |

Conceptually:

```ts
const context = buildContext(message);

const media = message.hasMedia
  ? await understandMedia(message)
  : undefined;

const decision = await routeMessage({ message, context, media });

validateOutputContract(decision);
```

If one multimodal model reliably accepts text, images, and audio, `understandMedia` and `routeMessage` can initially be one structured call. Split them only when evaluation demonstrates a benefit.

A vision or audio model does not automatically need to be an “agent.” If it has no independent goal, memory, planning, or tool loop, it is more accurately a bounded model call/tool.

Do not begin with separate urgency, relevance, safety, spam, and synthesis agents. Encode those perspectives in one structured routing prompt. A council remains a valid experiment:

- Baseline: one routing model.
- Variant: focused judges plus a synthesizer, or multiple independent model predictions.
- Keep the variant only if it improves case-level evaluation enough to justify its extra cost, latency, and complexity.

### Clarification: what should be deterministic

The semantic label can remain model-based. The following surrounding operations should be deterministic:

- CSV parsing and dataset joins
- The records eligible to become context for a message
- Stable context ordering and size limits
- Media dispatch based on known `message_type`
- Required output fields and allowed enum values
- Evidence IDs being a subset of the supplied candidate history
- CSV row ordering and serialization
- Eval inputs, comparison logic, and run artifacts

Handwritten routing thresholds are not required. Add a deterministic override only if evaluation exposes a clear invariant worth encoding.

There are two distinct notions of failure:

- **Prediction error:** the model returns a valid row but chooses the wrong semantic action. This can be found only by comparison with a trusted label or human judgment.
- **Technical failure:** malformed structured output, missing fields, invalid enum values, invented evidence IDs, unreadable media, request failure, or a missing output row. Lightweight handling is worthwhile because the submission contract must always be satisfied.

### Clarification: evaluation history

Git records the prompt and code, but it does not necessarily record which hosted model/provider/configuration produced a run. A database is unnecessary; flat run artifacts are enough.

Suggested shape:

```text
eval/
  gold.csv                 # supplied labels, if any; otherwise documented human review
  run-eval.ts

runs/
  baseline/
    manifest.json
    output.csv
    metrics.json
  context-v2/
    manifest.json
    output.csv
    metrics.json
```

A minimal manifest should capture only non-Git runtime facts:

```json
{
  "git_sha": "abc123",
  "model": "exact-model-id",
  "provider": "provider-name",
  "notes": "Added recent interaction history"
}
```

Useful comparisons for 32 examples:

- Confusion matrix, if trusted labels exist
- Accuracy by action and modality
- Predicted action distribution
- Cases changed from the previous run
- Changed cases grouped into fixed, regressed, and still wrong
- Per-case reason/evidence comparison when the action did not change

Each row is 3.125 percentage points, so the case-level diff matters more than elaborate aggregate statistics. If no official labels exist, create a clearly documented human-reviewed local gold set and do not confuse it with organizer ground truth.

### Clarification: SDK and provider layers

These options are not all direct substitutes:

| Layer/product | Role in this project |
| --- | --- |
| Vercel AI SDK | Application-layer abstraction for structured generation, tools, and provider adapters |
| OpenRouter | Model gateway/provider access, useful for model choice and spend control |
| OpenRouter TypeScript/agent SDKs | OpenRouter-specific clients and optional agent loop |
| Vercel AI Gateway | A model gateway that competes more directly with OpenRouter |
| Cursor SDK | Programmatically runs Cursor coding agents against repositories; not the natural inference layer for classifying WhatsApp messages |

Working recommendation:

- Use Vercel AI SDK as the application abstraction.
- Use OpenRouter through its Vercel AI SDK provider adapter when OpenRouter credits/model access are useful.
- Keep model access behind a small local interface so direct Gemini or another provider can be tested without rewriting the router.
- Pin the exact model and provider for final runs; avoid automatic routing when reproducibility matters.
- Do not build a general autonomous-agent framework for this bounded batch pipeline.

## 3. New context recovered from the rough notes

The following ideas were in the PDF but were not fully discussed. They should now be treated as open project requirements/questions rather than settled decisions.

### A. Development-agent workflow, distinct from runtime-agent architecture

The notes ask how Codex should work on the repository, including when to use a primary agent, Codex subagents, or an external model such as Claude. This is separate from whether the submitted router contains multiple agents.

Proposed starting protocol:

- One primary local Codex session owns implementation, integration decisions, and the canonical plan.
- Delegate only bounded work with a clear artifact: for example, inspect dataset relationships, independently review the routing prompt, or audit a diff for contract violations.
- Avoid multiple agents editing overlapping files simultaneously during a 24-hour event.
- For an external review, provide the problem statement, relevant schemas/files, current decision summary, exact question, constraints, and required output format.
- Ask reviewers for evidence-backed findings, ranked risks, or a specific patch/recommendation rather than “review everything.”
- Bring conclusions back into one canonical decision log; do not let separate chats become competing sources of truth.

### B. Long chats, handoffs, and repository context

The likely minimal solution is:

- Keep stable repository instructions in `AGENTS.md`.
- Keep current decisions, rejected alternatives, open questions, and experiment outcomes in one short `docs/decision-log.md` or equivalent.
- Keep run outputs under `runs/` or another clearly excluded/controlled artifact directory.
- Use the actual platform transcript as the raw development record if the competition requires it; do not rewrite a fabricated transcript after the fact.
- At each handoff, summarize only current state, next action, blockers, and important decisions. Do not paste the entire chat repeatedly.

Whether these files should be committed depends on the submission rules and repository expectations.

### C. Commit protocol

The notes propose storing metadata in commit messages and giving the agent explicit commit instructions. This was only partly addressed.

Working recommendation:

- Use focused commits at verified milestones, not after every trivial edit.
- Put the reason for the change and verification performed in the commit body.
- For experiments, record the run name/model/result in the run manifest or decision log; commit messages alone cannot represent hosted runtime state reliably.
- Do not commit secrets, raw credentials, or large generated artifacts unless the challenge requires them.
- Do not let agents commit automatically unless that workflow is explicitly authorized and the diff has been reviewed.

### D. Architectural boundaries and tests

The notes ask how to enforce boundaries and where unit tests belong. This was not previously answered.

Suggested boundaries:

```text
data/context       deterministic parsing, joins, and context selection
media              image/audio model adapter or multimodal normalization
routing            prompt/schema and routing-model interface
output             validation and CSV serialization
eval               gold labels, metrics, comparison, and report generation
```

Rules to consider:

- `eval` may call runtime code, but runtime code must not depend on `eval`.
- Provider-specific details stay behind a small model interface.
- The router receives an explicit compact context object rather than reaching into raw datasets itself.
- Output validation does not decide semantic correctness; it enforces the contract.

Unit-test deterministic behavior:

- Parsing and joins
- Context eligibility and stable ordering
- Duplicate/invalid evidence filtering
- Required fields, enum validation, and confidence bounds
- One output row per input message
- CSV escaping and deterministic ordering

Use fixture/integration tests, recorded responses, or a small live smoke test for model adapters. Do not pretend that a conventional unit test can prove subjective LLM routing quality; use the eval suite for that.

### E. “How to run evals” remains an implementation task

The desired behavior is clear, but the exact commands and package structure have not been chosen. Codex should create the smallest repeatable flow equivalent to:

1. Generate predictions for a named run.
2. Validate the submission contract.
3. Compare against trusted labels or the documented local gold set.
4. Save predictions, metrics, and minimal runtime metadata.
5. Diff the run against a chosen baseline.
6. Produce a compact human-readable report.

## 5. Current decision summary

The current default, unless repository inspection disproves it, is:

1. Build a batch prediction pipeline, not a free-running autonomous agent.
2. Use one structured routing model call as the baseline.
3. Treat image/audio understanding as bounded tools or merge them into the routing call when the selected multimodal model performs well.
4. Use deterministic TypeScript for data assembly, context selection, validation, and CSV generation.
5. Do not begin with trained ML, an LLM council, a SQL database, handcrafted routing thresholds, or production-grade infrastructure.
6. Add a council/specialized OCR/separate transcription only as an evaluation-backed experiment.
7. Use a flat-file eval history and case-level comparisons.
8. Prefer Vercel AI SDK plus the appropriate provider adapter; OpenRouter can supply model access. Do not use Cursor SDK as the inference layer.
9. Use concise repository-level agent instructions if allowed.
10. Keep runtime architecture and development-agent collaboration as separate decisions.

## 6. Questions local Codex must resolve after inspecting the repository

1. What data files and relationships actually exist, and which fields may legally influence a prediction?
2. Are any routing labels supplied? If not, how should the local gold set be created and documented?
3. What is the official scoring method, and how are `reason`, `confidence`, and `evidence_message_ids` evaluated?
4. Are media files local, URL-based, encoded, or represented only by extracted metadata?
5. Can the chosen model accept all three modalities through the intended provider without losing fidelity?
6. Does dedicated OCR or transcription improve any concrete failing cases?
7. What exactly does “deterministic where possible” mean in the official statement?
8. What files and generated artifacts may be committed or submitted?
9. Is modifying `AGENTS.md` allowed, and is an AI-development transcript required in a specific format?
10. Which existing credits can legally and technically be used for runtime inference?
11. What is the smallest end-to-end baseline that produces a valid row for every input message?

## 7. Requested next action for local Codex

Before writing implementation code:

1. Read `problem_statement.md`, `AGENTS.md`, the README, package configuration, and every dataset schema/sample.
2. Report any repository facts that contradict this handoff.
3. Produce a short implementation plan for the smallest complete baseline.
4. Identify what can be evaluated objectively with the supplied data.
5. Propose the minimal repository additions for runtime, evals, tests, and decision logging.
6. Keep all assumptions explicit and do not silently invent missing labels, relationships, or scoring rules.
