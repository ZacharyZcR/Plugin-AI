import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { AiRepository } from "../../../src/backend/repository.js";
import {
  createConfirmations,
  CONFIRMATION_TTL_MS,
} from "../../../src/backend/confirmations/manager.js";

function setup() {
  const rows: any[] = [];
  const repository = {
    createProposal: async (input: any) => {
      const row = { ...input, id: rows.length + 1, status: "pending" };
      rows.push(row);
      return row;
    },
    pendingConfirmations: async () =>
      rows.filter((row) => row.status === "pending"),
    setProposalStatus: async (id: number, userId: string, status: string) => {
      const row = rows.find(
        (r) => r.id === id && r.userId === userId && r.status === "pending",
      );
      if (!row) return false;
      row.status = status;
      return true;
    },
  } as unknown as AiRepository;
  const audit = vi.fn(async (_entry: any) => {});
  const notify = vi.fn(async () => {});
  const ctx = {
    audit: { record: audit },
    notify: { send: notify },
    log: { warn: vi.fn() },
  } as unknown as PluginContext;
  const manager = createConfirmations(ctx, repository);
  const controller = new AbortController();
  const onWaiting = vi.fn();
  const onExpired = vi.fn();
  const confirm = manager.scoped({
    userId: "owner",
    conversationId: 1,
    signal: controller.signal,
    onWaiting,
    onExpired,
  });
  return {
    manager,
    confirm,
    controller,
    rows,
    audit,
    notify,
    onWaiting,
    onExpired,
  };
}
const command = {
  command: "reboot",
  hostIds: [1],
  reason: "Kernel update",
  risk: "Availability",
};
afterEach(() => vi.useRealTimers());
describe("suspended commands", () => {
  it("freezes the payload, waits for its owner, and consumes a decision once", async () => {
    const s = setup();
    let resumed = false;
    const input = { ...command, hostIds: [1] };
    const promise = s.confirm(input).then((allowed) => {
      resumed = true;
      return allowed;
    });
    await vi.waitFor(() => expect(s.notify).toHaveBeenCalled());
    input.command = "rm -rf /";
    input.hostIds.push(2);
    expect(JSON.parse(s.rows[0].payload)).toMatchObject(command);
    expect(resumed).toBe(false);
    expect(await s.manager.decide(1, "other", true)).toBe(false);
    expect(resumed).toBe(false);
    expect(await s.manager.decide(1, "owner", true)).toBe(true);
    expect(await promise).toBe(true);
    expect(await s.manager.decide(1, "owner", true)).toBe(false);
    expect(s.onWaiting.mock.calls).toEqual([[true], [false]]);
    expect(s.audit.mock.calls.map(([entry]) => (entry as any).action)).toEqual([
      "ai_command_blocked",
      "ai_command_approved",
    ]);
  });
  it.each([
    { args: ["credentials", "create", "--password", "plain-secret"] },
    { args: ["credentials", "create", "--password=plain-secret"] },
    {
      args: [
        "api",
        "POST",
        "/credentials",
        "--data",
        '{"password":"plain-secret"}',
      ],
    },
    {
      args: [
        "api",
        "POST",
        "/credentials",
        '--data={"password":"plain-secret"}',
      ],
    },
    { command: "PASSWORD='plain-secret' mysql -e 'SELECT 1'" },
    { command: "mysql -pplain-secret -e 'SELECT 1'" },
    { command: "mysql -p'plain-secret with spaces' -e 'SELECT 1'" },
    { command: "redis-cli -a plain-secret FLUSHALL" },
    { command: "curl -u user:plain-secret https://example.com" },
    {
      command:
        "curl -H 'Authorization: Bearer plain-secret' https://example.com",
    },
    { command: "curl https://user:plain-secret@example.com" },
  ])(
    "masks secrets in persistence, audit and notification: %j",
    async (operation) => {
      const s = setup();
      const input = {
        ...command,
        ...operation,
        reason: operation.command?.includes("with spaces")
          ? "Use plain-secret with spaces for this operation"
          : "Use plain-secret for this operation",
      };
      const original = JSON.stringify(input);
      const promise = s.confirm(input);
      await vi.waitFor(() => expect(s.notify).toHaveBeenCalled());
      expect(
        JSON.stringify([s.rows, s.audit.mock.calls, s.notify.mock.calls]),
      ).not.toContain("plain-secret");
      expect(JSON.stringify(input)).toBe(original);
      await s.manager.decide(1, "owner", true);
      expect(await promise).toBe(true);
    },
  );
  it("a rejection does not authorize the next equivalent operation", async () => {
    const s = setup();
    const first = s.confirm(command);
    await vi.waitFor(() => expect(s.notify).toHaveBeenCalledTimes(1));
    await s.manager.decide(1, "owner", false);
    expect(await first).toBe(false);
    const next = s.confirm(command);
    await vi.waitFor(() => expect(s.notify).toHaveBeenCalledTimes(2));
    await s.manager.decide(2, "owner", false);
    expect(await next).toBe(false);
  });
  it("expires at 24 hours and does not resume execution", async () => {
    vi.useFakeTimers();
    const s = setup();
    const promise = s.confirm(command).catch((error) => error.message);
    await vi.advanceTimersByTimeAsync(CONFIRMATION_TTL_MS);
    expect(await promise).toContain("Unconfirmed");
    expect(s.onExpired).toHaveBeenCalledOnce();
    expect(s.rows[0].status).toBe("expired");
    expect(await s.manager.decide(1, "owner", true)).toBe(false);
  });
  it("cancels a wait with the run and never replays persisted requests on restart", async () => {
    const s = setup();
    const promise = s.confirm(command).catch((error) => error.message);
    await vi.waitFor(() => expect(s.notify).toHaveBeenCalled());
    s.controller.abort();
    expect(await promise).toContain("no longer active");
    expect(await s.manager.decide(1, "owner", true)).toBe(false);
    s.rows.push({ id: 2, userId: "owner", status: "pending" });
    await s.manager.recover();
    expect(s.rows[1].status).toBe("expired");
  });
});
