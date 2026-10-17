# Command confirmations

The interactive assistant's `run_command` and `termix` tools and unattended AI tasks use the same backend gate. Normal automatic-mode commands execute immediately. A policy match suspends the agent before execution: no tool result and no further model turn is produced while it waits.

The owner sees a redacted copy of the frozen command or CLI argument array, target hosts, model reason, policy reason and expiration time in the AI tab or floating assistant. An Alerts inbox notification links to the AI tab. Only that owner can decide. The decision endpoint accepts a request ID and a boolean; supplied replacement commands are ignored. Confirmation releases the existing continuation once, using the untouched original command held in memory. Database records, audit entries and notifications use the redacted copy; passwords, secret flags, JSON secret fields and common shell credential forms are masked, including known secret values repeated in the reason. Host access and execution permissions are checked again; confirmation never grants missing permissions.

Rejection returns an explicit instruction not to attempt an alternative implementation. It grants no exemption: subsequent matches create new confirmations. Hits, confirmations, rejections and expiration are audited. Commands are also recorded by the existing execution audit after execution.

Pending requests expire after 24 hours. Expiration ends the task with an unconfirmed report. Confirmation wait time extends both the AI active-time deadline and the Automations deadline, including parent automations. Canceling a run cancels its pending continuation. Restarting the backend marks pending requests interrupted/expired and does not replay them; restart the task explicitly.

## Policy categories

| Category                | Matches requiring confirmation                                                                                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Data                    | `rm`, filesystem formatting, `dd`, partitioning, wiping, truncation; storage and virtualization mutations                                                                                                          |
| Availability            | reboot/shutdown, signals/process kills, stopping or masking SSH/network/container runtime services, package removal                                                                                                |
| Access                  | account and permission changes, firewall/routing/link changes, SSH keys/config and sudoers                                                                                                                         |
| Containers and clusters | non-read-only Docker/Podman/Kubernetes operations, including privileged containers, exec, volume deletion and drain                                                                                                |
| Opaque execution        | substitutions, unresolved expansions and unsupported shell syntax; interpreters, `eval`, scripts or executable paths, `nsenter`/`chroot`, dynamic config injection, dangerous tool flags and sensitive file writes |
| Termix                  | deletion/disable/uninstall, user/role/credential/API-key/plugin mutations, host credential/access changes, container stops, session revocation, host execution through CLI, non-GET raw API calls                  |

The bounded shell parser distinguishes quoted text from operators and checks every command in sequences and pipelines before any part is executed. Ordinary pipelines, `2>/dev/null`, scratch output, quoted awk field expressions, common read-only sed/find/tar uses and supported sudo/timeout/nice/command wrappers are accepted. One risky segment suspends the whole original command. Unsupported wrapper options, control flow, heredocs, substitutions and unresolved variable expansions still require confirmation.

Scratch destinations under `/tmp` and `/var/tmp` are permitted, but path traversal and sensitive destinations are blocked. Text classification cannot verify remote symlinks or mount mappings; a scratch path is not proof of filesystem isolation. A later script execution is separately gated even if writing its contents was permitted. It does not normalize and execute a different command. Ordinary installed binaries are trusted in automatic mode: a textual blacklist is not an operating-system sandbox and cannot establish the behavior of an arbitrary binary already on a host. These controls cover these AI tool paths, not a human's terminal or separately launched external coding agents.

Report-only mode retains the existing read-only allowlist. A command outside that list suspends for explicit owner confirmation rather than returning an immediate refusal. Permanent authorization failures remain failures and are not overridden by confirmation.

Deploy the AI and Automations changes together to exclude confirmation time from the automation run limit. On an older Automations provider the preset toggle endpoint reports that an update is required.

Provisioning links are retained when an automation is deleted, preventing automatic recreation. The historical autonomy value `propose` now means automatic diagnose/fix/verify; both plugins display this meaning.
