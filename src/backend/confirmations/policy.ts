import { parseShell, sensitiveWrite } from "./shell.js";
import { isReadOnlyCommand } from "../tools/command-allowlist.js";
import { checkReadOnlyCliArgs } from "../ops/cli.js";

export type CommandMode = "report" | "auto";

/** Unparsed shell programs are opaque execution, never a safe alternative. */
export function commandRisk(
  command: string,
  mode: CommandMode = "auto",
): string | null {
  if (mode === "report") {
    const check = isReadOnlyCommand(command);
    return check.allowed ? null : `Outside read-only policy: ${check.reason}`;
  }
  const commands = parseShell(command);
  if (!commands) return "Unparsed shell evaluation or expansion";
  for (const part of commands) {
    if (part.writes.some(sensitiveWrite)) return "Sensitive file redirection";
    const risk = simpleRisk(part.words);
    if (risk) return risk;
  }
  return null;
}

function simpleRisk(words: string[]): string | null {
  if (!words.length) return null;
  let plain = words;
  // Transparent wrappers: only these unambiguous forms can be unwrapped.
  while (["sudo", "timeout", "nice", "command"].includes(plain[0])) {
    const [wrapper, ...args] = plain;
    if (wrapper === "sudo") {
      while (["-n", "--non-interactive", "--"].includes(args[0])) args.shift();
    } else if (wrapper === "timeout") {
      if (!/^\d+(?:\.\d+)?[smhd]?$/.test(args.shift() ?? ""))
        return "Unparsed timeout options";
    } else if (wrapper === "nice" && args[0] === "-n") {
      args.shift();
      if (!/^-?\d+$/.test(args.shift() ?? "")) return "Unparsed nice options";
    }
    if (!args.length || args[0].startsWith("-"))
      return "Unparsed wrapper options";
    plain = args;
  }
  const executable = plain[0];
  if (!/^[a-zA-Z0-9_-]+$/.test(executable))
    return "Indirect executable or script path";
  const text = plain.join(" ");
  const args = plain.slice(1);
  const opaque =
    /^(if|then|else|elif|fi|for|while|until|do|done|case|esac|select|function|time|coproc|builtin|enable|alias|unalias|set|export|readonly|declare|typeset|trap|hash|let|doas|su|env|exec|nohup|ionice|setsid|chpst|xargs|eval|source|sh|bash|dash|zsh|ksh|fish|python[\d.]*|perl|ruby|node|nodejs|php|lua|git|make|cmake|npm|npx|yarn|pnpm|ansible|ansible-playbook|expect|tclsh|java|go|rustc|gcc|gdb|busybox|nsenter|chroot|sshpass|ssh|scp|sftp|rsync|install|ln|unzip|crontab|at|systemd-run)$/;
  if (opaque.test(executable)) return "Indirect execution or code installation";
  if (
    executable === "find" &&
    args.some((arg) =>
      /^-(?:delete|exec|execdir|ok|okdir|fls|fprint|fprint0|fprintf)$/.test(
        arg,
      ),
    )
  )
    return "Find execution or file mutation";
  if (
    /^(awk|gawk|mawk)$/.test(executable) &&
    (/system\s*\(|getline|@|[|>]|(?:^| )-(?:f|i|l|E|W)|--(?:file|include|load|exec)/.test(
      text,
    ) ||
      args.some(
        (arg) =>
          arg.startsWith("--") &&
          !/^--(?:field-separator|assign|source)(?:=|$)/.test(arg),
      ))
  )
    return "Awk execution or file access";
  if (executable === "sed" && !readOnlySed(args))
    return "Unparsed sed program or mutation";
  if (/^(cp|mv|tee)$/.test(executable)) {
    const safeOption =
      executable === "tee"
        ? /^(?:-[ai]+|--append|--ignore-interrupts|--)$/
        : /^(?:-[aAfipnPrRv]+|--archive|--force|--interactive|--no-clobber|--recursive|--verbose|--)$/;
    if (args.some((arg) => arg.startsWith("-") && !safeOption.test(arg)))
      return "Unparsed file operation option";
    const paths = args.filter((arg) => !arg.startsWith("-"));
    if (
      args.some(
        (arg) => arg.startsWith("--target-directory") || arg === "-t",
      ) ||
      (executable === "tee"
        ? paths.some(sensitiveWrite)
        : !paths.length || sensitiveWrite(paths[paths.length - 1]))
    )
      return "Sensitive file replacement";
    // Moving a protected source is destructive even when the destination is scratch.
    if (executable === "mv" && paths.slice(0, -1).some(sensitiveWrite))
      return "Sensitive file move";
  }
  if (executable === "tar") {
    if (
      !args.length ||
      !/^(?:-?[tvfzjJh]+|--list)$/.test(args[0]) ||
      !args[0].includes("t") ||
      args.some(
        (arg) =>
          arg.includes(":") ||
          (arg.startsWith("-") &&
            !/^(?:-[tvfzjJh]+|--list|--verbose|--file(?:=.*)?|--gzip|--bzip2|--xz|-)$/.test(
              arg,
            )),
      )
    )
      return "Archive write or external command";
  }
  if (executable === "wget") return "Download or file write";
  if (executable === "curl" && !readOnlyCurl(args))
    return "Unparsed transfer, network mutation or sensitive output";
  if (/::|--(?:eval|execute|config|plugin|engine|hook)(?:=|\b)/.test(text))
    return "Dynamic code or configuration injection";
  if (
    /^(lvremove|vgremove|pvremove|mkswap|mke2fs|blkdiscard|rmmod|kubeadm)$/.test(
      executable,
    )
  )
    return "Storage, kernel or cluster mutation";
  if (
    executable === "mdadm" &&
    args.some((arg) =>
      /--(?:zero-superblock|create|remove|stop|fail|grow)/.test(arg),
    )
  )
    return "RAID mutation";
  if (
    executable === "cryptsetup" &&
    !["status", "luksDump", "isLuks"].includes(args[0])
  )
    return "Encrypted storage mutation";
  if (
    executable === "virsh" &&
    ![
      "list",
      "dominfo",
      "domstate",
      "domblklist",
      "pool-list",
      "vol-list",
    ].includes(args[0])
  )
    return "Virtual machine mutation";
  if (/^(mysql|mariadb|psql|redis-cli)$/.test(executable))
    return "Database execution";
  if (
    executable === "sysctl" &&
    args.some(
      (arg) =>
        arg.includes("=") || /^-(?:[^-]*[wp]|-write|-load|-system)/.test(arg),
    )
  )
    return "Kernel configuration mutation";
  if (
    executable === "resolvectl" &&
    !["status", "query", "statistics"].includes(args[0])
  )
    return "Resolver configuration mutation";
  if (
    executable === "systemctl" &&
    args.some((arg) =>
      /^(reboot|poweroff|halt|kexec|rescue|emergency|default|suspend|hibernate|isolate)$/.test(
        arg,
      ),
    )
  )
    return "Host availability change";
  if (
    /^(rm|rmdir|mkfs(?:[._-].*)?|dd|wipefs|parted|fdisk|sfdisk|sgdisk|shred|truncate)$/.test(
      executable,
    )
  )
    return "Destructive data operation";
  if (
    /^(apt|apt-get|dnf|yum|apk|pacman)$/.test(executable) &&
    /\b(remove|purge|autoremove|erase|del)\b|(?:^| )-R/.test(text)
  )
    return "Package removal may disable services or access";
  if (/^(dpkg|rpm)$/.test(executable))
    return "Direct package execution or removal";
  if (/\.(deb|rpm)(?: |$)/.test(text)) return "Local package code execution";
  if (
    /^(reboot|shutdown|poweroff|halt|init|telinit|kill|killall|pkill)$/.test(
      executable,
    )
  )
    return "Availability change";
  if (
    /^(deluser|adduser|delgroup|addgroup|gpasswd|passwd|chage|usermod|userdel|useradd|groupmod|groupdel|groupadd|chpasswd|visudo|chmod|chown|setfacl|setcap|vipw|vigr|pw)$/.test(
      executable,
    )
  )
    return "Account or permission change";
  if (
    /^(iptables.*|ip6tables.*|nft|ufw|firewall-cmd|nmcli|netplan|route|ifconfig|ip)$/.test(
      executable,
    ) &&
    !isReadOnlyCommand(text).allowed
  )
    return "Network or access change";
  if (
    /^(systemctl|service)$/.test(executable) &&
    /\b(stop|disable|mask|restart|reload|isolate)\b/.test(text) &&
    (args.some((arg) => /[*?\[]/.test(arg)) ||
      /\b(ssh\w*|network\w*|NetworkManager|systemd-networkd|docker|containerd|k3s(?:-agent)?|kubelet)(?:\b|\.)/.test(
        text,
      ))
  )
    return "Critical service change";
  if (
    /^(zfs|zpool|qm|pct|pvesh|pvesm)$/.test(executable) &&
    !isReadOnlyCommand(text).allowed
  )
    return "Storage or virtualization mutation";
  if (
    /^(docker|podman|kubectl|k3s|crictl|helm)$/.test(executable) &&
    !isReadOnlyCommand(text).allowed
  )
    return "Container or cluster mutation / execution";
  return null;
}

function readOnlyCurl(args: string[]): boolean {
  const values = new Set([
    "--max-time",
    "--connect-timeout",
    "--retry",
    "--user-agent",
    "--header",
    "-H",
    "-A",
    "-m",
    "--url",
  ]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (
      /^(?:-[fsSILkvi]+|--fail|--silent|--show-error|--head|--location|--insecure|--verbose|--include|--disable)$/.test(
        arg,
      )
    )
      continue;
    if (arg === "-o" || arg === "--output") {
      if (sensitiveWrite(args[++i] ?? "")) return false;
    } else if (arg.startsWith("--output=") || /^-o.+/.test(arg)) {
      if (sensitiveWrite(arg.replace(/^(?:--output=|-o)/, ""))) return false;
    } else if (values.has(arg.split("=")[0])) {
      const value = arg.includes("=")
        ? arg.slice(arg.indexOf("=") + 1)
        : args[++i];
      if (!value || value.startsWith("@")) return false;
      if (arg.startsWith("--url") && !/^https?:\/\//i.test(value)) return false;
    } else if (arg.startsWith("-") || !/^https?:\/\//i.test(arg)) return false;
  }
  return true;
}

function readOnlySed(args: string[]): boolean {
  const scripts: string[] = [];
  let implicit = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (
      [
        "-n",
        "-E",
        "-r",
        "--quiet",
        "--silent",
        "--regexp-extended",
        "--",
      ].includes(arg)
    )
      continue;
    if (arg === "-e" || arg === "--expression") {
      scripts.push(args[++i] ?? "");
      implicit = false;
    } else if (arg.startsWith("-")) return false;
    else if (implicit) {
      scripts.push(arg);
      implicit = false;
    }
  }
  return (
    scripts.length > 0 &&
    scripts.every((script) =>
      script
        .split(";")
        .every(
          (part) =>
            /^[\d,$! ]*(?:p|d|q|=)$/.test(part.trim()) ||
            /^s([/|#])[^\n]*\1[^\n]*\1[gIp0-9 ]*$/.test(part.trim()),
        ),
    )
  );
}

export function cliRisk(
  args: string[],
  mode: CommandMode = "auto",
): string | null {
  const readOnly = checkReadOnlyCliArgs(args);
  if (mode === "report") return readOnly;
  const [group, sub] = args;
  if (sub?.startsWith("-") && !["--help", "-h"].includes(sub))
    return "Ambiguous CLI subcommand ordering";
  if (group === "api" && sub?.toUpperCase() !== "GET")
    return "Opaque Termix API mutation";
  if (
    /^(exec|files|ssh)$/.test(group ?? "") ||
    /^(exec|run|execute)$/.test(sub ?? "")
  )
    return "Indirect host execution";
  if (/^(delete|remove|rm|destroy|prune|disable|uninstall)$/.test(sub ?? ""))
    return "Termix destructive operation";
  if (
    /^(users|roles|permissions|api-keys|credentials|plugins)$/.test(
      group ?? "",
    ) &&
    readOnly
  )
    return "Termix access, credential or plugin change";
  if (
    group === "hosts" &&
    sub === "update" &&
    args.some((arg) =>
      /^--(?:password|key-password|credential-id|private-key|key-file|username|ip|port|auth-type)(?:=|$)/.test(
        arg,
      ),
    )
  )
    return "Host access or credential change";
  if (
    group === "docker" &&
    /^(stop|restart|kill|pause|update)$/.test(sub ?? "")
  )
    return "Container availability change";
  if (group === "sessions" && sub === "revoke") return "Session revocation";
  if (group?.startsWith("-")) return "Ambiguous CLI argument ordering";
  return null;
}
