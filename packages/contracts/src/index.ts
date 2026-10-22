import { z } from "zod";
export const identitySchema = z.enum(["alex", "sam", "jordan"]);
export const textSchema = z.string().trim().min(1).max(1000);
export const commandSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("claim"),
    expectedVersion: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("handoff"),
    expectedVersion: z.number().int(),
    targetUserId: z.string().min(1),
  }),
  z.object({ type: z.literal("accept"), expectedVersion: z.number().int() }),
  z.object({ type: z.literal("cancel"), expectedVersion: z.number().int() }),
  z.object({ type: z.literal("takeover"), expectedVersion: z.number().int() }),
  z.object({
    type: z.literal("close"),
    expectedVersion: z.number().int(),
    outcome: z.enum(["COMPLETED", "DISMISSED", "NO_RESPONSE_RECORDED"]),
  }),
  z.object({
    type: z.literal("reply"),
    expectedVersion: z.number().int(),
    threadId: z.string().min(1),
    text: textSchema,
  }),
  z.object({
    type: z.literal("associate"),
    expectedVersion: z.number().int(),
    threadId: z.string().min(1),
  }),
  z.object({
    type: z.literal("media"),
    expectedVersion: z.number().int(),
    action: z.enum(["start", "stop", "unavailable", "interrupt"]),
    consent: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("capture"),
    expectedVersion: z.number().int(),
    consent: z.literal(true),
  }),
  z.object({ type: z.literal("delete"), expectedVersion: z.number().int() }),
]);
export type VisitCommand = z.infer<typeof commandSchema>;
export const guestMessageSchema = z.object({
  text: textSchema,
  category: z.enum(["Delivery", "Appointment", "Other"]),
});
export const settingsSchema = z.object({
  retentionHours: z.number().int().min(1).max(168),
  captionSize: z.number().min(28).max(36),
  consent: z.object({
    ring: z.boolean(),
    transcription: z.boolean(),
    sharing: z.boolean(),
  }),
  presets: z.array(textSchema).length(3),
});
export type SettingsInput = z.infer<typeof settingsSchema>;
