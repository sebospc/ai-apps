/**
 * One real editor session, run headless, read back as text and tool calls.
 *
 * The plumbing is `walk_skill.mjs`'s, copied for the same reason `plain_repo.mjs` is: that file
 * runs a walk on import. Only Claude Code is here — the scored set spends its budget on more runs
 * of the same case rather than on a second editor, and the thing being scored is the command, which
 * both editors read identically.
 */

import { execFileSync } from "node:child_process";
import { accessSync, constants, cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
export const PLUGIN_DIR = join(REPO_ROOT, "plugin");

// A session that reads 50 files and searches the repository is minutes of work.
export const SESSION_TIMEOUT_MS = 15 * 60 * 1000;

const SHELL_TOOL = "Bash";

function toolDetail(args) {
  if (!args || typeof args !== "object") return "";
  const named = args.command ?? args.pattern ?? args.query ?? args.path ?? args.file_path ?? args.filePath;
  return named === undefined ? JSON.stringify(args).slice(0, 400) : String(named);
}

/**
 * PATH with every directory holding a `smith` that is not this checkout's removed.
 *
 * A stale binary elsewhere on the host answers `plan` with `no active smith-review`, and the run
 * then scores the host instead of the command.
 */
function pathWithoutForeignSmith() {
  const ours = realpathSync(join(PLUGIN_DIR, "bin", "smith"));
  return (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .filter((dir) => {
      const candidate = join(dir, "smith");
      try {
        accessSync(candidate, constants.X_OK);
      } catch {
        return true;
      }
      try {
        return realpathSync(candidate) === ours;
      } catch {
        return false;
      }
    })
    .join(delimiter);
}

/**
 * A copy of the plugin with one command file replaced by an older revision of itself.
 *
 * This is how a case is shown to measure something: the same repository, the same prompt, and a
 * command that should miss the planted defect. `plugin/` on disk is never touched — a scored set
 * that edits the thing it scores is a scored set that scores itself.
 */
export function pluginWithCommandAt(sha, command = "smith-review") {
  const dir = mkdtempSync(join(tmpdir(), "smith-score-plugin-"));
  const target = join(dir, "smith");
  cpSync(PLUGIN_DIR, target, { recursive: true });
  const older = execFileSync("git", ["show", `${sha}:plugin/commands/${command}.md`], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  const file = join(target, "commands", `${command}.md`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, older);
  return target;
}

/** Run one session and return `{ text, toolCalls, commands }`. */
export function runSession({ prompt, tools, repo, home, pluginDir }) {
  const args = [
    "--plugin-dir",
    pluginDir,
    "-p",
    prompt,
    "--allowedTools",
    tools,
    "--output-format",
    "stream-json",
    "--verbose",
  ];
  const env = { ...process.env, SMITH_HOME: home, PATH: pathWithoutForeignSmith() };
  delete env.SMITH_URL;
  delete env.SMITH_KEY;

  let stdout = "";
  let failure = "";
  try {
    stdout = execFileSync("claude", args, {
      cwd: repo,
      env,
      encoding: "utf8",
      timeout: SESSION_TIMEOUT_MS,
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (err) {
    // A blocking verdict makes the agent's last command exit non-zero, which can end the session
    // non-zero too. The stream is still the reading.
    stdout = err.stdout ?? "";
    failure = err.stderr || err.message;
  }

  const messages = stdout
    .split("\n")
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const toolCalls = messages
    .filter((m) => m.type === "assistant")
    .flatMap((m) => m.message?.content ?? [])
    .filter((block) => block.type === "tool_use")
    .map((block) => ({ name: String(block.name ?? "tool"), detail: toolDetail(block.input) }));

  const text = messages
    .filter((m) => m.type === "assistant")
    .flatMap((m) => m.message?.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n\n")
    .trim();

  return {
    text,
    toolCalls,
    commands: toolCalls.filter((c) => c.name === SHELL_TOOL).map((c) => c.detail).filter(Boolean),
    // An empty stream is a session that did not run, which must never be scored as a review that
    // found nothing. The caller decides; it is not silently a zero.
    ran: messages.length > 0,
    failure: messages.length > 0 ? "" : failure,
  };
}

/** A search of what is inside files. Listing names is not one, and neither is reading four. */
export function searchesOf(toolCalls) {
  return toolCalls.filter(({ name, detail }) =>
    name === SHELL_TOOL ? /\b(grep|rg|ag|ack)\b/.test(detail) : /grep|search|codebase/i.test(name)
  );
}

export function seedCredentials(home, api, key) {
  execFileSync("node", [join(PLUGIN_DIR, "bin", "smith"), "auth", "--url", api, "--key", key], {
    env: { ...process.env, SMITH_HOME: home },
    stdio: "ignore",
  });
}

export const hasEditor = () => {
  try {
    execFileSync("claude", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

export { existsSync };
