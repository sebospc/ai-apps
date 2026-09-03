/**
 * An agent walks the skill, and we read what the developer would have seen.
 *
 * `rehearse.mjs` proves the CLI and the server agree. This proves the other half: that an agent
 * handed nothing but `skills/review/SKILL.md` runs the right commands and turns the answer into a
 * conversation — a verdict, then numbered findings — without ever showing the developer an id, a
 * fingerprint, a piece of JSON or a command to type. That half has no unit test and cannot have
 * one: the only way to know is to run a real session and read the transcript.
 *
 *   scripts/ensure_db.sh
 *   uv run uvicorn smith.main:app --port 8099 &
 *   node scripts/walk_skill.mjs [claude|cursor]
 *
 * Both editors are walked by the same assertions on purpose. A skill that reads well in one and
 * leaks a review id in the other is a skill that is only half written, and the two sessions differ
 * in everything except what the developer is allowed to see: Claude Code namespaces the skill and
 * is invoked with `/smith:review`, Cursor gives it no name at all and has to be asked in words.
 *
 * The session runs on the host's own editor login and therefore inherits whatever global
 * configuration the host has. That is also what a developer's session looks like, so the walk is
 * read as evidence about the skill, not about a laboratory.
 *
 * Env: SMITH_API_URL, SMITH_CORPUS.
 */

import { execFileSync } from "node:child_process";
import {
  accessSync,
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { bootstrapProject, buildRepo, INJECTED_FIXES, introduceProblems } from "./lib/corpus_repo.mjs";

const API = process.env.SMITH_API_URL ?? "http://localhost:8099";
const REPO_ROOT = new URL("..", import.meta.url).pathname;
const PLUGIN_DIR = join(REPO_ROOT, "plugin");
const OUTPUT_DIR = join(REPO_ROOT, "output");

const LEAD_EMAIL = "rehearsal@smith.test";
const LEAD_PASSWORD = "rehearsal-password";

// A session that reasons over six real Java files is minutes of work, not seconds.
const SESSION_TIMEOUT_MS = 15 * 60 * 1000;

let passed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// --------------------------------------------------------------------------------------------
// the two editors
// --------------------------------------------------------------------------------------------

/**
 * How to open a review in each editor, and how to read the commands back out of its stream.
 *
 * `--output-format stream-json` is the only way to see the commands the agent ran; printing the
 * last message alone loses them, and the commands are half of what this script asserts. The two
 * streams agree on assistant messages and disagree on everything else, so only the shell call has
 * to be read per editor.
 */
const EDITORS = {
  claude: {
    binary: "claude",
    // Claude Code namespaces a plugin skill, so the developer types the command.
    prompt: "/smith:review",
    args: (prompt) => [
      "--plugin-dir",
      PLUGIN_DIR,
      "-p",
      prompt,
      "--allowedTools",
      "Bash,Read,Glob,Grep",
      "--output-format",
      "stream-json",
      "--verbose",
    ],
    transcript: (date) => `rehearsal-${date}.txt`,
    shellCommands: (messages) =>
      messages
        .filter((m) => m.type === "assistant")
        .flatMap((m) => m.message?.content ?? [])
        .filter((block) => block.type === "tool_use" && block.name === "Bash")
        .map((block) => String(block.input?.command ?? "")),
  },
  cursor: {
    binary: "cursor-agent",
    // Cursor loads every plugin under ~/.cursor/plugins/local as well as the one `--plugin-dir`
    // names, and the agent picks whichever skill it reads first. An install left over from an
    // older checkout therefore reviews with an older CLI and the walk quietly stops being evidence
    // about this repository — one cost four minutes to diagnose. Refresh an install that is
    // already there; never create one, because installing behind a developer's back is worse.
    beforeSession: () => {
      const installed = join(homedir(), ".cursor", "plugins", "local", "smith");
      if (!existsSync(installed)) return;
      cpSync(PLUGIN_DIR, installed, { recursive: true });
      console.log(`refreshed the Cursor install at ${installed}`);
    },
    // Cursor gives a plugin skill no name and no namespace: the agent picks it from its
    // description, so the walk asks the way the README tells a developer to ask.
    prompt: "review this change with Smith",
    // `--force` is this CLI's non-interactive shell approval. Without it a headless run stalls on
    // the first command instead of failing, and there is nobody here to approve one.
    args: (prompt) => ["--plugin-dir", PLUGIN_DIR, "-p", prompt, "--output-format", "stream-json", "--force"],
    transcript: (date) => `rehearsal-cursor-${date}.txt`,
    shellCommands: (messages) =>
      messages
        .filter((m) => m.type === "tool_call" && m.subtype === "started")
        .map((m) => String(m.tool_call?.shellToolCall?.args?.command ?? ""))
        .filter(Boolean),
  },
};

// --------------------------------------------------------------------------------------------
// the session
// --------------------------------------------------------------------------------------------

/**
 * PATH with every directory holding a foreign `smith` removed.
 *
 * The walk asks whether the *skill* leads the agent to the CLI, and any `smith` the host happens to
 * have installed answers that question for it. This machine had one: a v0 binary left in a Claude
 * Code plugin cache, which the first Cursor walk found and ran, and which replies to `plan` with
 * `no active smith-review`. Claude Code puts the loaded plugin's `bin/` back on PATH itself, so
 * removing them costs that editor nothing and leaves Cursor where a real Cursor install leaves it.
 *
 * Foreign means a different CLI, not any CLI. `plugin/README.md` offers to symlink this repository's
 * own `bin/smith` next to `node`, and dropping that directory would take `node` and the editor's own
 * toolchain with it — the walk would fail for a reason that has nothing to do with the skill.
 */
function pathWithoutForeignSmith() {
  const ours = realpathSync(join(PLUGIN_DIR, "bin", "smith"));
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  return dirs
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

/** Run the review in a real editor session and return its message stream. */
function runSession(editor, repo, home) {
  const args = editor.args(editor.prompt);
  const env = { ...process.env, SMITH_HOME: home, PATH: pathWithoutForeignSmith() };
  // The plugin is not on PATH in either editor after a real install, so this is the developer's
  // setup: whatever the agent finds, it finds by reading the skill.
  delete env.SMITH_URL;
  delete env.SMITH_KEY;

  let stdout = "";
  try {
    stdout = execFileSync(editor.binary, args, {
      cwd: repo,
      env,
      encoding: "utf8",
      timeout: SESSION_TIMEOUT_MS,
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (err) {
    // A blocking verdict makes the agent's last command exit non-zero, which can end the session
    // non-zero too. The stream is still what matters.
    stdout = err.stdout ?? "";
    if (!stdout) throw new Error(`the session did not run: ${err.stderr || err.message}`);
  }
  return stdout
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
}

/** What the agent said, in order — the only part of the session a developer ever sees. */
function developerText(messages) {
  return messages
    .filter((m) => m.type === "assistant")
    .flatMap((m) => m.message?.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n\n")
    .trim();
}

// --------------------------------------------------------------------------------------------
// what a developer must never be shown
// --------------------------------------------------------------------------------------------

/**
 * The four things the skill's "Never" section forbids, each as the shape it would actually take.
 *
 * A quoted key is what leaked JSON looks like once it reaches prose; forty hex characters are what
 * a fingerprint looks like; a fenced block holding a `smith` command is an instruction to run it
 * whether or not the sentence around it says "run this".
 */
const FORBIDDEN = [
  { what: "raw JSON", pattern: /\{\s*"[a-z_]+"\s*:/i },
  { what: "a fingerprint", pattern: /\b[0-9a-f]{40}\b|\bfingerprint\b/i },
  { what: "a review id", pattern: /\breview[ _]id\b/i },
  // Our words for our own machinery. The developer knows files, lines and "that one is wrong".
  { what: "a word only this product uses", pattern: /\bdispositions?\b|\bsuppress(ed|ion)?\b/i },
  { what: "a command for the developer to run", pattern: /```[a-z]*\s*\n[^`]*\bsmith\s+\w/i },
  {
    what: "an instruction to run a command",
    pattern: /\b(you|please)\s+(can\s+|should\s+|could\s+|need\s+to\s+|must\s+)?run\b/i,
  },
];

function firstMatch(text, pattern) {
  const found = text.match(pattern);
  if (!found) return "";
  const line = text.slice(0, found.index).split("\n").length;
  return `line ${line}: ${found[0].slice(0, 80)}`;
}

// --------------------------------------------------------------------------------------------
// the walk
// --------------------------------------------------------------------------------------------

function writeTranscript(path, { editor, repo, slug, target, commands, text }) {
  const invocation = [editor.binary, ...editor.args(editor.prompt)]
    .map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg))
    .join(" ");
  const header = [
    `# Smith skill walk — ${new Date().toISOString()}`,
    `# project ${slug} · change in ${target} · repository ${repo}`,
    `# ${invocation}`,
    "",
    "## Commands the agent ran",
    "",
    ...(commands.length ? commands.map((c) => `$ ${c}`) : ["(none)"]),
    "",
    "## What the developer saw",
    "",
  ];
  writeFileSync(path, `${header.join("\n")}${text}\n`);
}

async function main() {
  const name = process.argv[2] ?? "claude";
  const editor = EDITORS[name];
  if (!editor) {
    console.error(`unknown editor "${name}" — one of: ${Object.keys(EDITORS).join(", ")}`);
    process.exit(1);
  }

  const health = await fetch(`${API}/health`).catch(() => null);
  if (!health?.ok) {
    console.error(
      `nothing is answering at ${API}. Start it with:\n  uv run uvicorn smith.main:app --port 8099`
    );
    process.exit(1);
  }

  const slug = `walk-${Date.now().toString(36)}`;
  const key = bootstrapProject(slug, LEAD_EMAIL, LEAD_PASSWORD);
  const { repo, target } = buildRepo("smith-walk-repo-");
  const home = mkdtempSync(join(tmpdir(), "smith-walk-home-"));
  introduceProblems(repo, target);
  execFileSync("node", [join(PLUGIN_DIR, "bin", "smith"), "auth", "--url", API, "--key", key], {
    env: { ...process.env, SMITH_HOME: home },
    stdio: "ignore",
  });

  editor.beforeSession?.();
  console.log(`api ${API} · project ${slug} · change in ${target} · editor ${name}`);
  console.log(`asking ${editor.binary} for "${editor.prompt}", this takes a few minutes\n`);

  let messages;
  try {
    messages = runSession(editor, repo, home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }

  const text = developerText(messages);
  const commands = editor.shellCommands(messages);
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const transcript = join(OUTPUT_DIR, editor.transcript(new Date().toISOString().slice(0, 10)));
  writeTranscript(transcript, { editor, repo, slug, target, commands, text });
  rmSync(repo, { recursive: true, force: true });
  console.log(`transcript: ${transcript}\n`);

  const ran = (verb) => commands.some((c) => new RegExp(`smith(["']?\\s|\\s)[^|]*\\b${verb}\\b`).test(c));
  check("the agent asked the server for a plan", ran("plan"), commands.join(" ; ").slice(0, 300));
  check("the agent submitted its own findings", ran("submit"), commands.join(" ; ").slice(0, 300));
  // The plan carries no code, so the agent has to fetch the change itself. The first walk piped the
  // diff through `head -80`: a review of part of a change, with nothing saying which part was lost.
  const truncated = commands.find((c) => /\b(git\s+diff|git\s+show)\b[^\n]*\|[^\n]*\b(head|tail)\b/.test(c));
  check("the agent read the whole change, not the first screen of it", !truncated, truncated);
  check("the agent said something to the developer", text.length > 0);
  check(
    "the verdict is stated in the developer's words",
    /(^|\n)\s*[*_#>-]*\s*(blocked|clear)\b/i.test(text),
    text.slice(0, 200)
  );
  check(
    "the findings are numbered, so the developer can point at one",
    /(^|\n)\s*1[.)]\s+\S/.test(text) && /(^|\n)\s*2[.)]\s+\S/.test(text),
    text.slice(0, 400)
  );
  // The server computed a fix for each of these and the developer is the person who has to make the
  // change. A numbered line that names the problem and stops sends them to go and ask someone.
  //
  // Several numbered lines can be about the same code — the agent adds its own findings next to the
  // server's — so the question is whether the fix reached the developer, not which line carries it.
  const numbered = text.split("\n").filter((line) => /^\s*\d+[.)]\s+\S/.test(line));
  for (const { what, finding, fix } of INJECTED_FIXES) {
    const lines = numbered.filter((candidate) => finding.test(candidate));
    check(
      `the ${what} finding is shown with the fix the server named`,
      lines.some((candidate) => fix.test(candidate)),
      lines.join(" / ") || "no numbered line mentions it at all"
    );
  }
  for (const { what, pattern } of FORBIDDEN) {
    check(`the developer is never shown ${what}`, !pattern.test(text), firstMatch(text, pattern));
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`\nwalk failed: ${err.message}${err.cause ? ` (${err.cause})` : ""}`);
  process.exit(1);
});
