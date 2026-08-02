import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SampleMessage } from "./data.js";
import { serializePredictions } from "./contract.js";
import {
  MAX_REASON_CHARACTERS,
  PredictionRowSchema,
  type PredictionRow,
} from "./domain.js";

export type SampleSet = "provided" | "counterfactual";

type EvidenceEvaluation = {
  referenceAvailable: boolean;
  expectedMessageIds: string[];
  predictedMessageIds: string[];
  intersectionCount: number;
  exactSetMatch: boolean;
  precision: number | null;
  recall: number | null;
  f1: number | null;
};

type ReasonStyleEvaluation = {
  characters: number;
  atMost200Characters: boolean;
  terminalPunctuation: boolean;
  noLineBreaks: boolean;
  completeSentenceStyle: boolean;
};

export type EvaluationCase = {
  messageId: string;
  sampleSet: SampleSet;
  modality: "text" | "image" | "voice";
  expectedAction: string;
  predictedAction: string;
  actionCorrect: boolean;
  expectedMessageType: string;
  predictedMessageType: string;
  messageTypeCorrect: boolean;
  exactCorrect: boolean;
  expectedReason: string;
  predictedReason: string;
  reasonStyle: ReasonStyleEvaluation;
  evidence: EvidenceEvaluation;
  confidence: number;
  confidenceBrier: number;
};

export type SampleAggregate = {
  total: number;
  actionCorrect: number;
  messageTypeCorrect: number;
  exactCorrect: number;
  actionAccuracy: number;
  messageTypeAccuracy: number;
  exactAccuracy: number;
  evidence: {
    exactSetMatches: number;
    exactSetAccuracy: number;
    referenceAvailableCases: number;
    predictedNonemptyCases: number;
    intersectionCount: number;
    predictedCountOnReferenceCases: number;
    referenceCount: number;
    precision: number | null;
    recall: number | null;
    f1: number | null;
  };
  reasonStyle: {
    atMost200Characters: number;
    atMost200Rate: number;
    completeSentenceStyle: number;
    completeSentenceStyleRate: number;
    characters: { min: number; mean: number; max: number };
  };
  confidenceCalibration: {
    outcome: "exact_action_and_type";
    brierScore: number;
    expectedCalibrationError: number;
    bins: Array<{
      lower: number;
      upper: number;
      count: number;
      meanConfidence: number;
      exactAccuracy: number;
      gap: number;
    }>;
  };
  byModality: Record<string, { total: number; exactCorrect: number }>;
};

export type SampleEvaluation = SampleAggregate & {
  schemaVersion: 2;
  label: "illustrative_sample_regression";
  bySampleSet: Record<SampleSet, SampleAggregate>;
  limitations: {
    labels: string;
    evidence: string;
    reason: string;
    confidence: string;
  };
  cases: EvaluationCase[];
};

export type SampleProgressOutcome =
  | { status: "succeeded"; prediction: PredictionRow }
  | {
      status: "failed";
      messageId: string;
      attempt: number;
      error: { code: string; message: string };
    };

export type SampleProgress = {
  label: "illustrative_sample_progress";
  totalAvailable: number;
  attempted: number;
  technicalSucceeded: number;
  technicalFailed: number;
  remaining: number;
  evaluation: SampleEvaluation;
  failures: Array<Extract<SampleProgressOutcome, { status: "failed" }>>;
};

function sampleSetFor(messageId: string): SampleSet {
  return messageId.startsWith("cf_msg_") ? "counterfactual" : "provided";
}

function parseEvidence(value: string): string[] {
  return value === "none" ? [] : value.split(";");
}

function divide(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function nullableDivide(
  numerator: number,
  denominator: number,
): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function evaluateEvidence(expectedValue: string, predictedValue: string): EvidenceEvaluation {
  const expectedMessageIds = parseEvidence(expectedValue);
  const predictedMessageIds = parseEvidence(predictedValue);
  const expected = new Set(expectedMessageIds);
  const predicted = new Set(predictedMessageIds);
  const intersectionCount = predictedMessageIds.filter((id) => expected.has(id)).length;
  const referenceAvailable = expectedMessageIds.length > 0;
  const exactSetMatch =
    expected.size === predicted.size &&
    expectedMessageIds.every((id) => predicted.has(id));
  if (!referenceAvailable) {
    return {
      referenceAvailable,
      expectedMessageIds,
      predictedMessageIds,
      intersectionCount,
      exactSetMatch,
      precision: null,
      recall: null,
      f1: null,
    };
  }
  const precision = nullableDivide(intersectionCount, predictedMessageIds.length);
  const recall = intersectionCount / expectedMessageIds.length;
  const f1 = divide(2 * intersectionCount, predictedMessageIds.length + expectedMessageIds.length);
  return {
    referenceAvailable,
    expectedMessageIds,
    predictedMessageIds,
    intersectionCount,
    exactSetMatch,
    precision,
    recall,
    f1,
  };
}

function evaluateReasonStyle(reason: string): ReasonStyleEvaluation {
  const characters = [...reason].length;
  const terminalPunctuation = /[.!?]["')\]]?$/.test(reason.trim());
  const noLineBreaks = !/[\r\n]/.test(reason);
  return {
    characters,
    atMost200Characters: characters <= MAX_REASON_CHARACTERS,
    terminalPunctuation,
    noLineBreaks,
    completeSentenceStyle: terminalPunctuation && noLineBreaks,
  };
}

function aggregateCases(cases: readonly EvaluationCase[]): SampleAggregate {
  const total = cases.length;
  const actionCorrect = cases.filter((item) => item.actionCorrect).length;
  const messageTypeCorrect = cases.filter((item) => item.messageTypeCorrect).length;
  const exactCorrect = cases.filter((item) => item.exactCorrect).length;
  const byModality: SampleAggregate["byModality"] = {};
  for (const item of cases) {
    const bucket = byModality[item.modality] ?? { total: 0, exactCorrect: 0 };
    bucket.total += 1;
    bucket.exactCorrect += Number(item.exactCorrect);
    byModality[item.modality] = bucket;
  }

  const evidenceReferenceCases = cases.filter((item) => item.evidence.referenceAvailable);
  const intersectionCount = evidenceReferenceCases.reduce(
    (sum, item) => sum + item.evidence.intersectionCount,
    0,
  );
  const predictedCountOnReferenceCases = evidenceReferenceCases.reduce(
    (sum, item) => sum + item.evidence.predictedMessageIds.length,
    0,
  );
  const referenceCount = evidenceReferenceCases.reduce(
    (sum, item) => sum + item.evidence.expectedMessageIds.length,
    0,
  );
  const reasonLengths = cases.map((item) => item.reasonStyle.characters);

  const bins: SampleAggregate["confidenceCalibration"]["bins"] = [];
  let expectedCalibrationError = 0;
  for (let index = 0; index < 5; index += 1) {
    const lower = index / 5;
    const upper = (index + 1) / 5;
    const members = cases.filter((item) => {
      if (index === 4) return item.confidence >= lower && item.confidence <= upper;
      return item.confidence >= lower && item.confidence < upper;
    });
    const meanConfidence = divide(
      members.reduce((sum, item) => sum + item.confidence, 0),
      members.length,
    );
    const binExactAccuracy = divide(
      members.filter((item) => item.exactCorrect).length,
      members.length,
    );
    const gap = members.length === 0 ? 0 : Math.abs(meanConfidence - binExactAccuracy);
    expectedCalibrationError += divide(members.length, total) * gap;
    bins.push({
      lower,
      upper,
      count: members.length,
      meanConfidence,
      exactAccuracy: binExactAccuracy,
      gap,
    });
  }

  return {
    total,
    actionCorrect,
    messageTypeCorrect,
    exactCorrect,
    actionAccuracy: divide(actionCorrect, total),
    messageTypeAccuracy: divide(messageTypeCorrect, total),
    exactAccuracy: divide(exactCorrect, total),
    evidence: {
      exactSetMatches: cases.filter((item) => item.evidence.exactSetMatch).length,
      exactSetAccuracy: divide(
        cases.filter((item) => item.evidence.exactSetMatch).length,
        total,
      ),
      referenceAvailableCases: evidenceReferenceCases.length,
      predictedNonemptyCases: cases.filter(
        (item) => item.evidence.predictedMessageIds.length > 0,
      ).length,
      intersectionCount,
      predictedCountOnReferenceCases,
      referenceCount,
      precision: nullableDivide(intersectionCount, predictedCountOnReferenceCases),
      recall: nullableDivide(intersectionCount, referenceCount),
      f1: nullableDivide(2 * intersectionCount, predictedCountOnReferenceCases + referenceCount),
    },
    reasonStyle: {
      atMost200Characters: cases.filter(
        (item) => item.reasonStyle.atMost200Characters,
      ).length,
      atMost200Rate: divide(
        cases.filter((item) => item.reasonStyle.atMost200Characters).length,
        total,
      ),
      completeSentenceStyle: cases.filter(
        (item) => item.reasonStyle.completeSentenceStyle,
      ).length,
      completeSentenceStyleRate: divide(
        cases.filter((item) => item.reasonStyle.completeSentenceStyle).length,
        total,
      ),
      characters: {
        min: reasonLengths.length === 0 ? 0 : Math.min(...reasonLengths),
        mean: divide(reasonLengths.reduce((sum, length) => sum + length, 0), total),
        max: reasonLengths.length === 0 ? 0 : Math.max(...reasonLengths),
      },
    },
    confidenceCalibration: {
      outcome: "exact_action_and_type",
      brierScore: divide(
        cases.reduce((sum, item) => sum + item.confidenceBrier, 0),
        total,
      ),
      expectedCalibrationError,
      bins,
    },
    byModality,
  };
}

export function evaluateSamples(
  samples: readonly SampleMessage[],
  predictionRows: readonly unknown[],
): SampleEvaluation {
  if (samples.length !== predictionRows.length) {
    throw new Error(
      `Expected ${samples.length} sample predictions, received ${predictionRows.length}`,
    );
  }

  const cases = samples.map<EvaluationCase>((sample, index) => {
    const prediction = PredictionRowSchema.parse(predictionRows[index]);
    if (prediction.message_id !== sample.message_id) {
      throw new Error(
        `Sample row ${index + 1} must be ${sample.message_id}, got ${prediction.message_id}`,
      );
    }
    const actionCorrect = prediction.action === sample.action;
    const messageTypeCorrect = prediction.message_type === sample.message_type;
    const exactCorrect = actionCorrect && messageTypeCorrect;
    const confidenceBrier = (prediction.confidence - Number(exactCorrect)) ** 2;
    return {
      messageId: sample.message_id,
      sampleSet: sampleSetFor(sample.message_id),
      modality: sample.media_type ?? "text",
      expectedAction: sample.action,
      predictedAction: prediction.action,
      actionCorrect,
      expectedMessageType: sample.message_type,
      predictedMessageType: prediction.message_type,
      messageTypeCorrect,
      exactCorrect,
      expectedReason: sample.reason,
      predictedReason: prediction.reason,
      reasonStyle: evaluateReasonStyle(prediction.reason),
      evidence: evaluateEvidence(
        sample.evidence_message_ids,
        prediction.evidence_message_ids,
      ),
      confidence: prediction.confidence,
      confidenceBrier,
    };
  });
  const aggregate = aggregateCases(cases);
  return {
    schemaVersion: 2,
    label: "illustrative_sample_regression",
    ...aggregate,
    bySampleSet: {
      provided: aggregateCases(cases.filter((item) => item.sampleSet === "provided")),
      counterfactual: aggregateCases(
        cases.filter((item) => item.sampleSet === "counterfactual"),
      ),
    },
    limitations: {
      labels: "Provided and curated labels are illustrative, not organizer ground truth.",
      evidence: "Evidence overlap compares one reference set; other historical IDs may also be relevant.",
      reason: "Reason metrics cover length and sentence style only; semantic usefulness needs human or judge review.",
      confidence: "Calibration is measured against illustrative exact action-and-type outcomes on this small set.",
    },
    cases,
  };
}

export function makeDeliberatelyWrongSamplePredictions(
  samples: readonly SampleMessage[],
): PredictionRow[] {
  const nextAction = { notify: "digest", digest: "mute", mute: "notify" } as const;
  const typeCycle = [
    "personal",
    "urgent",
    "event",
    "payment",
    "business_update",
    "promotion",
    "greeting",
    "forward",
    "spam",
    "scam",
    "unknown",
  ] as const;
  return samples.map((sample) => {
    const currentIndex = typeCycle.indexOf(sample.message_type);
    const messageType = typeCycle[(currentIndex + 1) % typeCycle.length] ?? "unknown";
    return PredictionRowSchema.parse({
      message_id: sample.message_id,
      action: nextAction[sample.action],
      message_type: messageType,
      reason: "Seeded evaluator self-check; not a routing judgement.",
      confidence: 0,
      evidence_message_ids: "none",
    });
  });
}

type EvaluationManifest = {
  schemaVersion: 1;
  runId: string;
  createdAt: string;
  label: "illustrative_sample_regression";
  datasetFingerprint: string;
  strategy: "seed_all_wrong";
  notes: string;
};

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, filePath);
}

function escapeMarkdown(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function percentage(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function optionalPercentage(value: number | null): string {
  return value === null ? "n/a" : percentage(value);
}

function renderMetricTable(evaluation: SampleEvaluation): string {
  const rows = (
    [
      ["Provided samples", evaluation.bySampleSet.provided],
      ["Curated counterfactuals", evaluation.bySampleSet.counterfactual],
      ["Augmented total", evaluation],
    ] as const
  )
    .map(
      ([name, metrics]) =>
        `| ${name} | ${metrics.total} | ${metrics.actionCorrect}/${metrics.total} (${percentage(metrics.actionAccuracy)}) | ${metrics.messageTypeCorrect}/${metrics.total} (${percentage(metrics.messageTypeAccuracy)}) | ${metrics.exactCorrect}/${metrics.total} (${percentage(metrics.exactAccuracy)}) | ${metrics.evidence.exactSetMatches}/${metrics.total} (${percentage(metrics.evidence.exactSetAccuracy)}) | ${optionalPercentage(metrics.evidence.f1)} | ${metrics.reasonStyle.completeSentenceStyle}/${metrics.total} | ${metrics.confidenceCalibration.brierScore.toFixed(4)} |`,
    )
    .join("\n");
  return `| Set | Cases | Action | Type | Exact pair | Evidence exact set | Evidence reference F1 | Reason style | Confidence Brier ↓ |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${rows}`;
}

function renderCaseTable(evaluation: SampleEvaluation): string {
  return evaluation.cases
    .map(
      (item) =>
        `| ${escapeMarkdown(item.messageId)} | ${item.sampleSet} | ${item.modality} | ${item.expectedAction}/${item.expectedMessageType} | ${item.predictedAction}/${item.predictedMessageType} | ${item.exactCorrect ? "pass" : "fail"} | ${item.evidence.exactSetMatch ? "pass" : "fail"} | ${item.reasonStyle.completeSentenceStyle ? `${item.reasonStyle.characters} chars` : "style fail"} | ${item.confidence.toFixed(2)} |`,
    )
    .join("\n");
}

function renderReasonAndEvidenceDetails(evaluation: SampleEvaluation): string {
  return evaluation.cases
    .map(
      (item) => `### ${escapeMarkdown(item.messageId)}

- Expected decision: \`${item.expectedAction} / ${item.expectedMessageType}\`
- Predicted decision: \`${item.predictedAction} / ${item.predictedMessageType}\`
- Expected evidence: \`${escapeMarkdown(item.evidence.expectedMessageIds.join(";") || "none")}\`
- Predicted evidence: \`${escapeMarkdown(item.evidence.predictedMessageIds.join(";") || "none")}\`
- Evidence reference F1: ${item.evidence.f1 === null ? "n/a (reference is none)" : item.evidence.f1.toFixed(3)}
- Expected reason: ${escapeMarkdown(item.expectedReason)}
- Predicted reason: ${escapeMarkdown(item.predictedReason)}`,
    )
    .join("\n\n");
}

function renderEvaluationReport(
  manifest: EvaluationManifest,
  evaluation: SampleEvaluation,
): string {
  return `# Evaluation ${manifest.runId}

This is an **illustrative local regression**, not organizer ground truth and not training data. The curated counterfactual labels are indicative and may be revised.

- Strategy: \`${manifest.strategy}\`
- Dataset: \`${manifest.datasetFingerprint}\`

${renderMetricTable(evaluation)}

Evidence F1 only scores cases with at least one reference ID. Evidence exact-set accuracy also tests whether \`none\` was correctly selected. Reason scoring is a structural 200-character/complete-sentence proxy; semantic usefulness remains a manual or model-judge review. Confidence Brier uses exact action + type as the outcome.

| Message | Set | Modality | Expected | Predicted | Exact | Evidence set | Reason | Confidence |
| --- | --- | --- | --- | --- | --- | --- | --- | ---: |
${renderCaseTable(evaluation)}
`;
}

function htmlEscape(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function rebuildEvaluationHistory(evalRunsDir: string): Promise<void> {
  const entries = await readdir(evalRunsDir, { withFileTypes: true });
  const runs: Array<{ manifest: EvaluationManifest; metrics: SampleEvaluation }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const runDir = path.join(evalRunsDir, entry.name);
      runs.push({
        manifest: JSON.parse(
          await readFile(path.join(runDir, "manifest.json"), "utf8"),
        ) as EvaluationManifest,
        metrics: JSON.parse(
          await readFile(path.join(runDir, "metrics.json"), "utf8"),
        ) as SampleEvaluation,
      });
    } catch {
      // Ignore incomplete evaluation directories.
    }
  }
  runs.sort((left, right) => right.manifest.createdAt.localeCompare(left.manifest.createdAt));
  const markdownRows = runs
    .map(
      ({ manifest, metrics }) =>
        `| ${manifest.runId} | ${manifest.createdAt} | ${manifest.strategy} | ${metrics.actionCorrect}/${metrics.total} | ${metrics.messageTypeCorrect}/${metrics.total} | ${metrics.exactCorrect}/${metrics.total} |`,
    )
    .join("\n");
  await atomicWrite(
    path.join(evalRunsDir, "history.md"),
    `# Sample Evaluation History

These metrics are illustrative regressions over the sample cases loaded by each run. Totals may differ after fixture augmentation.

| Run | Created | Strategy | Action | Type | Exact |
| --- | --- | --- | --- | --- | --- |
${markdownRows}
`,
  );
  const sections = runs
    .map(
      ({ manifest, metrics }) => `<section><h2>${htmlEscape(manifest.runId)}</h2><p>${htmlEscape(manifest.notes)}</p><div class="cards"><div><strong>${metrics.actionCorrect}/${metrics.total}</strong><span>Action correct</span></div><div><strong>${metrics.messageTypeCorrect}/${metrics.total}</strong><span>Type correct</span></div><div><strong>${metrics.exactCorrect}/${metrics.total}</strong><span>Exact</span></div></div><table><thead><tr><th>Message</th><th>Modality</th><th>Expected</th><th>Predicted</th><th>Result</th></tr></thead><tbody>${metrics.cases.map((item) => `<tr><td><code>${htmlEscape(item.messageId)}</code></td><td>${item.modality}</td><td>${item.expectedAction} / ${item.expectedMessageType}</td><td>${item.predictedAction} / ${item.predictedMessageType}</td><td>${item.exactCorrect ? "pass" : "fail"}</td></tr>`).join("")}</tbody></table></section>`,
    )
    .join("");
  await atomicWrite(
    path.join(evalRunsDir, "index.html"),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sample Evaluation History</title><style>:root{color-scheme:dark;font-family:Inter,system-ui,sans-serif;background:#0b1020;color:#e8ecf8}body{max-width:1100px;margin:auto;padding:32px}section{background:#121a2f;border:1px solid #26314d;border-radius:14px;padding:24px;margin:24px 0}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.cards div{background:#0b1020;padding:16px;border-radius:10px}.cards strong,.cards span{display:block}.cards strong{font-size:1.7rem}.cards span{color:#9ba8c7}table{width:100%;border-collapse:collapse;margin-top:20px}th,td{text-align:left;padding:9px;border-bottom:1px solid #26314d}code{overflow-wrap:anywhere}</style></head><body><h1>Sample Evaluation History</h1><p>Illustrative regression only; not organizer ground truth or training data. <a href="../runs/index.html">Target run history</a></p>${sections}</body></html>`,
  );
}

export async function createSeedSampleEvaluation(args: {
  samples: readonly SampleMessage[];
  evalRunsDir: string;
  runId: string;
  datasetFingerprint: string;
}): Promise<SampleEvaluation> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(args.runId)) {
    throw new Error(`Unsafe evaluation run ID: ${args.runId}`);
  }
  const predictions = makeDeliberatelyWrongSamplePredictions(args.samples);
  const evaluation = evaluateSamples(args.samples, predictions);
  if (
    evaluation.actionCorrect !== 0 ||
    evaluation.messageTypeCorrect !== 0 ||
    evaluation.exactCorrect !== 0
  ) {
    throw new Error("Seeded evaluator self-check was expected to fail every action and type");
  }
  const manifest: EvaluationManifest = {
    schemaVersion: 1,
    runId: args.runId,
    createdAt: new Date().toISOString(),
    label: "illustrative_sample_regression",
    datasetFingerprint: args.datasetFingerprint,
    strategy: "seed_all_wrong",
    notes: "Deliberately wrong predictions prove the evaluator reports regressions.",
  };
  const evalRunsDir = path.resolve(args.evalRunsDir);
  const runDir = path.join(evalRunsDir, args.runId);
  await mkdir(runDir, { recursive: true });
  try {
    const existingManifest = JSON.parse(
      await readFile(path.join(runDir, "manifest.json"), "utf8"),
    ) as EvaluationManifest;
    if (
      existingManifest.datasetFingerprint !== args.datasetFingerprint ||
      existingManifest.strategy !== "seed_all_wrong"
    ) {
      throw new Error(`Cannot reuse evaluation run ${args.runId}: configuration changed`);
    }
    const existingMetrics = JSON.parse(
      await readFile(path.join(runDir, "metrics.json"), "utf8"),
    ) as SampleEvaluation;
    await rebuildEvaluationHistory(evalRunsDir);
    return existingMetrics;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await atomicWrite(path.join(runDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await atomicWrite(path.join(runDir, "predictions.csv"), serializePredictions(predictions));
  await atomicWrite(path.join(runDir, "metrics.json"), `${JSON.stringify(evaluation, null, 2)}\n`);
  await atomicWrite(path.join(runDir, "report.md"), renderEvaluationReport(manifest, evaluation));
  await rebuildEvaluationHistory(evalRunsDir);
  return evaluation;
}

export async function writeSampleRunEvaluation(args: {
  samples: readonly SampleMessage[];
  predictions: readonly PredictionRow[];
  runDir: string;
}): Promise<SampleEvaluation> {
  const evaluation = evaluateSamples(args.samples, args.predictions);
  const runDir = path.resolve(args.runDir);
  await mkdir(runDir, { recursive: true });
  await atomicWrite(
    path.join(runDir, "sample-predictions.csv"),
    serializePredictions(args.predictions),
  );
  await atomicWrite(
    path.join(runDir, "sample-metrics.json"),
    `${JSON.stringify(evaluation, null, 2)}\n`,
  );
  await atomicWrite(
    path.join(runDir, "sample-report.md"),
    `# Provider sample evaluation

This is an **illustrative local regression**, evaluated only after inference. Sample labels were not included in provider prompts. The 16 curated counterfactual labels are indicative and may be revised.

${renderMetricTable(evaluation)}

Evidence F1 only scores cases with at least one reference ID. Evidence exact-set accuracy also tests whether \`none\` was correctly selected. Reason scoring is a structural 200-character/complete-sentence proxy; semantic usefulness remains a manual or model-judge review. Confidence Brier uses exact action + type as the outcome.

| Message | Set | Modality | Expected | Predicted | Exact | Evidence set | Reason | Confidence |
| --- | --- | --- | --- | --- | --- | --- | --- | ---: |
${renderCaseTable(evaluation)}

## Reason and evidence comparison

${renderReasonAndEvidenceDetails(evaluation)}
`,
  );
  return evaluation;
}

export async function writeSampleRunProgress(args: {
  samples: readonly SampleMessage[];
  outcomes: readonly SampleProgressOutcome[];
  runDir: string;
}): Promise<SampleProgress> {
  const sampleById = new Map(args.samples.map((sample) => [sample.message_id, sample]));
  const successful = args.outcomes.filter(
    (outcome): outcome is Extract<SampleProgressOutcome, { status: "succeeded" }> =>
      outcome.status === "succeeded",
  );
  const failures = args.outcomes.filter(
    (outcome): outcome is Extract<SampleProgressOutcome, { status: "failed" }> =>
      outcome.status === "failed",
  );
  const successfulSamples = successful.map((outcome) => {
    const sample = sampleById.get(outcome.prediction.message_id);
    if (!sample) throw new Error(`Unknown sample progress ID: ${outcome.prediction.message_id}`);
    return sample;
  });
  for (const failure of failures) {
    if (!sampleById.has(failure.messageId)) {
      throw new Error(`Unknown sample progress ID: ${failure.messageId}`);
    }
  }
  const evaluation = evaluateSamples(
    successfulSamples,
    successful.map((outcome) => outcome.prediction),
  );
  const progress: SampleProgress = {
    label: "illustrative_sample_progress",
    totalAvailable: args.samples.length,
    attempted: args.outcomes.length,
    technicalSucceeded: successful.length,
    technicalFailed: failures.length,
    remaining: args.samples.length - args.outcomes.length,
    evaluation,
    failures,
  };
  const outcomeById = new Map(
    args.outcomes.map((outcome) => [
      outcome.status === "succeeded"
        ? outcome.prediction.message_id
        : outcome.messageId,
      outcome,
    ]),
  );
  const sections = args.samples
    .filter((sample) => outcomeById.has(sample.message_id))
    .map((sample) => {
      const outcome = outcomeById.get(sample.message_id) as SampleProgressOutcome;
      if (outcome.status === "failed") {
        return `## ${escapeMarkdown(sample.message_id)} — technical failure

- Expected: \`${sample.action} / ${sample.message_type}\`
- Attempt: ${outcome.attempt}
- Error: \`${escapeMarkdown(outcome.error.code)}\` — ${escapeMarkdown(outcome.error.message)}`;
      }
      const prediction = outcome.prediction;
      const exact =
        prediction.action === sample.action &&
        prediction.message_type === sample.message_type;
      return `## ${escapeMarkdown(sample.message_id)} — ${exact ? "exact match" : "semantic mismatch"}

- Expected: \`${sample.action} / ${sample.message_type}\`
- Predicted: \`${prediction.action} / ${prediction.message_type}\`
- Confidence: ${prediction.confidence}
- Evidence: \`${escapeMarkdown(prediction.evidence_message_ids)}\`
- Reason: ${escapeMarkdown(prediction.reason)}`;
    })
    .join("\n\n");
  const runDir = path.resolve(args.runDir);
  await mkdir(runDir, { recursive: true });
  await atomicWrite(
    path.join(runDir, "sample-progress.json"),
    `${JSON.stringify(progress, null, 2)}\n`,
  );
  await atomicWrite(
    path.join(runDir, "sample-progress.md"),
    `# Provider sample progress

This is an **illustrative partial regression**, evaluated only after inference. Sample labels were not included in provider prompts. Accuracy below uses technically successful predictions only; failures are reported separately.

- Attempted: ${progress.attempted}/${progress.totalAvailable}
- Technical success: ${progress.technicalSucceeded}/${progress.attempted}
- Technical failure: ${progress.technicalFailed}/${progress.attempted}

${renderMetricTable(evaluation)}

Evidence and confidence metrics use only technically successful cases. Reason style is structural, not a semantic usefulness score.

${sections}
`,
  );
  return progress;
}
