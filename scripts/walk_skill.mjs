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
 *   uv run python scripts/seed_catalog.py          # the apply walk reads the catalog
 *   node scripts/walk_skill.mjs [claude|cursor] [review|apply|apply-ask]
 *
 * `review` reasons over real code and argues about it. `apply` starts from a developer asking for a
 * feature and ends with code in a project it had to read first. `apply-ask` is the same feature
 * asked for as a bare symptom, and it reads for the opposite ending: a question, and an untouched
 * checkout, because nothing in the prompt says what to build.
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
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

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

const SHELL_TOOL = "Bash";

/**
 * The one argument of a tool call worth reading back — the command, or whatever it pointed at.
 *
 * A named argument is kept whole. A shell command is read by the checks, and one clipped at some
 * length could hide the `| head` that a check exists to find; only the unrecognised shapes, which
 * are whole JSON blobs, are cut down to keep the transcript readable.
 */
function toolDetail(args) {
  if (!args || typeof args !== "object") return "";
  const named =
    args.command ?? args.path ?? args.file_path ?? args.filePath ?? args.pattern ?? args.query;
  return named === undefined ? JSON.stringify(args).slice(0, 400) : String(named);
}

/** The shell half of a session, which is the only part the checks read. */
function shellCommandsOf(toolCalls) {
  return toolCalls.filter((call) => call.name === SHELL_TOOL).map((call) => call.detail).filter(Boolean);
}

/**
 * How to open a review in each editor, and how to read the tool calls back out of its stream.
 *
 * `--output-format stream-json` is the only way to see what the agent did; printing the last
 * message alone loses it, and half of what this script asserts is about the commands. Every tool
 * call is read, not only the shell ones: Cursor reads a checkout with its own file tools, so a
 * shell-only transcript cannot tell an agent that skipped step 2 from one that did it with
 * `read_file`. The two streams agree on assistant messages and disagree on everything else.
 */
const EDITORS = {
  claude: {
    binary: "claude",
    args: (prompt, tools) => [
      "--plugin-dir",
      PLUGIN_DIR,
      "-p",
      prompt,
      "--allowedTools",
      tools,
      "--output-format",
      "stream-json",
      "--verbose",
    ],
    suffix: "",
    toolCalls: (messages) =>
      messages
        .filter((m) => m.type === "assistant")
        .flatMap((m) => m.message?.content ?? [])
        .filter((block) => block.type === "tool_use")
        .map((block) => ({ name: String(block.name ?? "tool"), detail: toolDetail(block.input) })),
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
    // `--force` is this CLI's non-interactive shell approval. Without it a headless run stalls on
    // the first command instead of failing, and there is nobody here to approve one.
    args: (prompt) => ["--plugin-dir", PLUGIN_DIR, "-p", prompt, "--output-format", "stream-json", "--force"],
    suffix: "-cursor",
    // One `tool_call` message carries one `<name>ToolCall` key — `shellToolCall`, `readToolCall`,
    // `globToolCall`. Reading the key rather than a list of names keeps a tool this CLI adds later
    // in the transcript instead of silently dropping it.
    toolCalls: (messages) =>
      messages
        .filter((m) => m.type === "tool_call" && m.subtype === "started")
        .map((m) => {
          const found = Object.entries(m.tool_call ?? {}).find(([key]) => key.endsWith("ToolCall"));
          if (!found) return null;
          const [key, call] = found;
          const name = key.replace(/ToolCall$/, "");
          return { name: name === "shell" ? SHELL_TOOL : name, detail: toolDetail(call?.args) };
        })
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

/** Run one session in a real editor and return its message stream. */
function runSession(editor, args, repo, home) {
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
 * What the skills' "Never" sections forbid, each as the shape it would actually take.
 *
 * A quoted key is what leaked JSON looks like once it reaches prose; forty hex characters are what
 * a fingerprint looks like; a fenced block holding a `smith` command is an instruction to run it
 * whether or not the sentence around it says "run this".
 */
const FORBIDDEN = [
  { what: "raw JSON", pattern: /\{\s*"[a-z_]+"\s*:/i },
  { what: "a command for the developer to run", pattern: /```[a-z]*\s*\n[^`]*\bsmith\s+\w/i },
];

const REVIEW_FORBIDDEN = [
  { what: "a fingerprint", pattern: /\b[0-9a-f]{40}\b|\bfingerprint\b/i },
  { what: "a review id", pattern: /\breview[ _]id\b/i },
  // Our words for our own machinery. The developer knows files, lines and "that one is wrong".
  { what: "a word only this product uses", pattern: /\bdispositions?\b|\bsuppress(ed|ion)?\b/i },
  // A review asks the developer for nothing but an answer in prose, so any "you can run" in it is
  // the agent handing back its own work. An applied feature ends in a build they do have to run,
  // which is why this one is the review's and not shared.
  {
    what: "an instruction to run a command",
    pattern: /\b(you|please)\s+(can\s+|should\s+|could\s+|need\s+to\s+|must\s+)?run\b/i,
  },
];

const APPLY_FORBIDDEN = [
  // The id as a word in a sentence, which would be Smith's vocabulary handed to a developer. Not
  // the same string inside a path: the first walk to reach code named its spec file after the
  // feature, `duplicate-order-prevention-spec.md`, and a file named after what it describes is a
  // good name rather than a leak.
  { what: "the id of the entry it applied", pattern: /(?<![\w/`-])duplicate-order-prevention(?![\w-]|[./][\w])/ },
  { what: "a word only this product uses", pattern: /\bcatalog entr(y|ies)\b|\bintegration block\b/i },
];

function firstMatch(text, pattern) {
  const found = text.match(pattern);
  if (!found) return "";
  const line = text.slice(0, found.index).split("\n").length;
  return `line ${line}: ${found[0].slice(0, 80)}`;
}

// --------------------------------------------------------------------------------------------
// the two walks
// --------------------------------------------------------------------------------------------

/**
 * A minimal SAP Commerce project: a manifest, a registration file and one custom extension.
 *
 * The apply skill's second step is reading the project before writing anything, so the walk has to
 * hand it a project with something to find. It is written here rather than taken from the corpus
 * for two reasons: the transcript stays free of a client's extension names, and what the agent
 * should have found is known exactly — one extension already there, one platform extension the
 * entry needs and the project has not enabled, and none of the feature's item types declared.
 */
const PROJECT_EXTENSION = "acmecore";
const UNENABLED_PLATFORM_EXTENSION = "commercefacades";
const LOCALEXTENSIONS = "core-customize/hybris/config/localextensions.xml";
const PROJECT_ITEMS = `core-customize/hybris/bin/custom/${PROJECT_EXTENSION}/resources/${PROJECT_EXTENSION}-items.xml`;
const PROJECT_ITEM_TYPE = "AcmeOpeningHours";
// Typecodes are unique across the whole platform, so this one being taken is a fact about the
// project the agent can only learn by reading it.
const PROJECT_TYPECODE = "12100";

const SKELETON = {
  "core-customize/manifest.json": `${JSON.stringify(
    { commerceSuiteVersion: "2211", extensions: ["commerceservices", "commercewebservices"] },
    null,
    2
  )}\n`,
  // `commercefacades` and `processing` are left out on purpose: the entry needs both, and what the
  // agent does about a platform extension the project has not enabled is the half of step 2 that a
  // developer feels — named and carried on with, not silently assumed.
  [LOCALEXTENSIONS]: `<?xml version="1.0" encoding="ISO-8859-1"?>
<hybrisconfig xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <extensions>
    <path dir="\${HYBRIS_BIN_DIR}"/>
    <extension name="commerceservices"/>
    <extension name="commercewebservices"/>
    <extension dir="\${HYBRIS_BIN_DIR}/custom/${PROJECT_EXTENSION}"/>
  </extensions>
</hybrisconfig>
`,
  [`core-customize/hybris/bin/custom/${PROJECT_EXTENSION}/extensioninfo.xml`]: `<?xml version="1.0" encoding="UTF-8"?>
<extensioninfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <extension abstractclassprefix="Generated" classprefix="Acme" name="${PROJECT_EXTENSION}">
    <requires-extension name="commerceservices"/>
    <coremodule generated="true" packageroot="com.acme.core"/>
  </extension>
</extensioninfo>
`,
  [PROJECT_ITEMS]: `<?xml version="1.0" encoding="UTF-8"?>
<items xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="items.xsd">
  <itemtypes>
    <itemtype code="${PROJECT_ITEM_TYPE}" extends="GenericItem" autocreate="true" generate="true">
      <deployment table="acmeopeninghours" typecode="${PROJECT_TYPECODE}"/>
      <attributes>
        <attribute qualifier="code" type="java.lang.String">
          <persistence type="property"/>
        </attribute>
      </attributes>
    </itemtype>
  </itemtypes>
</items>
`,
};

function buildCommerceProject() {
  const repo = mkdtempSync(join(tmpdir(), "smith-apply-repo-"));
  for (const [path, contents] of Object.entries(SKELETON)) {
    mkdirSync(join(repo, dirname(path)), { recursive: true });
    writeFileSync(join(repo, path), contents);
  }
  const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "dev@acme.com");
  git("config", "user.name", "Walk");
  git("add", ".");
  git("commit", "-q", "-m", "a project with one extension in it");
  return { repo, about: `a project holding ${PROJECT_EXTENSION}` };
}

/** Every path the session wrote or changed, so what the developer got is read off the disk. */
function filesWritten(repo) {
  return execFileSync("git", ["status", "--porcelain", "-uall"], { cwd: repo, encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3).trim());
}

/**
 * One string per `<itemtype>` declaration, so a check reads a single type rather than the whole
 * file. Matching across a file would let one type's code and another's typecode satisfy the same
 * pattern, which is how an assertion about collisions comes out green on a collision.
 */
function itemtypes(xml) {
  return xml.split(/<itemtype\b/).slice(1);
}

function contentsOf(repo, path) {
  try {
    return readFileSync(join(repo, path), "utf8");
  } catch {
    return "";
  }
}

function reviewChecks({ repo, text, commands }) {
  const ran = (verb) => commands.some((c) => new RegExp(`smith(["\']?\\s|\\s)[^|]*\\b${verb}\\b`).test(c));
  check("the agent asked the server for a plan", ran("plan"), commands.join(" ; ").slice(0, 300));
  check("the agent submitted its own findings", ran("submit"), commands.join(" ; ").slice(0, 300));
  // The plan carries no code, so the agent has to fetch the change itself. The first walk piped the
  // diff through `head -80`: a review of part of a change, with nothing saying which part was lost.
  const truncated = commands.find((c) => /\b(git\s+diff|git\s+show)\b[^\n]*\|[^\n]*\b(head|tail)\b/.test(c));
  check("the agent read the whole change, not the first screen of it", !truncated, truncated);
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
}

function applyChecks({ repo, text, commands }) {
  const catalogCalls = commands.filter((c) => /\bcatalog\b/.test(c));
  check("the agent read the catalog before choosing", catalogCalls.length > 0, commands.join(" ; ").slice(0, 300));
  check(
    "the agent read the entry it chose, in full",
    catalogCalls.some((c) => /\bcatalog\s+["\']?[a-z][a-z0-9-]+/.test(c)),
    catalogCalls.join(" ; ").slice(0, 300)
  );

  // Step 2 of the skill, read from the developer's side: what it says it found has to be what is
  // actually in this project. `acmecore` exists nowhere else, so naming it is proof it looked.
  check(
    "the agent said which extension the project already has",
    new RegExp(PROJECT_EXTENSION, "i").test(text),
    text.slice(0, 400)
  );
  check(
    "the agent named the platform extension the project has not enabled",
    new RegExp(UNENABLED_PLATFORM_EXTENSION, "i").test(text),
    text.slice(0, 400)
  );

  const written = filesWritten(repo);
  const declared = written
    .filter((path) => /items\.xml$/i.test(path))
    .map((path) => contentsOf(repo, path));
  check(
    "the feature's item type was declared where it belongs",
    declared.some((xml) => /OrderUniqueIndex/.test(xml)),
    written.join(" ; ").slice(0, 300)
  );
  check(
    "the code came with its registration, so the extension would load",
    /duplicateorder/i.test(contentsOf(repo, LOCALEXTENSIONS)),
    contentsOf(repo, LOCALEXTENSIONS).slice(0, 300)
  );
  check(
    "the developer got code, not only a plan",
    written.some((path) => /\.(java|ts|impex)$/i.test(path)),
    written.join(" ; ").slice(0, 300)
  );
  // The one mistake step 2 exists to prevent. Adding a type next to somebody's is ordinary work —
  // the first walk to reach code put the feature's type in the project's own extension, because the
  // project prefixes everything `acme` and the entry's names did not fit. What is forbidden is
  // losing the type that was already there, or handing the new one the typecode it was using.
  const survivor = itemtypes(contentsOf(repo, PROJECT_ITEMS)).find((block) =>
    block.includes(`code="${PROJECT_ITEM_TYPE}"`)
  );
  check(
    "the project's own item type survived",
    Boolean(survivor) && survivor.includes(`typecode="${PROJECT_TYPECODE}"`),
    (survivor ?? "the type is no longer declared").slice(0, 300)
  );
  const stolen = declared
    .flatMap(itemtypes)
    .find(
      (block) =>
        block.includes(`typecode="${PROJECT_TYPECODE}"`) && !block.includes(`code="${PROJECT_ITEM_TYPE}"`)
    );
  check("the taken typecode was not handed to the feature's type", !stolen, (stolen ?? "").slice(0, 300));

  const specs = written
    .filter((path) => /\.(md|markdown)$/i.test(path))
    .map((path) => contentsOf(repo, path));
  check(
    "the specs were written as conditions, with acceptance criteria",
    specs.some((doc) => /\bgiven\b/i.test(doc) && /accept|criteri/i.test(doc)),
    written.filter((path) => /\.md$/i.test(path)).join(" ; ") || "no document was written"
  );
}

/**
 * The walk where the developer says only the symptom.
 *
 * `runSession` is one non-interactive call, so there is nobody here to answer a question. That is
 * the point rather than a limitation: an agent that cannot know what to build must stop and ask,
 * and one that writes a schema out of its own head instead is the defect this reads for.
 */
function applyAskChecks({ repo, text, commands }) {
  check(
    "the agent read the catalog before choosing",
    commands.some((c) => /\bcatalog\b/.test(c)),
    commands.join(" ; ").slice(0, 300)
  );
  // The end of the conversation, not any part of it. A question in the middle, followed by an
  // implementation, is an agent answering itself.
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const ending = paragraphs.slice(-2).join("\n\n");
  check("the session ended by asking the developer something", /\?/.test(ending), ending.slice(-300));
  const guessed = filesWritten(repo).filter((path) => /\.java$/i.test(path));
  check("no code was written from a guess", guessed.length === 0, guessed.join(" ; ").slice(0, 300));
}

/** The apply walks read the catalog off the server, so an unseeded one has to fail by name. */
async function catalogIsLoaded(key) {
  const listed = await fetch(`${API}/v1/catalog`, { headers: { authorization: `Bearer ${key}` } });
  const entries = listed.ok ? (await listed.json()).entries : [];
  if (!entries.some((entry) => entry.id === "duplicate-order-prevention")) {
    throw new Error(
      "the catalog does not hold duplicate-order-prevention — load it with:\n" +
        "  uv run python scripts/seed_catalog.py"
    );
  }
}

/**
 * One walk per skill: what the developer says, what the agent may do, the project it lands in, and
 * what the transcript has to prove.
 *
 * `review` reasons over somebody else's Java and argues about it. `apply` starts from a developer
 * asking for a feature in their own words and ends with code in a project the agent had to read
 * first — which is why it is asked in words in both editors: matching what they said against the
 * catalog is the first thing the skill does, and naming the entry would skip it.
 */
/**
 * What the developer says, once. The three sentences after the first are this entry's `ask` list
 * answered: which checkout, what the losing submit shows, how long a lock lives.
 */
const APPLY_REQUEST =
  "buyers keep placing the same order twice when they double-click Place Order. It is the B2B " +
  "accelerator checkout. When the second submit loses, show the first order's confirmation. " +
  "Clear abandoned locks after a day. Go ahead and write it.";

/**
 * The same feature, asked for the way a developer actually asks: the symptom and nothing else.
 *
 * Not one of the entry's three `ask` items is answered here — not which checkout, not what the
 * losing submit shows, not how long a lock lives — and there is no "go ahead" either. So the only
 * correct end to this session is a question, and step 3 of the skill finally runs.
 */
const APPLY_SYMPTOM =
  "buyers are placing the same order twice when they double-click, can you fix that";

const WALKS = {
  review: {
    // Claude Code namespaces a plugin skill, so the developer types the command. Cursor gives it no
    // name at all: the agent picks it from its description, so the walk asks the way the README
    // tells a developer to ask.
    prompts: { claude: "/smith:review", cursor: "review this change with Smith" },
    tools: "Bash,Read,Glob,Grep",
    transcript: "rehearsal",
    setup: () => {
      const { repo, target } = buildRepo("smith-walk-repo-");
      introduceProblems(repo, target);
      return { repo, about: `change in ${target}` };
    },
    forbidden: [...FORBIDDEN, ...REVIEW_FORBIDDEN],
    checks: reviewChecks,
  },
  apply: {
    // The developer's request and the answers to the entry's three questions in one message. A
    // headless session has nobody to answer a question, and the skill is right to ask one and wait
    // — measured 2026-09-03: asked which checkout it was and stopped, with nothing written. So the
    // walk plays a developer who says everything up front, which is the only shape of this
    // conversation a single-shot session can carry to code.
    prompts: {
      claude: `/smith:apply ${APPLY_REQUEST}`,
      cursor: `with Smith, ${APPLY_REQUEST}`,
    },
    tools: "Bash,Read,Glob,Grep,Write,Edit",
    transcript: "apply-walk",
    setup: buildCommerceProject,
    before: catalogIsLoaded,
    forbidden: [...FORBIDDEN, ...APPLY_FORBIDDEN],
    checks: applyChecks,
  },
  "apply-ask": {
    // Nothing is answered and nothing invites the agent to start, so the same tools that let the
    // `apply` walk reach code are handed over here on purpose: an agent that writes anyway had
    // every chance not to, and the empty checkout afterwards is the measurement.
    prompts: {
      claude: `/smith:apply ${APPLY_SYMPTOM}`,
      cursor: `with Smith, ${APPLY_SYMPTOM}`,
    },
    tools: "Bash,Read,Glob,Grep,Write,Edit",
    transcript: "apply-ask",
    setup: buildCommerceProject,
    before: catalogIsLoaded,
    forbidden: [...FORBIDDEN, ...APPLY_FORBIDDEN],
    checks: applyAskChecks,
  },
};

// --------------------------------------------------------------------------------------------
// the walk
// --------------------------------------------------------------------------------------------

function writeTranscript(path, { editor, args, repo, slug, about, toolCalls, text }) {
  const invocation = [editor.binary, ...args]
    .map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg))
    .join(" ");
  const header = [
    `# Smith skill walk — ${new Date().toISOString()}`,
    `# project ${slug} · ${about} · repository ${repo}`,
    `# ${invocation}`,
    "",
    "## What the agent ran and read",
    "",
    ...(toolCalls.length
      ? toolCalls.map(({ name, detail }) => (name === SHELL_TOOL ? `$ ${detail}` : `${name} ${detail}`))
      : ["(none)"]),
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
  const walkName = process.argv[3] ?? "review";
  const walk = WALKS[walkName];
  if (!walk) {
    console.error(`unknown walk "${walkName}" — one of: ${Object.keys(WALKS).join(", ")}`);
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
  await walk.before?.(key);
  const { repo, about } = walk.setup();
  const home = mkdtempSync(join(tmpdir(), "smith-walk-home-"));
  execFileSync("node", [join(PLUGIN_DIR, "bin", "smith"), "auth", "--url", API, "--key", key], {
    env: { ...process.env, SMITH_HOME: home },
    stdio: "ignore",
  });

  editor.beforeSession?.();
  const prompt = walk.prompts[name];
  const args = editor.args(prompt, walk.tools);
  console.log(`api ${API} · project ${slug} · ${about} · editor ${name} · walk ${walkName}`);
  console.log(`asking ${editor.binary} for "${prompt}", this takes a few minutes\n`);

  let messages;
  try {
    messages = runSession(editor, args, repo, home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }

  const text = developerText(messages);
  const toolCalls = editor.toolCalls(messages);
  const commands = shellCommandsOf(toolCalls);
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const transcript = join(OUTPUT_DIR, `${walk.transcript}${editor.suffix}-${date}.txt`);
  writeTranscript(transcript, { editor, args, repo, slug, about, toolCalls, text });
  console.log(`transcript: ${transcript}\n`);

  check("the agent said something to the developer", text.length > 0);
  // The repository is read by the checks, so it outlives the session and is removed after them.
  try {
    walk.checks({ repo, text, commands });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
  for (const { what, pattern } of walk.forbidden) {
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
