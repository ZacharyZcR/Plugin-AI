import { termixTool } from "../ops/assistant-tools.js";
import { READ_ONLY_CLI_SUMMARY, type CliTarget } from "../ops/cli.js";
import { createOpsTools, type OpsSession } from "../ops/tools.js";
import type { CliRunInput } from "../repository.js";
import { objectSchema, str, type AiTool } from "../tools/types.js";
import { REPORT_SECTIONS } from "./prompt.js";
import {
  SEVERITIES,
  type Autonomy,
  type PlanHost,
  type Severity,
} from "./types.js";

/** The assistant tools with task budgets, a mode-specific gate and a final report. */

export interface TaskReport {
  severity: Severity;
  summary: string;
  report: string;
}

export interface TaskToolSession extends OpsSession {
  autonomy: Autonomy;
  /** Why the run must stop investigating and report now, if it must. */
  wrapUp: () => string | null;
  /** Seconds left until wrap-up, to cap a command's timeout. */
  secondsLeft: () => number;
  plan: PlanHost[] | null;
  report: TaskReport | null;
  /** Called once the report is in, to end the run. */
  onReport: () => void;
  /** The Termix CLI as the owner, or null when core cannot mint a token. */
  cli: CliTarget | null;
  recordCliRun: (run: CliRunInput) => Promise<void>;
}

/**
 * The longest a CLI call in a task may take. Each call mints its own token,
 * which must outlive the call: see CLI_TOKEN_TTL_SEC.
 */
export const TASK_CLI_TIMEOUT_SEC = 120;
export const CLI_TOKEN_TTL_SEC = 300;

const text = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

/** Level-2 headings in a Markdown report. */
const headingCount = (report: string) =>
  report.split("\n").filter((line) => /^##\s+\S/.test(line)).length;

export function createTaskTools(session: TaskToolSession): AiTool[] {
  session.mode = session.autonomy === "report" ? "report" : "auto";
  const refusal = () => {
    const reason = session.wrapUp();
    return reason ? { error: `${reason} Call submit_report now.` } : null;
  };
  /** The asked timeout, else `fallback`, never past wrap-up. */
  const timeoutSec = (args: Record<string, unknown>, fallback: number) => {
    const limit = Math.max(1, Math.floor(session.secondsLeft()));
    const asked = Number(args.timeoutSec);
    return Math.min(
      Number.isFinite(asked) && asked > 0 ? asked : fallback,
      limit,
    );
  };

  const opsTools = createOpsTools(session).map((tool): AiTool => {
    if (tool.name === "list_targets") return tool;
    if (tool.name === "get_host_facts") {
      return {
        ...tool,
        handler: async (args, context) =>
          refusal() ?? tool.handler(args, context),
      };
    }
    return {
      ...tool,
      description: `${tool.description} Commands requiring confirmation suspend the run until the owner decides.`,
      handler: async (args, context) => {
        const stop = refusal();
        if (stop) return stop;
        return tool.handler(
          {
            ...args,
            timeoutSec: timeoutSec(args, session.limits.timeoutSec),
          },
          context,
        );
      },
    };
  });

  const readOnlyTermix = (tool: AiTool): AiTool => ({
    ...tool,
    description: `${tool.description} ${session.autonomy === "report" ? `Read-only policy: ${READ_ONLY_CLI_SUMMARY}.` : "Execute the runbook and verify the outcome."}`,
    handler: async (args, context) => {
      const stop = refusal();
      if (stop) return stop;
      return tool.handler(
        {
          ...args,
          timeoutSec: Math.min(
            timeoutSec(args, TASK_CLI_TIMEOUT_SEC),
            TASK_CLI_TIMEOUT_SEC,
          ),
        },
        context,
      );
    },
  });
  const cliTools = session.cli
    ? [
        readOnlyTermix(
          termixTool({ ...session, hostShell: false }, session.cli),
        ),
      ]
    : [];

  const submitReport: AiTool = {
    name: "submit_report",
    description:
      "Hand in the final report. Call it exactly once, last; the run ends with it.",
    category: "ops",
    parameters: objectSchema(
      {
        severity: {
          type: "string",
          enum: SEVERITIES,
          description: "info, warning or critical",
        },
        summary: str("The verdict in one or two sentences"),
        report: str(
          "The report in Markdown with the four required level-2 headings",
        ),
      },
      ["severity", "summary", "report"],
    ),
    handler: async (args) => {
      const severity = text(args.severity) as Severity;
      if (!SEVERITIES.includes(severity)) {
        return { error: "severity must be info, warning or critical" };
      }
      const summary = text(args.summary);
      const report = text(args.report);
      if (!summary) return { error: "summary is required" };
      if (headingCount(report) < REPORT_SECTIONS) {
        return {
          error: `report must have the ${REPORT_SECTIONS} level-2 headings (## ...) in order`,
        };
      }
      session.report = { severity, summary, report };
      session.onReport();
      return { status: "recorded" };
    },
  };

  return [...opsTools, ...cliTools, submitReport];
}
