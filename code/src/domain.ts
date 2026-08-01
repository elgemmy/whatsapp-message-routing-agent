import { z } from "zod";

export const ACTIONS = ["notify", "digest", "mute"] as const;
export const MESSAGE_TYPES = [
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

export const ActionSchema = z.enum(ACTIONS);
export const MessageTypeSchema = z.enum(MESSAGE_TYPES);

export type Action = z.infer<typeof ActionSchema>;
export type MessageType = z.infer<typeof MessageTypeSchema>;

export const DecisionSchema = z
  .object({
    action: ActionSchema,
    messageType: MessageTypeSchema,
    reason: z.string().trim().min(1),
    confidence: z.number().finite().min(0).max(1),
    evidenceMessageIds: z.array(z.string().trim().min(1)),
  })
  .strict();

export type Decision = z.infer<typeof DecisionSchema>;

export const RawDecisionSchema = z
  .object({
    action: z.string(),
    messageType: z.string(),
    reason: z.string(),
    confidence: z.number(),
    evidenceMessageIds: z.array(z.string()),
  })
  .strict();

export type NormalizedDecision = {
  decision: Decision;
  rawMessageType: string;
  usedUnknownFallback: boolean;
};

export function normalizeMessageType(raw: string): MessageType {
  const normalized = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  const parsed = MessageTypeSchema.safeParse(normalized);
  return parsed.success ? parsed.data : "unknown";
}

export function normalizeRawDecision(raw: unknown): NormalizedDecision {
  const parsed = RawDecisionSchema.parse(raw);
  const normalizedAction = parsed.action.trim().toLowerCase();
  const action = ActionSchema.parse(normalizedAction);
  const messageType = normalizeMessageType(parsed.messageType);
  return {
    decision: DecisionSchema.parse({ ...parsed, action, messageType }),
    rawMessageType: parsed.messageType,
    usedUnknownFallback:
      messageType === "unknown" &&
      parsed.messageType.trim().toLowerCase() !== "unknown",
  };
}

export const OUTPUT_HEADERS = [
  "message_id",
  "action",
  "message_type",
  "reason",
  "confidence",
  "evidence_message_ids",
] as const;

const CsvConfidenceSchema = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z.coerce.number().finite().min(0).max(1),
);

export const PredictionRowSchema = z
  .object({
    message_id: z.string().min(1),
    action: ActionSchema,
    message_type: MessageTypeSchema,
    reason: z.string().trim().min(1),
    confidence: CsvConfidenceSchema,
    evidence_message_ids: z.string().min(1),
  })
  .strict();

export type PredictionRow = z.infer<typeof PredictionRowSchema>;

export function decisionToPrediction(
  messageId: string,
  decision: Decision,
): PredictionRow {
  return PredictionRowSchema.parse({
    message_id: messageId,
    action: decision.action,
    message_type: decision.messageType,
    reason: decision.reason,
    confidence: decision.confidence,
    evidence_message_ids:
      decision.evidenceMessageIds.length === 0
        ? "none"
        : decision.evidenceMessageIds.join(";"),
  });
}
