import { useEffect, useState } from "react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { Button } from "@termix-ssh/plugin-sdk/ui";
import { aiApp } from "../app-ref";

interface Pending {
  id: number;
  command?: string;
  args?: string[];
  hostIds: number[];
  hosts?: Array<{ id: number; name: string }>;
  reason: string;
  risk: string;
  expiresAt: number;
}

/** Owner-only decisions; the payload is display-only, never sent back. */
export function CommandConfirmations() {
  const { t } = useTranslation();
  const [pending, setPending] = useState<Pending[]>([]);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState("");
  const api = aiApp().api;
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const response = await api.get<{ confirmations: Pending[] }>(
          "/confirmations",
        );
        if (active) {
          setPending(response.data.confirmations);
          setError("");
        }
      } catch {
        if (active) setError(t("confirmations.loadFailed"));
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [api, t]);
  const decide = async (id: number, approved: boolean) => {
    setBusy(id);
    try {
      await api.post(`/confirmations/${id}/decision`, { approved });
      setPending((rows) => rows.filter((row) => row.id !== id));
    } catch {
      setError(t("confirmations.decisionFailed"));
    } finally {
      setBusy(null);
    }
  };
  if (!pending.length && !error) return null;
  return (
    <section
      className="max-h-80 overflow-auto border-b border-border p-3 space-y-3"
      aria-label={t("confirmations.title")}
    >
      {error && <p role="alert">{error}</p>}
      {pending.map((row) => (
        <div
          key={row.id}
          className="rounded border border-border p-3 space-y-2"
        >
          <strong>{t("confirmations.title")}</strong>
          <p>
            {t("confirmations.hosts")}:{" "}
            {row.hosts
              ?.map((host) => `${host.name} (#${host.id})`)
              .join(", ") ||
              row.hostIds.join(", ") ||
              "Termix"}
          </p>
          <pre className="whitespace-pre-wrap break-all text-xs">
            {row.command ?? `termix ${JSON.stringify(row.args)}`}
          </pre>
          <p>{row.reason}</p>
          <p className="text-xs text-muted-foreground">{row.risk}</p>
          <p className="text-xs">
            {t("confirmations.expires")}:{" "}
            {new Date(row.expiresAt).toLocaleString()}
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={busy !== null}
              onClick={() => void decide(row.id, true)}
            >
              {t("confirmations.approve")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() => void decide(row.id, false)}
            >
              {t("confirmations.reject")}
            </Button>
          </div>
        </div>
      ))}
    </section>
  );
}
