import { redactConfirmation } from "./redaction.js";
import { createAiGate } from "../gating.js";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { Router } from "express";
import type { AiRepository } from "../repository.js";

export const CONFIRMATION_TTL_MS = 24 * 60 * 60 * 1000;
export interface FrozenCommand {
  command?: string;
  args?: string[];
  hostIds: number[];
  hosts?: Array<{ id: number; name: string }>;
  reason: string;
  risk: string;
}
export interface ConfirmationScope {
  userId: string;
  conversationId: number;
  signal: AbortSignal;
  onWaiting?: (waiting: boolean) => void;
  onExpired?: () => void;
  onUnavailable?: () => void;
  onCancelled?: () => void;
}
type Decision = "approved" | "rejected" | "expired" | "cancelled";
export type ConfirmCommand = (command: FrozenCommand) => Promise<boolean>;

/** A suspended tool owns its continuation. Decisions never submit commands. */
export function createConfirmations(
  ctx: PluginContext,
  repository: AiRepository,
) {
  const waiting = new Map<
    number,
    {
      userId: string;
      expiresAt: number;
      finish: (decision: Decision) => Promise<boolean>;
    }
  >();
  const audit = (id: number, state: string, payload?: FrozenCommand) =>
    ctx.audit.record({
      action: `ai_command_${state}`,
      resourceType: "ai_confirmation",
      resourceId: String(id),
      details: JSON.stringify(payload ?? {}),
      success: state === "approved",
    });

  const scoped =
    (scope: ConfirmationScope): ConfirmCommand =>
    async (input) => {
      if (scope.signal.aborted) throw new Error("Run stopped");
      const payload = redactConfirmation(input);
      const expiresAt = Date.now() + CONFIRMATION_TTL_MS;
      const row = await repository.createProposal({
        userId: scope.userId,
        conversationId: scope.conversationId,
        kind: "command_confirmation",
        summary: payload.risk,
        payload: JSON.stringify({ ...payload, expiresAt }),
      });
      try {
        await audit(row.id, "blocked", payload);
      } catch (error) {
        await repository.setProposalStatus(
          row.id,
          scope.userId,
          "expired",
          "Confirmation audit unavailable; not executed",
        );
        scope.onUnavailable?.();
        throw error;
      }
      return new Promise<boolean>((resolve, reject) => {
        let done = false;
        let timer: ReturnType<typeof setTimeout>;
        const abort = () => {
          void finish("cancelled");
        };
        const finish = async (decision: Decision): Promise<boolean> => {
          if (done) return false;
          done = true;
          waiting.delete(row.id);
          clearTimeout(timer);
          scope.signal.removeEventListener("abort", abort);
          try {
            const moved = await repository.setProposalStatus(
              row.id,
              scope.userId,
              decision === "approved"
                ? "applied"
                : decision === "cancelled"
                  ? "expired"
                  : decision,
              decision === "approved"
                ? "Confirmed for one execution"
                : decision,
            );
            await audit(row.id, decision);
            if (!moved || scope.signal.aborted)
              throw new Error("Confirmation is no longer active");
            if (decision === "expired") {
              scope.onExpired?.();
              throw new Error(
                "Unconfirmed: command confirmation expired after 24 hours",
              );
            }
            if (decision === "cancelled") {
              scope.onCancelled?.();
              throw new Error("Command confirmation cancelled; not executed");
            }
            resolve(decision === "approved");
            return true;
          } catch (error) {
            if (
              !scope.signal.aborted &&
              decision !== "expired" &&
              decision !== "cancelled"
            )
              scope.onUnavailable?.();
            reject(error);
            return false;
          } finally {
            scope.onWaiting?.(false);
          }
        };
        waiting.set(row.id, { userId: scope.userId, expiresAt, finish });
        scope.onWaiting?.(true);
        timer = setTimeout(
          () => void finish("expired"),
          Math.max(0, expiresAt - Date.now()),
        );
        scope.signal.addEventListener("abort", abort, { once: true });
        if (scope.signal.aborted) abort();
        void ctx.notify
          .send({
            title: "Command waiting for your confirmation",
            body: `Hosts: ${payload.hosts?.map((host) => `${host.name} (#${host.id})`).join(", ") || payload.hostIds.join(", ") || "Termix"}\n${payload.command ?? JSON.stringify(payload.args)}\nReason: ${payload.reason}\nPolicy: ${payload.risk}`,
            severity: "warning",
            category: "ai.command_confirmation",
            audience: { userId: scope.userId },
            link: { tab: "ai" },
            dedupeKey: `ai-command-${row.id}`,
          })
          .catch((error) =>
            ctx.log.warn(`Confirmation notification failed: ${error}`),
          );
      });
    };

  return {
    scoped,
    async recover() {
      // Never replay a command after losing the continuation in a restart.
      for (const row of await repository.pendingConfirmations()) {
        await repository.setProposalStatus(
          row.id,
          row.userId,
          "expired",
          "Interrupted by server restart; not executed",
        );
        await audit(row.id, "expired");
      }
    },
    async close() {
      await Promise.all(
        [...waiting.values()].map((entry) => entry.finish("cancelled")),
      );
    },
    async decide(id: number, userId: string, approved: boolean) {
      const entry = waiting.get(id);
      if (!entry || entry.userId !== userId) return false;
      if (Date.now() >= entry.expiresAt) {
        await entry.finish("expired");
        return false;
      }
      return entry.finish(approved ? "approved" : "rejected");
    },
    mount(router: Router) {
      router.use(
        "/confirmations",
        ctx.rbac.require("use") as never,
        createAiGate(ctx.settings, () => ctx.currentActor()) as never,
      );
      router.get("/confirmations", async (_req, res) => {
        const actor = ctx.currentActor();
        if (!actor) return res.sendStatus(401);
        const rows = await repository.pendingConfirmations(actor);
        res.json({
          confirmations: rows.map((row) => ({
            id: row.id,
            conversationId: row.conversationId,
            ...JSON.parse(row.payload),
          })),
        });
      });
      router.post("/confirmations/:id/decision", async (req, res) => {
        const actor = ctx.currentActor();
        if (!actor) return res.sendStatus(401);
        if (typeof req.body?.approved !== "boolean") return res.sendStatus(400);
        const entry = waiting.get(Number(req.params.id));
        if (!entry || entry.userId !== actor) return res.sendStatus(404);
        if (Date.now() >= entry.expiresAt) {
          await entry.finish("expired");
          return res.sendStatus(409);
        }
        const recorded = await entry.finish(
          req.body.approved ? "approved" : "rejected",
        );
        if (!recorded)
          return res.status(409).json({
            error:
              "Confirmation was not completed; the command was not released",
          });
        res.json({ ok: true });
      });
    },
  };
}
export type Confirmations = ReturnType<typeof createConfirmations>;
export const DENIED_COMMAND = {
  error:
    "The owner rejected this operation. Do not attempt an alternative command, encoding, interpreter, container or API to achieve the rejected action.",
};
