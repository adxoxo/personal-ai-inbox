import { z } from "zod";

export const timezoneSchema = z.string().min(1).refine((value) => {
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; }
  catch { return false; }
}, "Use an IANA timezone.");

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(value + "T00:00:00Z");
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "Use a valid calendar date.");

export const entrySchema = z.object({
  title: z.string().trim().min(1).max(160),
  content: z.string().min(1).max(10000),
  category: z.enum(["Task", "Idea", "Knowledge", "Journal", "Reference"]),
  project: z.string().trim().min(1).max(200).nullable(),
  tags: z.array(z.string().trim().min(1).max(40)).max(8),
  dueDate: dateSchema.nullable(),
}).strict().refine((entry) => entry.category === "Task" || entry.dueDate === null,
  "Only an explicit task can have a due date.");

export const extractionSchema = z.object({
  entries: z.array(entrySchema).min(1).max(20),
}).strict();

export const imageMimeSchema = z.enum(["image/jpeg", "image/png", "image/gif", "image/webp"]);
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const imageSourceSchema = z.object({
  fileId: z.string().min(1).max(1024), uniqueId: z.string().min(1).max(1024),
  mime: imageMimeSchema, size: z.number().int().positive().max(MAX_IMAGE_BYTES).optional(),
}).strict();
export const contextSchema = z.object({
  links: z.array(z.object({
    url: z.string().max(8192), title: z.string().max(300), content: z.string().max(12000),
    status: z.enum(["fetched", "unavailable", "blocked"]),
    code: z.string().regex(/^[a-z0-9_]+$/).optional(),
  }).strict()).max(3),
  image: z.object({
    hash: z.string().regex(/^[a-f0-9]{64}$/), mime: imageMimeSchema,
    bytes: z.number().int().positive().max(MAX_IMAGE_BYTES),
  }).strict().optional(),
}).strict();
export const uploadSchema = z.object({ id: z.string().min(1), expiresAt: z.iso.datetime() }).strict();
export type SourceContext = z.infer<typeof contextSchema>;
export type ImageUpload = z.infer<typeof uploadSchema>;
export type ImageData = { bytes: Uint8Array; mime: z.infer<typeof imageMimeSchema> };

export const captureSchema = z.object({
  sourceId: z.string().min(1),
  updateId: z.string().regex(/^\d+$/),
  chatId: z.string().regex(/^-?\d+$/),
  messageId: z.string().regex(/^\d+$/),
  userId: z.string().regex(/^\d+$/),
  capturedAt: z.iso.datetime(),
  timezone: timezoneSchema,
  text: z.string().max(10000),
  image: imageSourceSchema.optional(),
  links: z.array(z.string().max(8192)).max(3).optional(),
}).strict().refine((capture) => capture.sourceId === capture.chatId + ":" + capture.messageId,
  "Source ID must identify the captured message.").refine((capture) => capture.text.trim().length > 0 || !!capture.image,
  "A capture needs text or an image.");

export const pageSchema = z.object({
  id: z.string().min(1),
  url: z.string().url(),
}).strict();

const source = { sourceId: z.string().min(1) };
const item = { ...source, index: z.number().int().min(0).max(19) };

export const eventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("capture"), capture: captureSchema }).strict(),
  z.object({ type: z.literal("context"), ...source, context: contextSchema }).strict(),
  z.object({ type: z.literal("upload"), ...source, upload: uploadSchema }).strict(),
  z.object({ type: z.literal("extraction"), ...source, entries: extractionSchema.shape.entries }).strict(),
  z.object({ type: z.literal("intent"), ...item }).strict(),
  z.object({ type: z.literal("clear_intent"), ...item }).strict(),
  z.object({ type: z.literal("saved"), ...item, page: pageSchema }).strict(),
  z.object({
    type: z.literal("failure"), ...source,
    operation: z.string().regex(/^(prepare|upload|classify|confirm|notion:\d+)$/),
    code: z.string().regex(/^[a-z0-9_]+$/),
    attempt: z.number().int().positive(),
    retryAt: z.iso.datetime().nullable(),
    providerPauseUntil: z.iso.datetime().optional(),
  }).strict(),
  z.object({ type: z.literal("retry"), ...source, resetAttempts: z.boolean() }).strict(),
  z.object({ type: z.literal("confirmed"), ...source }).strict(),
]);

export const envelopeSchema = z.object({
  version: z.literal(1),
  recordedAt: z.iso.datetime(),
  event: eventSchema,
}).strict();

export type Entry = z.infer<typeof entrySchema>;
export type Capture = z.infer<typeof captureSchema>;
export type SavedPage = z.infer<typeof pageSchema>;
export type InboxEvent = z.infer<typeof eventSchema>;
export type Failure = Extract<InboxEvent, { type: "failure" }>;
export const itemId = (capture: Capture, index: number): string => capture.sourceId + ":" + index;

