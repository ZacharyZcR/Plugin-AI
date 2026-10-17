import { redactCliArgs } from "../ops/cli.js";
import { redact, redactString, REDACTED } from "../redaction.js";
import type { FrozenCommand } from "./manager.js";

/** Display records are never used as executable input. */
export function redactConfirmation(input: FrozenCommand): FrozenCommand {
  const secrets = new Set<string>();
  const remember = (raw: unknown, masked: unknown) => {
    if (typeof raw === "number" && raw !== masked) secrets.add(String(raw));
    if (typeof raw === "string" && raw !== masked && raw) {
      if (typeof masked === "string") {
        try {
          compare(JSON.parse(raw), JSON.parse(masked));
          return;
        } catch {
          /* scalar */
        }
      }
      if (
        typeof masked === "string" &&
        raw.startsWith("--") &&
        raw.includes("=")
      ) {
        remember(
          raw.slice(raw.indexOf("=") + 1),
          masked.slice(masked.indexOf("=") + 1),
        );
      } else secrets.add(raw);
    }
  };
  const compare = (raw: unknown, masked: unknown) => {
    if (raw && typeof raw === "object") {
      for (const [key, value] of Object.entries(raw))
        compare(
          value,
          masked && typeof masked === "object"
            ? (masked as Record<string, unknown>)[key]
            : masked,
        );
    } else remember(raw, masked);
  };
  const maskText = (text: string): string => {
    let result = redactString(text);
    result = result.replace(
      /(\bBearer\s+)([^\s"']+)/gi,
      (_match, prefix, secret) => {
        secrets.add(secret);
        return `${prefix}${REDACTED}`;
      },
    );
    // Shell assignments, CLI flags and JSON-style fields, including quoted values.
    result = result.replace(
      /((?:--[\w-]*(?:password|passwd|passphrase|secret|token|api[_-]?key|private[_-]?key|authorization)[\w-]*\s+|[\w-]*(?:password|passwd|passphrase|secret|token|api[_-]?key|private[_-]?key|authorization)[\w-]*["']?\s*[:=]\s*))("(?:\\.|[^"\\])*"|'[^']*'|[^\s;,|&]+)/gi,
      (_match, prefix: string, value: string) => {
        const raw = value.replace(/^["']|["']$/g, "");
        if (raw) secrets.add(raw);
        return `${prefix}${REDACTED}`;
      },
    );
    result = result.replace(
      /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)([^\s/@]+)(@)/gi,
      (_match, prefix, secret, suffix) => {
        secrets.add(secret);
        try {
          secrets.add(decodeURIComponent(secret));
        } catch {
          /* malformed URL */
        }
        return `${prefix}${REDACTED}${suffix}`;
      },
    );
    if (/\b(?:curl|wget)\b/.test(text)) {
      result = result.replace(
        /((?:--user(?:=|\s+)|-u\s*)["']?[^\s:"']+:)([^\s"']+)/g,
        (_match, prefix, secret) => {
          secrets.add(secret);
          return `${prefix}${REDACTED}`;
        },
      );
    }
    if (/\b(?:mysql|mariadb|sshpass|redis-cli)\b/.test(text)) {
      const flag = /\bredis-cli\b/.test(text) ? "a" : "p";
      const pattern = new RegExp(
        `(\\s-${flag}\\s*)("(?:\\\\.|[^"\\\\])*"|'[^']*'|[^\\s]+)`,
        "g",
      );
      result = result.replace(pattern, (_match, prefix, secret) => {
        secrets.add(secret.replace(/^["']|["']$/g, ""));
        return `${prefix}${REDACTED}`;
      });
    }
    return result;
  };
  const args = input.args ? redactCliArgs(input.args) : undefined;
  input.args?.forEach((arg, index) => remember(arg, args?.[index]));
  const copy = JSON.parse(JSON.stringify({ ...input, args })) as FrozenCommand;
  // First discover secrets in every field, then also remove copies echoed in the reason/host label.
  const visit = (value: unknown): unknown => {
    if (typeof value === "string") return maskText(value);
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, visit(entry)]),
      );
    return value;
  };
  const masked = visit(redact(copy));
  const scrub = (value: unknown): unknown => {
    if (typeof value === "string") {
      for (const secret of [...secrets].sort((a, b) => b.length - a.length))
        value = (value as string).split(secret).join(REDACTED);
      return value;
    }
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, scrub(entry)]),
      );
    return value;
  };
  return scrub(masked) as FrozenCommand;
}
