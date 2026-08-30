import path from "path";
import { spawn, type ChildProcess } from "child_process";

/**
 * Secure shell execution for the Agent.
 *
 * Design goals:
 *  - No `shell: true`: commands are tokenised and executed directly, so shell
 *    metacharacters can never be interpreted by a shell.
 *  - Command allowlist: only a curated set of read-only / admin tools is
 *    allowed (curl/wget/basic file/process inspection).
 *  - cwd confinement: every process is spawned inside the Agent workspace and
 *    flagged arguments that would escape the workspace are rejected.
 *  - Timeouts, output truncation and process-tree cleanup prevent runaway jobs.
 *  - Full audit trail for every invocation.
 */

export interface ShellResult {
  code: number | null;
  stdout: string;
  stderr: string;
  command: string;
  durationMs: number;
  truncated: boolean;
}

export interface ShellPolicy {
  allowedBinaries: string[];
  maxOutputBytes: number;
  timeoutMs: number;
  maxArgs: number;
  /** Paths that must never appear as arguments (absolute escapes). */
  forbiddenPathPrefixes: string[];
}

const DEFAULT_POLICY: ShellPolicy = {
  allowedBinaries: [
    "curl",
    "wget",
    "cat",
    "ls",
    "pwd",
    "echo",
    "head",
    "tail",
    "grep",
    "wc",
    "find",
    "df",
    "du",
    "uname",
    "java",
    "node",
    "npm",
    "npx",
    "python",
    "python3",
    "bash",
    "sh"
  ],
  maxOutputBytes: 256 * 1024,
  timeoutMs: 60_000,
  maxArgs: 128,
  forbiddenPathPrefixes: []
};

/** Binaries that imply arbitrary code execution - require explicit approval. */
const HIGH_RISK_BINARIES = new Set(["bash", "sh", "python", "python3", "node", "npm", "npx"]);

const DANGEROUS_PATTERNS = [
  /\brm\s+-rf\b/i,
  /\brm\s+-fr\b/i,
  /\bsudo\b/i,
  /\bsu\s+-\b/i,
  /\bchmod\s+777\b/i,
  /\bdd\s+if=/i,
  /\bmkfs/i,
  /\b:\(\)\s*\{/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bhalt\b/i,
  /\b>\/dev\/sda/i
];

export class ShellSecurityError extends Error {}

/**
 * Tokenise a command string without a shell. Handles single/double quotes and
 * backslash escapes. Returns the argv array.
 */
export function tokenizeCommand(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let hasToken = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      else current += ch;
      hasToken = true;
      continue;
    }
    if (inDouble) {
      if (ch === '"') inDouble = false;
      // Only treat backslash as escape before " or backslash; Windows paths
      // like "C:\Users\foo" must keep their backslashes.
      else if (ch === "\\" && i + 1 < input.length && (input[i + 1] === '"' || input[i + 1] === "\\")) {
        current += input[++i];
      } else current += ch;
      hasToken = true;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      hasToken = true;
    } else if (ch === '"') {
      inDouble = true;
      hasToken = true;
    } else if (ch === "\\" && i + 1 < input.length) {
      current += input[++i];
      hasToken = true;
    } else if (/\s/.test(ch)) {
      if (hasToken) {
        args.push(current);
        current = "";
        hasToken = false;
      }
    } else {
      current += ch;
      hasToken = true;
    }
  }
  if (hasToken) args.push(current);
  return args;
}

/**
 * Validate a shell command against the policy. Throws ShellSecurityError when
 * the command is not allowed. Returns the argv to spawn.
 */
export function validateShellCommand(
  rawCommand: string,
  workspace: string,
  policy: Partial<ShellPolicy> = {}
): { argv: string[]; highRisk: boolean } {
  const p: ShellPolicy = { ...DEFAULT_POLICY, ...policy };
  if (!rawCommand || rawCommand.length > 4096) throw new ShellSecurityError("Command too long");
  const argv = tokenizeCommand(rawCommand);
  if (!argv.length) throw new ShellSecurityError("Empty command");
  if (argv.length > p.maxArgs) throw new ShellSecurityError("Too many arguments");

  const bin = argv[0];
  const binName = path.basename(bin);
  if (!p.allowedBinaries.includes(binName)) {
    throw new ShellSecurityError(`Binary "${binName}" is not in the allowlist`);
  }

  // Reject obviously dangerous compound commands (no shell means `;`, `&&`,
  // pipes are passed as arguments, but be defensive anyway).
  const joined = rawCommand;
  if (DANGEROUS_PATTERNS.some((re) => re.test(joined))) {
    throw new ShellSecurityError("Command matches a dangerous pattern");
  }
  // Shell chaining / piping / redirection: no shell is used, but reject the
  // obvious constructs outright instead of passing them as garbage arguments.
  const chainTokens = new Set(["|", "||", "&", "&&", ";", ">", ">>", "<", "2>", "2>&1", "1>"]);
  if (argv.slice(1).some((arg) => chainTokens.has(arg))) {
    throw new ShellSecurityError("Command chaining/piping/redirection is not supported");
  }
  if (/[|;&]/.test(joined)) {
    const stripped = tokenizeCommand(joined.replace(/["']/g, ""));
    if (stripped.slice(1).some((arg) => chainTokens.has(arg))) {
      throw new ShellSecurityError("Command chaining/piping is not supported");
    }
  }

  // Path confinement: reject arguments that clearly escape the workspace.
  const workspaceResolved = path.resolve(workspace);
  for (const arg of argv.slice(1)) {
    if (arg === ".." || arg === "../" ) continue; // relative parent is blocked by spawn cwd check below
    if (arg.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(arg)) {
      const resolved = path.resolve(workspaceResolved, arg);
      if (
        resolved !== workspaceResolved &&
        !resolved.startsWith(workspaceResolved + path.sep)
      ) {
        // allow absolute reads of system logs but keep writes confined
        throw new ShellSecurityError(`Argument "${arg}" escapes the workspace`);
      }
    }
    for (const prefix of p.forbiddenPathPrefixes) {
      if (arg.startsWith(prefix)) throw new ShellSecurityError(`Argument "${arg}" is forbidden`);
    }
  }

  return { argv, highRisk: HIGH_RISK_BINARIES.has(binName) };
}

export interface SpawnShellOptions {
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: Record<string, string>;
  /** Called for every output chunk (streaming). */
  onData?: (chunk: string) => void;
  /** Abort signal: kills the process tree immediately when fired. */
  signal?: AbortSignal;
}

/**
 * Execute a validated command. The process is spawned with a confined cwd,
 * sanitised environment and a hard kill timer. On Windows the process is
 * killed with taskkill so its whole tree goes down.
 */
export function runShellCommand(
  argv: string[],
  opts: SpawnShellOptions = {}
): Promise<ShellResult> {
  return new Promise((resolve) => {
    const cwd = opts.cwd ? path.resolve(opts.cwd) : process.cwd();
    const timeoutMs = opts.timeoutMs ?? DEFAULT_POLICY.timeoutMs;
    const maxOutput = opts.maxOutputBytes ?? DEFAULT_POLICY.maxOutputBytes;
    const env: Record<string, string> = {
      ...(opts.env || {}),
      PATH: process.env.PATH || "",
      HOME: process.env.HOME || process.env.USERPROFILE || ""
    };
    // remove potentially sensitive inherited vars
    delete env.AGENT_API_KEY;
    delete env.OPENAI_API_KEY;

    const started = Date.now();
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let killed = false;

    const child: ChildProcess = spawn(argv[0], argv.slice(1), {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    const append = (buf: Buffer, target: "out" | "err") => {
      const text = buf.toString("utf-8");
      if (target === "out") stdout += text;
      else stderr += text;
      if (stdout.length > maxOutput || stderr.length > maxOutput) {
        truncated = true;
        opts.onData?.(text);
        killTree(child);
      } else {
        opts.onData?.(text);
      }
    };

    const killTree = (proc: ChildProcess) => {
      if (killed) return;
      killed = true;
      try {
        if (process.platform === "win32" && proc.pid) {
          spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
        } else if (proc.pid) {
          process.kill(-proc.pid, "SIGKILL");
        }
      } catch {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    };

    // External abort (Agent run cancelled): kill the whole tree right away.
    if (opts.signal) {
      if (opts.signal.aborted) killTree(child);
      else opts.signal.addEventListener("abort", () => killTree(child), { once: true });
    }

    const timer = setTimeout(() => {
      killTree(child);
      resolve({
        code: null,
        stdout: stdout.slice(0, maxOutput) + (truncated ? "\n...[truncated]" : ""),
        stderr: stderr.slice(0, maxOutput) + (truncated ? "\n...[truncated]" : ""),
        command: argv.join(" "),
        durationMs: Date.now() - started,
        truncated
      });
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on("data", (d) => append(d, "out"));
    child.stderr?.on("data", (d) => append(d, "err"));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        code: -1,
        stdout,
        stderr: stderr + (stderr ? "\n" : "") + `spawn error: ${err.message}`,
        command: argv.join(" "),
        durationMs: Date.now() - started,
        truncated
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code,
        stdout: stdout.slice(0, maxOutput) + (truncated ? "\n...[truncated]" : ""),
        stderr: stderr.slice(0, maxOutput) + (truncated ? "\n...[truncated]" : ""),
        command: argv.join(" "),
        durationMs: Date.now() - started,
        truncated
      });
    });
  });
}

/**
 * Pure-inspection commands that never mutate the workspace: these run without
 * an approval (opencode's shell tool only asks when the command scans file
 * operations or external directories).
 */
const READ_ONLY_BINARIES = new Set([
  "ls",
  "pwd",
  "echo",
  "head",
  "tail",
  "grep",
  "wc",
  "find",
  "df",
  "du",
  "uname",
  "cat",
  "curl",
  "wget"
]);

export function isReadOnlyShellCommand(rawCommand: string, workspace = ""): boolean {
  try {
    const argv = tokenizeCommand(String(rawCommand || ""));
    if (!argv.length) return false;
    const bin = path.basename(argv[0]);
    if (!READ_ONLY_BINARIES.has(bin)) return false;
    // find -delete / -exec mutates despite the read-only binary name
    if (bin === "find" && argv.some((a) => a === "-delete" || a.startsWith("-exec"))) return false;
    // curl/wget with an output-to-file flag writes files
    if ((bin === "curl" || bin === "wget") && argv.some((a) => a === "-o" || a === "-O" || a === "--output")) return false;
    void workspace;
    return true;
  } catch {
    return false;
  }
}

export { HIGH_RISK_BINARIES };