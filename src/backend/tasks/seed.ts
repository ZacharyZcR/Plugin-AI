import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { TaskRepository } from "./repository.js";
import { requireService, SERVICE } from "../services.js";
import { PRESETS, automationDefinition } from "./presets.js";
import { ownerLanguage, presetTitle, automationName } from "./language.js";

/** Serial per owner, and recover links after a crash between create and link. */
export function createPresetSeeder(ctx: PluginContext, tasks: TaskRepository) {
  const pending = new Map<string, Promise<void>>();
  return (userId: string): Promise<void> => {
    const active = pending.get(userId);
    if (active) return active;
    const work = ctx
      .asUser(userId, async () => {
        if (!(await ctx.rbac.has("ops.use"))) return;
        if (!ctx.services.providers(SERVICE.automations).length) return;
        const access = requireService(ctx.services, SERVICE.automations);
        const existing = await access.list();
        const definitions = await Promise.all(
          existing.map((row) => access.get(row.id)),
        );
        const linked = new Set(
          (await tasks.presetLinks(userId)).map((link) => link.presetId),
        );
        const language = await ownerLanguage(ctx, userId);
        for (const preset of PRESETS) {
          if (linked.has(preset.id)) continue;
          const recovered = definitions.find((row) => {
            const def = row?.definition as
              { steps?: Array<{ presetId?: string }> } | undefined;
            return def?.steps?.some((step) => step.presetId === preset.id);
          });
          const title = presetTitle(language, preset.id);
          const automation =
            recovered ??
            (await access.create({
              name: automationName(title),
              definition: automationDefinition(preset, preset.id, title),
              enabled: false,
              concurrencyPolicy: "skip",
              maxRunSeconds: preset.maxRunSeconds,
            }));
          await tasks.linkPreset({
            userId,
            presetId: preset.id,
            presetVersion: preset.version,
            automationId: automation.id,
          });
        }
      })
      .finally(() => pending.delete(userId));
    pending.set(userId, work);
    return work;
  };
}
