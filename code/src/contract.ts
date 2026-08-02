import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "csv-parse/sync";
import {
  MAX_EVIDENCE_MESSAGES,
  OUTPUT_HEADERS,
  PredictionRowSchema,
  type PredictionRow,
} from "./domain.js";
import { buildContext, type DatasetIndex } from "./data.js";

function parseEvidence(value: string): string[] {
  if (value === "none") return [];
  const ids = value.split(";");
  if (ids.some((id) => id.trim() === "" || id !== id.trim())) {
    throw new Error(`Invalid evidence_message_ids value: ${value}`);
  }
  if (new Set(ids).size !== ids.length) {
    throw new Error(`Duplicate evidence_message_ids value: ${value}`);
  }
  if (ids.length > MAX_EVIDENCE_MESSAGES) {
    throw new Error(
      `evidence_message_ids may contain at most ${MAX_EVIDENCE_MESSAGES} IDs`,
    );
  }
  return ids;
}

export function validatePredictionSet(
  index: DatasetIndex,
  rows: readonly unknown[],
): PredictionRow[] {
  if (rows.length !== index.dataset.messages.length) {
    throw new Error(
      `Expected ${index.dataset.messages.length} predictions, received ${rows.length}`,
    );
  }

  const seen = new Set<string>();
  const parsed = rows.map((row, position) => {
    const prediction = PredictionRowSchema.parse(row);
    const expected = index.dataset.messages[position];
    if (!expected || prediction.message_id !== expected.message_id) {
      throw new Error(
        `Prediction row ${position + 1} must be ${expected?.message_id ?? "<none>"}, got ${prediction.message_id}`,
      );
    }
    if (seen.has(prediction.message_id)) {
      throw new Error(`Duplicate prediction: ${prediction.message_id}`);
    }
    seen.add(prediction.message_id);

    const eligibleEvidence = new Set(
      buildContext(index, expected).prior.map((prior) => prior.message.message_id),
    );
    for (const evidenceId of parseEvidence(prediction.evidence_message_ids)) {
      if (!eligibleEvidence.has(evidenceId)) {
        throw new Error(
          `${prediction.message_id}: evidence ${evidenceId} is not same-user history before the target`,
        );
      }
    }
    return prediction;
  });

  return parsed;
}

function escapeCsv(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function serializePredictions(rows: readonly PredictionRow[]): string {
  const lines = [OUTPUT_HEADERS.join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.message_id,
        row.action,
        row.message_type,
        row.reason,
        row.confidence,
        row.evidence_message_ids,
      ]
        .map(escapeCsv)
        .join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

export async function parsePredictionCsv(filePath: string): Promise<unknown[]> {
  const input = await readFile(filePath, "utf8");
  let actualHeaders: string[] = [];
  const rows = parse(input, {
    bom: true,
    columns: (headers: string[]) => {
      actualHeaders = headers;
      return headers;
    },
    skip_empty_lines: true,
  }) as unknown[];
  if (actualHeaders.join("\0") !== OUTPUT_HEADERS.join("\0")) {
    throw new Error(
      `Prediction headers must be ${OUTPUT_HEADERS.join(",")}; got ${actualHeaders.join(",")}`,
    );
  }
  return rows;
}

export async function writeValidatedOutput(args: {
  index: DatasetIndex;
  rows: readonly unknown[];
  outputPath: string;
}): Promise<void> {
  const validated = validatePredictionSet(args.index, args.rows);
  const outputPath = path.resolve(args.outputPath);
  const temporaryPath = `${outputPath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, serializePredictions(validated), "utf8");
  await rename(temporaryPath, outputPath);
}
