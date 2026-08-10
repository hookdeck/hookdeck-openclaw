import { z } from "zod";

/**
 * TaskFlow action envelopes.
 *
 * Mirrors the vocabulary of OpenClaw's built-in Webhooks plugin, so an
 * automation source already speaking it — n8n, Zapier, CI — keeps working while
 * gaining signature verification, deduplication and a real retry contract.
 *
 * Every mutating action carries `expectedRevision`: TaskFlow mutations are
 * optimistic-concurrency, and a stale revision is a `409` rather than a
 * silently-lost update.
 */

const jsonValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
);

const withRevision = {
  flowId: z.string().min(1),
  expectedRevision: z.number().int().nonnegative(),
};

export const READ_ACTIONS = [
  "get_flow",
  "list_flows",
  "find_latest_flow",
  "resolve_flow",
  "get_task_summary",
] as const;

export const WRITE_ACTIONS = [
  "create_flow",
  "run_task",
  "set_waiting",
  "resume_flow",
  "finish_flow",
  "fail_flow",
  "request_cancel",
  "cancel_flow",
] as const;

export const ALL_ACTIONS = [...READ_ACTIONS, ...WRITE_ACTIONS] as const;
export type TaskFlowAction = (typeof ALL_ACTIONS)[number];

export const envelopeSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create_flow"),
    controllerId: z.string().min(1).optional(),
    goal: z.string().min(1),
    currentStep: z.string().nullable().optional(),
    stateJson: jsonValue.nullable().optional(),
  }),
  z.object({ action: z.literal("get_flow"), flowId: z.string().min(1) }),
  z.object({ action: z.literal("list_flows") }),
  z.object({ action: z.literal("find_latest_flow") }),
  z.object({ action: z.literal("resolve_flow"), token: z.string().min(1) }),
  z.object({
    action: z.literal("get_task_summary"),
    flowId: z.string().min(1),
  }),
  z.object({
    action: z.literal("set_waiting"),
    ...withRevision,
    currentStep: z.string().nullable().optional(),
    stateJson: jsonValue.nullable().optional(),
    waitJson: jsonValue.nullable().optional(),
  }),
  z.object({
    action: z.literal("resume_flow"),
    ...withRevision,
    status: z.enum(["queued", "running"]).optional(),
    currentStep: z.string().nullable().optional(),
    stateJson: jsonValue.nullable().optional(),
  }),
  z.object({
    action: z.literal("finish_flow"),
    ...withRevision,
    stateJson: jsonValue.nullable().optional(),
  }),
  z.object({
    action: z.literal("fail_flow"),
    ...withRevision,
    stateJson: jsonValue.nullable().optional(),
    blockedSummary: z.string().nullable().optional(),
  }),
  z.object({ action: z.literal("request_cancel"), ...withRevision }),
  z.object({ action: z.literal("cancel_flow"), flowId: z.string().min(1) }),
  z.object({
    action: z.literal("run_task"),
    flowId: z.string().min(1),
    runtime: z.enum(["subagent", "acp"]).default("subagent"),
    task: z.string().min(1),
    childSessionKey: z.string().min(1).optional(),
  }),
]);

export type TaskFlowEnvelope = z.infer<typeof envelopeSchema>;

export type EnvelopeParseResult =
  { ok: true; envelope: TaskFlowEnvelope } | { ok: false; errors: string[] };

export function parseTaskFlowEnvelope(payload: unknown): EnvelopeParseResult {
  const parsed = envelopeSchema.safeParse(payload);
  if (parsed.success) return { ok: true, envelope: parsed.data };
  return {
    ok: false,
    errors: parsed.error.issues.map(
      (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
    ),
  };
}

export function isWriteAction(action: TaskFlowAction): boolean {
  return (WRITE_ACTIONS as readonly string[]).includes(action);
}
