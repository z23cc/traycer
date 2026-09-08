import { basename, isAbsolute, relative, resolve } from "node:path";

/**
 * A shell command the agent may run on the epic's artifacts without asking,
 * as the released host allows it in every permission mode: one plain file
 * command, every operand under the artifact root. The command is read from
 * the tool's input (or, failing that, its description), split with quotes
 * honoured, and unwrapped once through `sh -c`. Anything the shell itself
 * would interpret - pipes, redirections, substitutions, globs - is left to
 * the user to approve.
 */
const SHELL_TOOLS = new Set(["bash", "command", "shell"]);
const SHELLS = new Set(["bash", "sh", "zsh"]);
const VERBS = new Set([
  "[",
  "basename",
  "cat",
  "chgrp",
  "chmod",
  "chown",
  "cp",
  "dirname",
  "du",
  "file",
  "find",
  "head",
  "install",
  "ln",
  "ls",
  "mkdir",
  "mv",
  "rm",
  "rmdir",
  "stat",
  "tail",
  "tee",
  "test",
  "touch",
  "truncate",
  "wc",
]);
const SHELL_SYNTAX = new Set([
  "\n",
  "\r",
  ";",
  "|",
  "&",
  "<",
  ">",
  "$",
  "`",
  "(",
  ")",
]);
const UNSAFE_OPERAND = /[\0\n\r;&|<>`$*?[\]{}]/u;
const FIND_EXEC = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

export interface ArtifactCommand {
  readonly verb: string;
  /** Every operand, resolved against the working directory. */
  readonly paths: readonly string[];
}

type Command =
  | { readonly kind: "tokens"; readonly tokens: readonly string[] }
  | { readonly kind: "source"; readonly source: string };

export function artifactCommand(
  toolName: string,
  input: unknown,
  description: string,
  cwd: string,
  artifactRoot: string,
): ArtifactCommand | null {
  if (!SHELL_TOOLS.has(toolName.toLowerCase())) {
    return null;
  }
  const command = commandOf(input) ?? sourceOf(description);
  return command === null ? null : classify(command, cwd, artifactRoot, 0);
}

/** Is `filePath` at or under `root`? Both are resolved first. */
export function isInside(root: string, filePath: string): boolean {
  if (root.trim().length === 0 || filePath.trim().length === 0) {
    return false;
  }
  const rel = relative(
    casefold(resolve(root)),
    casefold(resolve(root, filePath)),
  );
  return rel.length === 0 || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Windows paths compare case-insensitively, as the released host reads them. */
function casefold(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function commandOf(value: unknown): Command | null {
  if (typeof value === "string") {
    return sourceOf(value);
  }
  if (Array.isArray(value)) {
    const tokens = value.filter(
      (token): token is string => typeof token === "string",
    );
    return tokens.length > 0 && tokens.length === value.length
      ? { kind: "tokens", tokens }
      : null;
  }
  if (value === null || typeof value !== "object") {
    return null;
  }
  const metadata: unknown = Reflect.get(value, "metadata");
  return (
    commandOf(Reflect.get(value, "command")) ??
    commandOf(Reflect.get(value, "cmd")) ??
    commandOf(Reflect.get(value, "args")) ??
    (metadata !== null && typeof metadata === "object"
      ? commandOf(Reflect.get(metadata, "command"))
      : null)
  );
}

function sourceOf(text: string): Command | null {
  return text.trim().length === 0 ? null : { kind: "source", source: text };
}

function classify(
  command: Command,
  cwd: string,
  root: string,
  depth: number,
): ArtifactCommand | null {
  if (depth > 1) {
    return null;
  }
  const tokens =
    command.kind === "tokens" ? [...command.tokens] : tokenize(command.source);
  if (tokens === null || tokens.length === 0) {
    return null;
  }
  const script = shellScript(tokens);
  if (script !== null) {
    return classify({ kind: "source", source: script }, cwd, root, depth + 1);
  }
  const verb = basename(tokens[0] ?? "").toLowerCase();
  if (
    !VERBS.has(verb) ||
    (verb === "find" && tokens.some((token) => FIND_EXEC.has(token)))
  ) {
    return null;
  }
  const operands =
    verb === "mkdir"
      ? mkdirOperands(tokens.slice(1))
      : plainOperands(tokens.slice(1));
  if (operands === null || operands.length === 0) {
    return null;
  }
  const paths: string[] = [];
  for (const operand of operands) {
    if (operand.length === 0 || UNSAFE_OPERAND.test(operand)) {
      return null;
    }
    const path = resolve(cwd, operand);
    if (!isInside(root, path)) {
      return null;
    }
    paths.push(path);
  }
  return { verb, paths };
}

/** Whitespace-split with quotes and backslashes honoured; null on shell syntax. */
function tokenize(source: string): string[] | null {
  const tokens: string[] = [];
  let current = "";
  let quote: string | null = null;
  let escaped = false;
  for (const ch of source) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (SHELL_SYNTAX.has(ch)) {
      return null;
    }
    if (/\s/u.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (escaped || quote !== null) {
    return null;
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

/** `sh -c '<script>'` with nothing after the script: the script. */
function shellScript(tokens: readonly string[]): string | null {
  if (!SHELLS.has(basename(tokens[0] ?? "").toLowerCase())) {
    return null;
  }
  for (let index = 1; index < tokens.length; index += 1) {
    const flag = tokens[index];
    if (flag === undefined || !flag.startsWith("-") || flag === "--") {
      return null;
    }
    if (!flag.includes("c")) {
      continue;
    }
    const script = tokens[index + 1];
    return script === undefined ||
      script.length === 0 ||
      tokens.length !== index + 2
      ? null
      : script;
  }
  return null;
}

/** Operands of any verb but mkdir: flags are skipped, `--flag=value` yields its value. */
function plainOperands(args: readonly string[]): string[] | null {
  const operands: string[] = [];
  for (const arg of args) {
    if (arg.length === 0 || UNSAFE_OPERAND.test(arg)) {
      return null;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      const eq = arg.indexOf("=");
      if (eq !== -1 && eq + 1 < arg.length) {
        operands.push(arg.slice(eq + 1));
      }
      continue;
    }
    operands.push(arg);
  }
  return operands;
}

/** mkdir's operands: only `-p`, `-v` and a mode are understood as flags. */
function mkdirOperands(args: readonly string[]): string[] | null {
  const operands: string[] = [];
  let flags = true;
  let mode = false;
  for (const arg of args) {
    if (mode) {
      if (arg.length === 0 || UNSAFE_OPERAND.test(arg)) {
        return null;
      }
      mode = false;
      continue;
    }
    if (flags && arg === "--") {
      flags = false;
      continue;
    }
    if (flags && arg.startsWith("--")) {
      if (arg === "--parents" || arg === "--verbose") {
        continue;
      }
      if (arg === "--mode") {
        mode = true;
        continue;
      }
      if (arg.startsWith("--mode=") && arg.length > 7) {
        continue;
      }
      return null;
    }
    if (flags && arg.startsWith("-") && arg.length > 1) {
      if (/^[pv]+$/u.test(arg.slice(1))) {
        continue;
      }
      if (arg === "-m") {
        mode = true;
        continue;
      }
      return null;
    }
    operands.push(arg);
  }
  return mode ? null : operands;
}
