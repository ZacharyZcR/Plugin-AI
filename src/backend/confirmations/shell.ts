/** A deliberately bounded shell grammar. Unsupported evaluation requires consent. */
export interface ShellCommand {
  words: string[];
  writes: string[];
}
export function parseShell(source: string): ShellCommand[] | null {
  const commands: ShellCommand[] = [];
  let current: ShellCommand = { words: [], writes: [] };
  let word = "";
  let started = false;
  let quote = "";
  let redirect: "read" | "write" | null = null;
  const flush = () => {
    if (!started) return;
    if (redirect === "write") current.writes.push(word);
    else if (!redirect) current.words.push(word);
    redirect = null;
    word = "";
    started = false;
  };
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quote === "'") {
      if (c === "'") quote = "";
      else word += c;
      continue;
    }
    if (c === "`" || c === "$" || c === "\r") return null;
    if (c === "\\") {
      const next = source[++i];
      if (next === undefined) return null;
      if (next !== "\n") {
        if (quote && !/[\\"$`]/.test(next)) word += "\\";
        word += next;
        started = true;
      }
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = "";
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      started = true;
      continue;
    }
    if (c === "#" && !started) {
      while (i < source.length && source[i] !== "\n") i++;
      i--;
      continue;
    }
    if ("(){}".includes(c)) return null;
    if (c === ">" || c === "<") {
      if (redirect) return null;
      if (/^\d+$/.test(word)) {
        word = "";
        started = false;
      }
      flush();
      if (source[i + 1] === c) {
        if (c === "<") return null; // heredocs need a full shell evaluator
        i++;
      }
      if (source[i + 1] === "&") {
        const fd = source.slice(i + 2).match(/^(\d+|-)(?=\s|[;|&]|$)/);
        if (!fd) return null;
        i += 1 + fd[0].length;
        continue;
      }
      redirect = c === ">" ? "write" : "read";
      continue;
    }
    if (/[;|&\n]/.test(c)) {
      flush();
      if (redirect) return null;
      if (c === "&" && source[i + 1] !== "&") return null;
      if ((c === "&" || c === "|") && source[i + 1] === c) i++;
      if (current.words.length || current.writes.length) commands.push(current);
      current = { words: [], writes: [] };
      continue;
    }
    if (/\s/.test(c)) flush();
    else {
      word += c;
      started = true;
    }
  }
  flush();
  if (quote || redirect) return null;
  if (current.words.length || current.writes.length) commands.push(current);
  return commands.length ? commands : null;
}

/** Only explicit scratch destinations are automatically writable. */
export function sensitiveWrite(path: string): boolean {
  if (path === "/dev/null") return false;
  if (!/^\/(?:tmp|var\/tmp)\/[^\s]+$/.test(path)) return true;
  return /(?:^|\/)\.\.(?:\/|$)|[*?\[\]$`]|(?:^|\/)(?:authorized_keys|sshd_config|sudoers)$/.test(
    path,
  );
}
