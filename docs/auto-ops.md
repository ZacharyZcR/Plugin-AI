# Auto-ops

Automations starts the assistant on a schedule or event. It follows the runbook as the automation owner, investigates, performs permitted actions, verifies the result and writes a report.

## Modes

| Mode                | Behavior                                                                                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Report only         | Read-only allowlist enforced in the backend. Commands outside it wait for explicit owner confirmation. The runbook instructs the model to make no changes. |
| Automatic execution | Normal commands execute immediately; blacklist and opaque-execution matches suspend the run for its owner's decision. No separate plan approval.           |

The stored `propose` value is retained for compatibility with existing automation definitions, but now means automatic execution. Historical plans remain readable. Their old approval endpoint cannot execute them; run the task again through the new gate.

See [Command confirmations](command-confirmations.md) for the exact boundaries, decision flow, audit and restart behavior.

## Presets

On activation, and periodically for newly added users, the plugin initializes shipped presets for eligible owners through the Automations service. They are real automations, all **disabled** initially. Opening Auto-ops also ensures initialization. Existing automations, their edits and enabled states are preserved. Provisioning is serialized per owner and recovers links after interrupted creation.

Use the list's enable/disable buttons to toggle an existing automation. Use the custom-task form to create a separate customized copy. Users need AI operations permission and the corresponding Automations view/create/edit permissions. If Automations is absent, initialization waits until it becomes available.

The existing nine presets remain: daily patrol, disk cleanup, host-down triage, service failure, container anomaly, CPU overload, memory overload, security updates and certificate expiry. Twelve additional schedules ship disabled:

| Preset                              | Default cron   | Mode                                                          |
| ----------------------------------- | -------------- | ------------------------------------------------------------- |
| Backup freshness                    | `0 8 * * *`    | Report                                                        |
| SMART/RAID/ZFS health and scrub age | `0 7 * * 0`    | Report                                                        |
| SSH brute-force and login audit     | `30 8 * * *`   | Report                                                        |
| OOM and kernel errors               | `0 8 * * *`    | Report                                                        |
| Account/password expiry             | `0 9 * * *`    | Report                                                        |
| Log growth                          | `0 6 * * *`    | Report                                                        |
| Docker image/volume cleanup         | `0 3 * * 0`    | Automatic, destructive/opaque operations require confirmation |
| Listening-port changes              | `0 */6 * * *`  | Report                                                        |
| Cron/timer failures                 | `15 8 * * *`   | Report                                                        |
| Unexpected read-only mounts         | `0 */4 * * *`  | Report                                                        |
| Kubernetes health                   | `0 */2 * * *`  | Report                                                        |
| GPU health                          | `30 */2 * * *` | Report                                                        |

Schedules follow Automations' scheduler semantics. Change the cron, targets and runbook in the automation editor. Unsupported platforms are reported as coverage gaps. Port-change reports require prior evidence; the first observation is a baseline, not an invented change. Scrub checks inspect history and health; they do not initiate a scrub in report mode.

## Limits and reports

Token budgets, the kill switch, trigger rate limits, host permissions and per-host deduplication still apply. Only owner-confirmation waiting is excluded from the active run limit. A waiting task still occupies its run slot, so another trigger cannot race it.

After 24 hours without a decision, the task ends as unconfirmed. Interrupted runs never silently replay pending commands. Reports include evidence, actual actions and verification; a failed run does not imply no changes were made. The command history remains the source of truth for actions completed before failure.
