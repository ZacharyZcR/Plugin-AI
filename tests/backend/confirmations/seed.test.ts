import { describe, expect, it, vi } from "vitest";
import { createPresetSeeder } from "../../../src/backend/tasks/seed.js";
import { PRESETS } from "../../../src/backend/tasks/presets.js";

function setup() {
  const rows: any[] = [];
  const links: any[] = [];
  const access = {
    list: async () => rows,
    get: async (id: number) => rows.find((row) => row.id === id),
    create: vi.fn(async (input: any) => {
      const row = { ...input, id: rows.length + 1 };
      rows.push(row);
      return row;
    }),
  };
  const tasks = {
    presetLinks: async () => links,
    linkPreset: async (input: any) => {
      links.push(input);
    },
  };
  const ctx = {
    asUser: async (_id: string, fn: () => Promise<void>) => fn(),
    rbac: { has: async () => true },
    services: { providers: () => ["automations"], get: () => access },
    settings: { get: async () => undefined, getUser: async () => undefined },
  };
  return {
    rows,
    links,
    access,
    seed: createPresetSeeder(ctx as never, tasks as never),
  };
}
describe("disabled preset provisioning", () => {
  it("creates every preset disabled exactly once under concurrent initialization", async () => {
    const s = setup();
    await Promise.all([s.seed("owner"), s.seed("owner")]);
    await s.seed("owner");
    expect(s.rows).toHaveLength(PRESETS.length);
    expect(s.rows.every((row) => row.enabled === false)).toBe(true);
    expect(s.links).toHaveLength(PRESETS.length);
    expect(s.access.create).toHaveBeenCalledTimes(PRESETS.length);
  });
  it("does not recreate a deleted automation on subsequent provisioning", async () => {
    const s = setup();
    await s.seed("owner");
    s.rows.splice(0, 1);
    await s.seed("owner");
    expect(s.access.create).toHaveBeenCalledTimes(PRESETS.length);
    expect(s.rows).toHaveLength(PRESETS.length - 1);
  });
  it("recovers an unlinked creation and preserves existing enabled settings", async () => {
    const s = setup();
    s.rows.push({
      id: 1,
      enabled: true,
      definition: { steps: [{ presetId: PRESETS[0].id }] },
    });
    await s.seed("owner");
    expect(s.rows).toHaveLength(PRESETS.length);
    expect(s.rows[0].enabled).toBe(true);
    expect(
      s.links.find((link) => link.presetId === PRESETS[0].id).automationId,
    ).toBe(1);
  });
});
