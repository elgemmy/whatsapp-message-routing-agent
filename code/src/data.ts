import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { z } from "zod";
import {
  inspectMedia,
  resolveDatasetFile,
  type MediaInspection,
} from "./media.js";

const requiredText = z.string().min(1);
const nullableText = z.preprocess(
  (value) => (value === "" ? null : value),
  z.string().min(1).nullable(),
);
const requiredInteger = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z.coerce.number().int(),
);
export const RequiredNonnegativeIntegerSchema = requiredInteger.pipe(
  z.number().int().nonnegative(),
);
export const RequiredBinarySchema = requiredInteger
  .pipe(z.number().int().min(0).max(1))
  .transform((value) => value as 0 | 1);
const integer = requiredInteger;
const nonnegativeInteger = RequiredNonnegativeIntegerSchema;
const binary = RequiredBinarySchema;
const timestamp = z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const requiredConfidence = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z.coerce.number().finite().min(0).max(1),
);
const ConversationTypeSchema = z.enum(["personal", "group", "business"]);
const MediaTypeSchema = z.preprocess(
  (value) => (value === "" ? null : value),
  z.enum(["image", "voice"]).nullable(),
);

const MessageSchema = z
  .object({
    message_id: requiredText,
    user_id: requiredText,
    conversation_type: ConversationTypeSchema,
    group_id: nullableText,
    business_id: nullableText,
    sender_user_id: nullableText,
    created_at: timestamp,
    message_text: z.string(),
    media_type: MediaTypeSchema,
    media_id: nullableText,
    forwarded_count: nonnegativeInteger,
  })
  .strict();

const UserSchema = z
  .object({
    user_id: requiredText,
    do_not_disturb_window: requiredText,
    messages_opened_30d: nonnegativeInteger,
    messages_replied_30d: nonnegativeInteger,
    notifications_dismissed_30d: nonnegativeInteger,
    messages_reported_30d: nonnegativeInteger,
  })
  .strict();

const GroupSchema = z
  .object({
    group_id: requiredText,
    group_name: requiredText,
    group_type: requiredText,
    member_count: nonnegativeInteger,
    admin_count: nonnegativeInteger,
    created_at: date,
    messages_30d: nonnegativeInteger,
  })
  .strict();

const GroupMemberSchema = z
  .object({
    group_id: requiredText,
    user_id: requiredText,
    role: requiredText,
    joined_at: date,
    messages_sent_30d: nonnegativeInteger,
    messages_read_30d: nonnegativeInteger,
    replies_sent_30d: nonnegativeInteger,
    notifications_dismissed_30d: nonnegativeInteger,
    group_muted_by_user: binary,
  })
  .strict();

const BusinessSchema = z
  .object({
    business_id: requiredText,
    display_name: requiredText,
    brand_name: requiredText,
    category: requiredText,
    verified: binary,
    official_domain: nullableText,
    domain_used_by_sender: nullableText,
    account_age_days: nonnegativeInteger,
    messages_sent_30d: nonnegativeInteger,
    user_reports_30d: nonnegativeInteger,
    domain_used_by_sender_age_days: nonnegativeInteger,
  })
  .strict();

const UserBusinessHistorySchema = z
  .object({
    user_id: requiredText,
    business_id: requiredText,
    why_user_knows_account: requiredText,
    last_activity_at: timestamp,
    allows_promotions: binary,
    promotions_opted_out_at: z.preprocess(
      (value) => (value === "" ? null : value),
      timestamp.nullable(),
    ),
    activity_count_180d: nonnegativeInteger,
    messages_opened_30d: nonnegativeInteger,
    messages_dismissed_30d: nonnegativeInteger,
    messages_replied_30d: nonnegativeInteger,
    last_reply_at: z.preprocess(
      (value) => (value === "" ? null : value),
      timestamp.nullable(),
    ),
  })
  .strict();

const MessageEventSchema = z
  .object({
    user_id: requiredText,
    message_id: requiredText,
    message_opened: binary,
    message_replied: binary,
    reaction_time_minutes: z.preprocess(
      (value) => (value === "" ? null : value),
      nonnegativeInteger.nullable(),
    ),
    notification_dismissed: binary,
    muted_after_message: binary,
    message_reported: binary,
  })
  .strict();

const DailySummarySchema = z
  .object({
    user_id: requiredText,
    date,
    notifications_sent: nonnegativeInteger,
    notifications_dismissed: nonnegativeInteger,
  })
  .strict();

const ImageSchema = z
  .object({ image_id: requiredText, file_path: requiredText })
  .strict();
const VoiceSchema = z
  .object({ voice_note_id: requiredText, file_path: requiredText })
  .strict();

const SampleMessageSchema = MessageSchema.extend({
  action: z.enum(["notify", "digest", "mute"]),
  message_type: z.enum([
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
  ]),
  reason: requiredText,
  confidence: requiredConfidence,
  evidence_message_ids: requiredText,
}).strict();

const OutputTemplateSchema = z
  .object({
    message_id: requiredText,
    action: z.string(),
    message_type: z.string(),
    reason: z.string(),
    confidence: z.string(),
    evidence_message_ids: z.string(),
  })
  .strict();

export type Message = z.infer<typeof MessageSchema>;
export type User = z.infer<typeof UserSchema>;
export type Group = z.infer<typeof GroupSchema>;
export type GroupMember = z.infer<typeof GroupMemberSchema>;
export type Business = z.infer<typeof BusinessSchema>;
export type UserBusinessHistory = z.infer<typeof UserBusinessHistorySchema>;
export type MessageEvent = z.infer<typeof MessageEventSchema>;
export type DailySummary = z.infer<typeof DailySummarySchema>;
export type SampleMessage = z.infer<typeof SampleMessageSchema>;

export const DATA_FILES = {
  messages: [
    "messages.csv",
    MessageSchema,
    [
      "message_id",
      "user_id",
      "conversation_type",
      "group_id",
      "business_id",
      "sender_user_id",
      "created_at",
      "message_text",
      "media_type",
      "media_id",
      "forwarded_count",
    ],
  ],
  samples: [
    "sample_messages.csv",
    SampleMessageSchema,
    [
      "message_id",
      "user_id",
      "conversation_type",
      "group_id",
      "business_id",
      "sender_user_id",
      "created_at",
      "message_text",
      "media_type",
      "media_id",
      "forwarded_count",
      "action",
      "message_type",
      "reason",
      "confidence",
      "evidence_message_ids",
    ],
  ],
  users: [
    "users.csv",
    UserSchema,
    [
      "user_id",
      "do_not_disturb_window",
      "messages_opened_30d",
      "messages_replied_30d",
      "notifications_dismissed_30d",
      "messages_reported_30d",
    ],
  ],
  groups: [
    "groups.csv",
    GroupSchema,
    [
      "group_id",
      "group_name",
      "group_type",
      "member_count",
      "admin_count",
      "created_at",
      "messages_30d",
    ],
  ],
  groupMembers: [
    "group_members.csv",
    GroupMemberSchema,
    [
      "group_id",
      "user_id",
      "role",
      "joined_at",
      "messages_sent_30d",
      "messages_read_30d",
      "replies_sent_30d",
      "notifications_dismissed_30d",
      "group_muted_by_user",
    ],
  ],
  businesses: [
    "business_accounts.csv",
    BusinessSchema,
    [
      "business_id",
      "display_name",
      "brand_name",
      "category",
      "verified",
      "official_domain",
      "domain_used_by_sender",
      "account_age_days",
      "messages_sent_30d",
      "user_reports_30d",
      "domain_used_by_sender_age_days",
    ],
  ],
  userBusinessHistory: [
    "user_business_history.csv",
    UserBusinessHistorySchema,
    [
      "user_id",
      "business_id",
      "why_user_knows_account",
      "last_activity_at",
      "allows_promotions",
      "promotions_opted_out_at",
      "activity_count_180d",
      "messages_opened_30d",
      "messages_dismissed_30d",
      "messages_replied_30d",
      "last_reply_at",
    ],
  ],
  history: [
    "message_history.csv",
    MessageSchema,
    [
      "message_id",
      "user_id",
      "conversation_type",
      "group_id",
      "business_id",
      "sender_user_id",
      "created_at",
      "message_text",
      "media_type",
      "media_id",
      "forwarded_count",
    ],
  ],
  events: [
    "message_events.csv",
    MessageEventSchema,
    [
      "user_id",
      "message_id",
      "message_opened",
      "message_replied",
      "reaction_time_minutes",
      "notification_dismissed",
      "muted_after_message",
      "message_reported",
    ],
  ],
  daily: [
    "daily_notification_summary.csv",
    DailySummarySchema,
    ["user_id", "date", "notifications_sent", "notifications_dismissed"],
  ],
  images: ["images.csv", ImageSchema, ["image_id", "file_path"]],
  voices: ["voice_notes.csv", VoiceSchema, ["voice_note_id", "file_path"]],
  output: [
    "output.csv",
    OutputTemplateSchema,
    [
      "message_id",
      "action",
      "message_type",
      "reason",
      "confidence",
      "evidence_message_ids",
    ],
  ],
} as const;

async function parseCsvFile<T>(args: {
  filePath: string;
  expectedHeaders: readonly string[];
  schema: z.ZodType<T>;
}): Promise<T[]> {
  const input = await readFile(args.filePath, "utf8");
  let actualHeaders: string[] = [];
  const records = parse(input, {
    bom: true,
    columns: (headers: string[]) => {
      actualHeaders = headers;
      return headers;
    },
    skip_empty_lines: true,
  }) as unknown[];

  if (actualHeaders.join("\0") !== args.expectedHeaders.join("\0")) {
    throw new Error(
      `${path.basename(args.filePath)} headers differ: expected ${args.expectedHeaders.join(",")}; got ${actualHeaders.join(",")}`,
    );
  }

  return records.map((record, index) => {
    const parsed = args.schema.safeParse(record);
    if (!parsed.success) {
      throw new Error(
        `${path.basename(args.filePath)} row ${index + 2} is invalid: ${z.prettifyError(parsed.error)}`,
      );
    }
    return parsed.data;
  });
}

export type Dataset = {
  root: string;
  messages: Message[];
  samples: SampleMessage[];
  users: User[];
  groups: Group[];
  groupMembers: GroupMember[];
  businesses: Business[];
  userBusinessHistory: UserBusinessHistory[];
  history: Message[];
  events: MessageEvent[];
  daily: DailySummary[];
  images: Array<z.infer<typeof ImageSchema>>;
  voices: Array<z.infer<typeof VoiceSchema>>;
  output: Array<z.infer<typeof OutputTemplateSchema>>;
};

export async function loadDataset(datasetRoot: string): Promise<Dataset> {
  const root = path.resolve(datasetRoot);
  const load = <T>(
    definition: readonly [string, z.ZodType<T>, readonly string[]],
  ): Promise<T[]> =>
    parseCsvFile({
      filePath: path.join(root, definition[0]),
      schema: definition[1],
      expectedHeaders: definition[2],
    });
  const [
    messages,
    samples,
    users,
    groups,
    groupMembers,
    businesses,
    userBusinessHistory,
    history,
    events,
    daily,
    images,
    voices,
    output,
  ] = await Promise.all([
    load(DATA_FILES.messages),
    load(DATA_FILES.samples),
    load(DATA_FILES.users),
    load(DATA_FILES.groups),
    load(DATA_FILES.groupMembers),
    load(DATA_FILES.businesses),
    load(DATA_FILES.userBusinessHistory),
    load(DATA_FILES.history),
    load(DATA_FILES.events),
    load(DATA_FILES.daily),
    load(DATA_FILES.images),
    load(DATA_FILES.voices),
    load(DATA_FILES.output),
  ]);
  return {
    root,
    messages,
    samples,
    users,
    groups,
    groupMembers,
    businesses,
    userBusinessHistory,
    history,
    events,
    daily,
    images,
    voices,
    output,
  };
}

function composite(left: string, right: string): string {
  return `${left}\0${right}`;
}

function uniqueMap<T>(
  rows: readonly T[],
  keyOf: (row: T) => string,
  label: string,
): Map<string, T> {
  const result = new Map<string, T>();
  for (const row of rows) {
    const key = keyOf(row);
    if (result.has(key)) throw new Error(`Duplicate ${label}: ${key}`);
    result.set(key, row);
  }
  return result;
}

function groupedMap<T>(
  rows: readonly T[],
  keyOf: (row: T) => string,
): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const group = result.get(key) ?? [];
    group.push(row);
    result.set(key, group);
  }
  return result;
}

export type DatasetIndex = {
  dataset: Dataset;
  messagesById: Map<string, Message>;
  usersById: Map<string, User>;
  groupsById: Map<string, Group>;
  groupMembersByGroupUser: Map<string, GroupMember>;
  businessesById: Map<string, Business>;
  userBusinessByUserBusiness: Map<string, UserBusinessHistory>;
  historyById: Map<string, Message>;
  historyByUser: Map<string, Message[]>;
  eventsByUserMessage: Map<string, MessageEvent>;
  dailyByUser: Map<string, DailySummary[]>;
  mediaById: Map<string, MediaInspection>;
};

export async function buildDatasetIndex(dataset: Dataset): Promise<DatasetIndex> {
  const mediaInspections = await Promise.all([
    ...dataset.images.map((row) =>
      inspectMedia({
        datasetRoot: dataset.root,
        mediaId: row.image_id,
        kind: "image",
        relativePath: row.file_path,
      }),
    ),
    ...dataset.voices.map((row) =>
      inspectMedia({
        datasetRoot: dataset.root,
        mediaId: row.voice_note_id,
        kind: "voice",
        relativePath: row.file_path,
      }),
    ),
  ]);

  const index: DatasetIndex = {
    dataset,
    messagesById: uniqueMap(dataset.messages, (row) => row.message_id, "message ID"),
    usersById: uniqueMap(dataset.users, (row) => row.user_id, "user ID"),
    groupsById: uniqueMap(dataset.groups, (row) => row.group_id, "group ID"),
    groupMembersByGroupUser: uniqueMap(
      dataset.groupMembers,
      (row) => composite(row.group_id, row.user_id),
      "group/user membership",
    ),
    businessesById: uniqueMap(
      dataset.businesses,
      (row) => row.business_id,
      "business ID",
    ),
    userBusinessByUserBusiness: uniqueMap(
      dataset.userBusinessHistory,
      (row) => composite(row.user_id, row.business_id),
      "user/business relationship",
    ),
    historyById: uniqueMap(dataset.history, (row) => row.message_id, "history ID"),
    historyByUser: groupedMap(dataset.history, (row) => row.user_id),
    eventsByUserMessage: uniqueMap(
      dataset.events,
      (row) => composite(row.user_id, row.message_id),
      "user/message event",
    ),
    dailyByUser: groupedMap(dataset.daily, (row) => row.user_id),
    mediaById: uniqueMap(mediaInspections, (row) => row.mediaId, "media ID"),
  };
  assertDatasetIntegrity(index);
  return index;
}

function expect(errors: string[], condition: unknown, message: string): void {
  if (!condition) errors.push(message);
}

function validateMessageShape(
  row: Message,
  index: DatasetIndex,
  errors: string[],
): void {
  expect(errors, index.usersById.has(row.user_id), `${row.message_id}: unknown user`);
  if (row.conversation_type === "group") {
    expect(errors, row.group_id !== null, `${row.message_id}: group without group_id`);
    expect(errors, row.business_id === null, `${row.message_id}: group with business_id`);
    expect(errors, row.sender_user_id !== null, `${row.message_id}: group without sender`);
    if (row.group_id) {
      expect(errors, index.groupsById.has(row.group_id), `${row.message_id}: unknown group`);
      expect(
        errors,
        index.groupMembersByGroupUser.has(composite(row.group_id, row.user_id)),
        `${row.message_id}: recipient is not a group member`,
      );
    }
  } else if (row.conversation_type === "business") {
    expect(errors, row.business_id !== null, `${row.message_id}: business without business_id`);
    expect(errors, row.group_id === null, `${row.message_id}: business with group_id`);
    expect(errors, row.sender_user_id === null, `${row.message_id}: business with sender user`);
    if (row.business_id) {
      expect(
        errors,
        index.businessesById.has(row.business_id),
        `${row.message_id}: unknown business`,
      );
    }
  } else {
    expect(errors, row.group_id === null, `${row.message_id}: personal with group_id`);
    expect(errors, row.business_id === null, `${row.message_id}: personal with business_id`);
    expect(errors, row.sender_user_id !== null, `${row.message_id}: personal without sender`);
  }

  expect(
    errors,
    (row.media_type === null) === (row.media_id === null),
    `${row.message_id}: media_type/media_id mismatch`,
  );
  if (row.media_id) {
    const media = index.mediaById.get(row.media_id);
    expect(errors, media !== undefined, `${row.message_id}: unknown media`);
    expect(errors, media?.kind === row.media_type, `${row.message_id}: wrong media kind`);
  }
}

export function assertDatasetIntegrity(index: DatasetIndex): void {
  const errors: string[] = [];
  const { dataset } = index;

  for (const row of [...dataset.messages, ...dataset.history, ...dataset.samples]) {
    validateMessageShape(row, index, errors);
  }

  for (const event of dataset.events) {
    const message = index.historyById.get(event.message_id);
    expect(errors, message !== undefined, `${event.message_id}: event without history`);
    expect(
      errors,
      message?.user_id === event.user_id,
      `${event.message_id}: event/history user mismatch`,
    );
  }

  for (const media of index.mediaById.values()) {
    expect(errors, media.readStatus === "readable", `${media.mediaId}: media is ${media.readStatus}`);
  }

  const inputIds = dataset.messages.map((row) => row.message_id);
  const outputIds = dataset.output.map((row) => row.message_id);
  expect(
    errors,
    inputIds.join("\0") === outputIds.join("\0"),
    "output.csv IDs must exactly match messages.csv order",
  );

  for (const sample of dataset.samples) {
    if (sample.evidence_message_ids === "none") continue;
    for (const evidenceId of sample.evidence_message_ids.split(";")) {
      const history = index.historyById.get(evidenceId);
      expect(errors, history !== undefined, `${sample.message_id}: unknown sample evidence ${evidenceId}`);
      expect(
        errors,
        history?.user_id === sample.user_id,
        `${sample.message_id}: sample evidence belongs to another user`,
      );
      expect(
        errors,
        history !== undefined && history.created_at < sample.created_at,
        `${sample.message_id}: sample evidence is not historical`,
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(`Dataset integrity failed (${errors.length}):\n${errors.slice(0, 25).join("\n")}`);
  }
}

export type PriorMessage = {
  message: Message;
  event: MessageEvent | null;
  relationship: {
    sameConversationType: boolean;
    sameGroup: boolean;
    sameBusiness: boolean;
    sameSender: boolean;
  };
};

export type RoutingContext = {
  target: Message;
  user: User;
  conversation:
    | { kind: "personal"; senderUserId: string }
    | {
        kind: "group";
        group: Group;
        recipientMembership: GroupMember;
        senderUserId: string;
        senderMembership: GroupMember | null;
      }
    | {
        kind: "business";
        business: Business;
        relationship: UserBusinessHistory | null;
      };
  prior: PriorMessage[];
  notificationLoad: DailySummary[];
  media: MediaInspection | null;
};

function affinity(target: Message, prior: PriorMessage): number {
  return (
    Number(prior.relationship.sameGroup) * 4 +
    Number(prior.relationship.sameBusiness) * 4 +
    Number(prior.relationship.sameSender) * 3 +
    Number(prior.relationship.sameConversationType)
  );
}

export function buildContext(index: DatasetIndex, target: Message): RoutingContext {
  const user = index.usersById.get(target.user_id);
  if (!user) throw new Error(`${target.message_id}: user missing after validation`);

  const prior = (index.historyByUser.get(target.user_id) ?? [])
    .filter((message) => message.created_at < target.created_at)
    .map<PriorMessage>((message) => ({
      message,
      event:
        index.eventsByUserMessage.get(composite(target.user_id, message.message_id)) ?? null,
      relationship: {
        sameConversationType: message.conversation_type === target.conversation_type,
        sameGroup: target.group_id !== null && message.group_id === target.group_id,
        sameBusiness:
          target.business_id !== null && message.business_id === target.business_id,
        sameSender:
          target.sender_user_id !== null && message.sender_user_id === target.sender_user_id,
      },
    }))
    .sort(
      (left, right) =>
        affinity(target, right) - affinity(target, left) ||
        right.message.created_at.localeCompare(left.message.created_at) ||
        left.message.message_id.localeCompare(right.message.message_id),
    );

  const notificationLoad = (index.dailyByUser.get(target.user_id) ?? [])
    .filter((row) => row.date < target.created_at.slice(0, 10))
    .sort((left, right) => right.date.localeCompare(left.date));

  let conversation: RoutingContext["conversation"];
  if (target.conversation_type === "group") {
    const groupId = target.group_id as string;
    const senderUserId = target.sender_user_id as string;
    const group = index.groupsById.get(groupId);
    const recipientMembership = index.groupMembersByGroupUser.get(
      composite(groupId, target.user_id),
    );
    if (!group || !recipientMembership) {
      throw new Error(`${target.message_id}: group context missing after validation`);
    }
    conversation = {
      kind: "group",
      group,
      recipientMembership,
      senderUserId,
      senderMembership:
        index.groupMembersByGroupUser.get(composite(groupId, senderUserId)) ?? null,
    };
  } else if (target.conversation_type === "business") {
    const businessId = target.business_id as string;
    const business = index.businessesById.get(businessId);
    if (!business) throw new Error(`${target.message_id}: business missing after validation`);
    conversation = {
      kind: "business",
      business,
      relationship:
        index.userBusinessByUserBusiness.get(composite(target.user_id, businessId)) ?? null,
    };
  } else {
    conversation = {
      kind: "personal",
      senderUserId: target.sender_user_id as string,
    };
  }

  return {
    target,
    user,
    conversation,
    prior,
    notificationLoad,
    media: target.media_id ? (index.mediaById.get(target.media_id) ?? null) : null,
  };
}

export function fingerprintDatasetFiles(dataset: Dataset): string[] {
  return [
    ...Object.entries(DATA_FILES)
      .filter(([key]) => key !== "output")
      .map(([, [name]]) => name),
    ...dataset.images.map((row) => row.file_path),
    ...dataset.voices.map((row) => row.file_path),
  ].sort();
}

export async function fingerprintDataset(dataset: Dataset): Promise<string> {
  const files = fingerprintDatasetFiles(dataset);
  const hash = createHash("sha256");
  for (const relativePath of files) {
    hash.update(relativePath);
    hash.update("\0");
    for await (const chunk of createReadStream(resolveDatasetFile(dataset.root, relativePath))) {
      hash.update(chunk as Buffer);
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}
