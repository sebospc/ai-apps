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
 *   node scripts/walk_skill.mjs --self-check      # the assertions that have to be able to fail
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

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
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
const IMPEX_STRUCTURE = join(REPO_ROOT, "scripts", "impex_structure.py");

const LEAD_EMAIL = "rehearsal@smith.test";
const LEAD_PASSWORD = "rehearsal-password";

// A session that reasons over six real Java files is minutes of work, not seconds.
const SESSION_TIMEOUT_MS = 15 * 60 * 1000;

// The walk leaves a connection idle for minutes while the editor works, and a pooled socket the
// server has since closed surfaces as ECONNRESET on the next read. Never reuse one — every fetch
// in this file, not only the slow ones: the health check at the top forgot it, and the request that
// paid for it was the cleanup four minutes later, which left the walk's project behind.
const NO_KEEPALIVE = { connection: "close" };

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
 * should have found is known exactly — two extensions already there, one of them wearing a name
 * the entry wants and a bean id the entry's own service wants, one platform extension the entry
 * needs and the project has not enabled, and none of the feature's item types declared.
 */
const PROJECT_EXTENSION = "acmecore";
const UNENABLED_PLATFORM_EXTENSION = "commercefacades";
const LOCALEXTENSIONS = "core-customize/hybris/config/localextensions.xml";
const PROJECT_ITEMS = `core-customize/hybris/bin/custom/${PROJECT_EXTENSION}/resources/${PROJECT_EXTENSION}-items.xml`;
const PROJECT_ITEM_TYPE = "AcmeOpeningHours";
// Typecodes are unique across the whole platform, so this one being taken is a fact about the
// project the agent can only learn by reading it.
const PROJECT_TYPECODE = "12100";

// The entry names `duplicateordercore` among the extensions it creates, so a project that already
// has one is the collision an apply session walks into before any other. It is not an empty
// directory here: this project's is an older, weaker attempt at the same problem, which is exactly
// why the name is taken, and its own service carries the bean id the entry's service wants.
//
// Neither collision fails a build. Two extensions cannot share a name, but the agent creating the
// files never finds that out; two definitions of a bean id are legal and the one loaded last wins.
// So both are things a developer only learns from a diff nobody asked them to read.
const TAKEN_EXTENSION = "duplicateordercore";
const TAKEN_EXTENSION_DIR = `core-customize/hybris/bin/custom/${TAKEN_EXTENSION}`;
const TAKEN_SPRING = `${TAKEN_EXTENSION_DIR}/resources/${TAKEN_EXTENSION}-spring.xml`;
const TAKEN_BEAN = "duplicateOrderService";
const TAKEN_BEAN_CLASS = "com.acme.duplicateorder.AcmeDuplicateOrderService";

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
    <extension dir="\${HYBRIS_BIN_DIR}/custom/${TAKEN_EXTENSION}"/>
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
  [`${TAKEN_EXTENSION_DIR}/extensioninfo.xml`]: `<?xml version="1.0" encoding="UTF-8"?>
<extensioninfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <extension abstractclassprefix="Generated" classprefix="AcmeDuplicateOrder" name="${TAKEN_EXTENSION}">
    <requires-extension name="commerceservices"/>
    <coremodule generated="true" packageroot="com.acme.duplicateorder"/>
  </extension>
</extensioninfo>
`,
  [TAKEN_SPRING]: `<?xml version="1.0" encoding="UTF-8"?>
<beans xmlns="http://www.springframework.org/schema/beans"
       xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
       xsi:schemaLocation="http://www.springframework.org/schema/beans http://www.springframework.org/schema/beans/spring-beans.xsd">
  <bean id="${TAKEN_BEAN}" class="${TAKEN_BEAN_CLASS}"/>
</beans>
`,
  [`${TAKEN_EXTENSION_DIR}/src/com/acme/duplicateorder/AcmeDuplicateOrderService.java`]: `package com.acme.duplicateorder;

import de.hybris.platform.core.model.order.OrderModel;

/** Marks orders that look placed twice, after the fact, for the nightly report. */
public class AcmeDuplicateOrderService {
    public boolean looksDuplicated(final OrderModel order) {
        return order.getCode() != null && order.getPaymentAddress() == null;
    }
}
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
 * Which of the files on disk the agent's own text actually names.
 *
 * The real file list drives the match, never the prose: a plausible path the session never wrote
 * has nothing to match against and counts for nothing. A name on its own is not a path — a
 * developer told "`items.xml`" still has to go looking — so the shortest thing that counts is a
 * directory and a name, which is how both editors write it when they write it at all. The
 * character before the match has to end the previous word, otherwise an invented
 * `otherext/resources/acmecore-items.xml` would pass as the real `resources/acmecore-items.xml`.
 */
function pathsNamedIn(text, written) {
  return written.filter((path) => {
    const segments = path.split("/");
    return segments.some((_, at) => {
      if (at > segments.length - 2) return false;
      const suffix = segments.slice(at).join("/").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(^|[^\\w./-])${suffix}`).test(text);
    });
  });
}

/**
 * One string per `<itemtype>` declaration, so a check reads a single type rather than the whole
 * file. Matching across a file would let one type's code and another's typecode satisfy the same
 * pattern, which is how an assertion about collisions comes out green on a collision.
 */
function itemtypes(xml) {
  return xml.split(/<itemtype\b/).slice(1);
}

/**
 * Whether the session declared `sourceCartCode` on `Order`, in whichever `items.xml` it chose.
 *
 * The entry used to make this conditional on platform sources a CCv2 checkout does not carry, and
 * measured 2026-09-03 the two editors resolved it opposite ways: one added the attribute, the other
 * redesigned around it and hung the cart code off the lock type instead. Two schemas out of one
 * entry. The attribute has to be read on `Order` itself and not anywhere in the file, because the
 * redesign puts that same qualifier one type away.
 */
function declaresOrderSourceCartCode(itemsXml) {
  return itemsXml
    .flatMap(itemtypes)
    .some((block) => /\bcode="Order"/.test(block) && /sourceCartCode/.test(block));
}

/**
 * The class a Spring file binds an id to, or undefined when the id is not bound at all.
 *
 * The id alone answers nothing: a bean rewritten to point somewhere else keeps it, and that is the
 * failure this reads for. Comments are stripped for the same reason `registeredExtensions` strips
 * them — a definition inside `<!-- -->` is not a definition.
 */
function beanClass(xml, id) {
  const tags = xml.replace(/<!--[\s\S]*?-->/g, "").match(/<bean\b[^>]*>/g) ?? [];
  const bound = tags.find((tag) => new RegExp(`\\bid\\s*=\\s*"${id}"`).test(tag));
  return bound ? /\bclass\s*=\s*"([^"]*)"/.exec(bound)?.[1] : undefined;
}

/** The skeleton files under a directory that no longer hold what the walk committed there. */
function changedFromSkeleton(repo, under) {
  return Object.keys(SKELETON).filter(
    (path) => path.startsWith(`${under}/`) && contentsOf(repo, path) !== SKELETON[path]
  );
}

/**
 * Whether the agent told the developer that the extension name it needs is already in this project.
 *
 * The name on its own proves nothing — the entry names `duplicateordercore`, so an agent that
 * happily created one writes the same word — so the name and a word for the collision have to land
 * on the same line, the way `manifest.json` and the extension missing from it do.
 */
function namesExtensionCollision(text) {
  return text
    .split("\n")
    .some(
      (line) =>
        new RegExp(`\\b${TAKEN_EXTENSION}\\b`, "i").test(line) &&
        /\b(already|exist|taken|colli|conflict|clash)/i.test(line)
    );
}

/**
 * The extensions `localextensions.xml` actually registers, by the name the build resolves.
 *
 * Comments are stripped first, because telling registration from the word being somewhere in the
 * file is the whole point: the check this feeds used to be a substring search, which an
 * `<!-- <extension name="..."/> -->` satisfies. Both spellings count — `name` and the last segment
 * of a `dir` — since the fixture project registers its own extension by `dir` and the skill invites
 * the agent to follow the project's layout.
 */
function registeredExtensions(xml) {
  const tags = xml.replace(/<!--[\s\S]*?-->/g, "").match(/<extension\b[^>]*>/g) ?? [];
  return tags.flatMap((tag) => {
    const name = /\bname\s*=\s*"([^"]*)"/.exec(tag)?.[1];
    const dir = /\bdir\s*=\s*"([^"]*)"/.exec(tag)?.[1];
    return [name, dir?.replace(/\/+$/, "").split("/").pop()].filter(Boolean);
  });
}

/**
 * The extensions the session's files landed in, as the directory holding each `extensioninfo.xml`.
 *
 * Read off the disk rather than expected by name, because both layouts the walks have produced are
 * legitimate: one agent created `duplicateordercore` and `duplicateorderfacades` as the entry names
 * them, another put the core half in the project's own `acmecore` and created a single
 * `acmeduplicateorderfacades` next to it. Either way, the extension the code ended up in is the
 * thing the build has to load.
 */
function extensionsWrittenInto(repo, written) {
  const roots = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], {
    cwd: repo,
    encoding: "utf8",
  })
    .split("\n")
    .filter((path) => /(^|\/)extensioninfo\.xml$/i.test(path))
    .map(dirname);
  const owner = (path) => roots.find((root) => path.startsWith(`${root}/`));
  return [...new Set(written.map(owner).filter(Boolean))];
}

/** What a command printed, on either stream, whether or not it exited zero. */
function output(binary, args, cwd) {
  const done = spawnSync(binary, args, { cwd, encoding: "utf8" });
  if (done.error) throw done.error;
  return `${done.stdout ?? ""}${done.stderr ?? ""}`;
}

/**
 * The javac diagnostics that mean "this machine has no SAP Commerce platform", not "this file is
 * broken".
 *
 * Nothing here links — `docs/pergamon.md` records why — so every framework type the session
 * imported is unresolvable and reporting those would fail every correct file. The list stays this
 * short only because `-proc:only` stops javac after it enters the symbols: past that point an
 * unresolved base class also produces a bad `@Override`, an unknown method and an incompatible
 * type, and filtering the consequences would mean guessing a family of codes instead of naming a
 * closed one. These four are all that phase can report about a type it cannot find.
 *
 * The diagnostic *code* is matched and never the message: `-XDrawDiagnostics` prints the code,
 * which is a stable identifier, while the message beside it is prose that changes between JDKs.
 * `static.imp.only.classes.and.interfaces` is here because javac says it about
 * `import static org.mockito.Mockito.when` whenever `org.mockito` is not on the classpath, which is
 * every generated test file on this machine.
 */
const UNRESOLVABLE =
  /^compiler\.err\.(cant\.resolve|doesnt\.exist|cant\.access|static\.imp\.only\.classes\.and\.interfaces)/;

const JAVA_DIAGNOSTIC = /^\S+:(\d+):(\d+): (compiler\.err\.[\w.]+)(?::\s*(.*))?$/;

/**
 * Whether the files the session wrote are files their own parser can read.
 *
 * The floor under "is this code any good", and until now nothing checked it at all: XML that does
 * not parse is not a build failure, it is a platform that refuses to start. Each kind is handed to
 * the parser that will really read it rather than to a pattern written here — `xmllint` for XML,
 * `javac` for Java, and for ImpEx the reviewer's own reader through `scripts/impex_structure.py`,
 * so a file the walk accepts is a file the product accepts.
 */
function structuralProblems(repo, written) {
  const of = (extension) => written.filter((path) => path.toLowerCase().endsWith(extension));
  return [
    ...xmlProblems(repo, of(".xml")),
    ...javaProblems(repo, of(".java")),
    ...impexProblems(repo, of(".impex")),
  ];
}

function xmlProblems(repo, paths) {
  if (!paths.length) return [];
  // xmllint already reports `path:line: parser error : what`, which is what a developer needs and
  // "the xml is invalid" is not. Only the lines it prefixes with a path we asked about are kept:
  // the rest of a report is the offending source line and a caret under it.
  return output("xmllint", ["--noout", ...paths], repo)
    .split("\n")
    .filter((line) => paths.some((path) => line.startsWith(`${path}:`)));
}

function javaProblems(repo, paths) {
  if (!paths.length) return [];
  // One file per call, because `-XDrawDiagnostics` prints a file's simple name and two extensions
  // may each hold a `Cache.java`. A file read alone cannot see its siblings either, but that reads
  // as an unresolved symbol and is filtered with the platform's. `-proc:only` writes no class file,
  // so there is nothing to put in a `-d` directory and none is made.
  return paths.flatMap((path) =>
    output("javac", ["-XDrawDiagnostics", "-proc:only", "-nowarn", path], repo)
      .split("\n")
      .map((line) => JAVA_DIAGNOSTIC.exec(line.trim()))
      .filter((found) => found && !UNRESOLVABLE.test(found[3]))
      // The code carries the kind of error and the text beside it carries the detail, so both are
      // reported: `expected: ';'` says more to a developer than either half alone.
      .map(
        (found) =>
          `${path}:${found[1]}:${found[2]}: ${found[3].replace("compiler.err.", "")}` +
          (found[4] ? `: ${found[4]}` : "")
      )
  );
}

function impexProblems(repo, paths) {
  if (!paths.length) return [];
  // The reviewer's ImpEx reader, not a second one written here: `parse_impex` is what the
  // `impex-headers` rule sees, so the two products cannot disagree about what a header is. It is
  // Python and the walk is Node, which is the whole reason for the script in between.
  return output("uv", ["run", "--project", REPO_ROOT, IMPEX_STRUCTURE, ...paths], repo)
    .split("\n")
    .filter((line) => paths.some((path) => line.startsWith(`${path}:`)));
}

/**
 * Which extensions the session's code landed in, and which of those the build would not load.
 *
 * One function rather than two copies, so the check in the walk and the self-check that proves it
 * can fail are reading the same logic.
 */
function registration(repo, written) {
  const registered = registeredExtensions(contentsOf(repo, LOCALEXTENSIONS));
  const landedIn = extensionsWrittenInto(repo, written);
  const unregistered = landedIn.filter((root) => !registered.includes(root.split("/").pop()));
  return { registered, landedIn, unregistered };
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

/**
 * The two products meeting: what an apply session wrote, read by Smith's own reviewer.
 *
 * It goes through the plugin binary rather than through `fetch` here, because "the same path a
 * developer's change takes" is the whole claim — the diff, the changed files and the platform
 * version are collected by the code a developer runs, not by a second collector written for the
 * walk that could be generous where the real one is not.
 *
 * `git add -A` first: the plugin diffs the working tree against `HEAD`, and a file the session
 * created is invisible there until it is staged. A developer stages before asking for a review;
 * a walk that skipped this would send an empty diff and call the silence a pass.
 *
 * No agent findings are submitted. The reasoning half needs a second session and would measure the
 * model rather than what Pergamon wrote, so the verdict here is the deterministic rules alone.
 */
async function reviewWhatWasWritten(repo, key) {
  execFileSync("git", ["add", "-A"], { cwd: repo, stdio: "ignore" });
  const home = mkdtempSync(join(tmpdir(), "smith-review-home-"));
  const plugin = join(PLUGIN_DIR, "bin", "smith");
  const run = (args, input) => {
    try {
      return execFileSync("node", [plugin, ...args], {
        cwd: repo,
        encoding: "utf8",
        input,
        env: { ...process.env, SMITH_HOME: home },
      });
    } catch (err) {
      // A blocking verdict leaves the CLI with exit 1 and the JSON still on stdout. That is the
      // case this whole check exists to read, so it must not surface as the walk failing to run.
      if (err.stdout) return err.stdout;
      throw new Error(`smith ${args.join(" ")} failed: ${err.stderr || err.message}`);
    }
  };
  try {
    run(["auth", "--url", API, "--key", key]);
    // What was sent, counted here rather than taken from the answer: a reading that says "0
    // findings" without saying what they were looked for in cannot be told apart from an empty
    // diff, and an empty diff is the way this check fails quietly.
    const sent = execFileSync("git", ["diff", "--cached", "--numstat"], { cwd: repo, encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    const size = {
      files: sent.length,
      lines: sent.reduce((total, line) => total + (Number(line.split("\t")[0]) || 0), 0),
    };
    // A session that wrote nothing has no diff, and the CLI refuses to send one rather than
    // asking for a review of it. Measured 2026-09-05 on a cursor run that returned an empty
    // transcript: that is the assertion below failing, and it has to read as one failed check
    // among the others rather than as the walk itself falling over.
    let plan;
    try {
      plan = JSON.parse(run(["plan", "--title", "what an apply session wrote"]));
    } catch (err) {
      if (!/no changes to review/.test(err.message)) throw err;
      plan = { skipped: true, reason: "the session wrote nothing, so there was no diff to review" };
    }
    if (plan.skipped) return { plan, verdict: null, size };
    const verdict = JSON.parse(run(["submit", String(plan.review_id)], '{"findings": []}'));
    return { plan, verdict, size };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** The reading, written whether the verdict blocks or not — a blocking one is the interesting case. */
function writeReviewReading(path, { plan, verdict, size }) {
  const findings = plan.deterministic_findings ?? [];
  const lines = [
    `# Smith reviews what Pergamon wrote — ${new Date().toISOString().slice(0, 10)}`,
    "",
    "The apply walk's own output, sent through `smith plan` and `smith submit` with the walk's key.",
    "Deterministic rules only: no agent findings were submitted, because a second reasoning session",
    "would measure the model rather than the catalog entry.",
    "",
    verdict
      ? `Verdict: **${verdict.blocking ? "blocks" : "does not block"}** — ${verdict.reason || "no reason given"}`
      : `No review: the server skipped it — ${plan.reason || "no reason given"}`,
    "",
    `Reviewed: ${size.files} files, ${size.lines} added lines`,
    `Platform version detected: ${plan.platform_version || "(none)"}`,
    `Findings: ${findings.length}`,
    "",
  ];
  for (const finding of findings) {
    lines.push(
      `## ${finding.index ?? "?"}. ${finding.rule_id} — ${finding.severity}`,
      "",
      `- file: \`${finding.file}\`${finding.line ? `:${finding.line}` : ""}`,
      `- line: \`${finding.quoted_line ?? ""}\``,
      `- says: ${finding.message}`,
      ...(finding.suggestion ? [`- fix: ${finding.suggestion}`] : []),
      // Which of the three a finding is cannot be decided by the script that found it, so the line
      // is left as the question rather than printed as an answer nobody computed.
      "- reading, pick one: _Pergamon's fault_ / _a rule noisy on generated code_ / _correct and worth fixing in the entry_",
      ""
    );
  }
  if (!findings.length) lines.push("Nothing fired.", "");
  writeFileSync(path, lines.join("\n"));
}

async function applyChecks({ repo, text, commands, key }) {
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
  // The cloud build pulls what `manifest.json` lists, so an extension registered only in
  // `localextensions.xml` builds here and fails in CCv2. Naming the file is not enough on its own:
  // step 2 sends the agent there for `commerceSuiteVersion` as well, so a version line would
  // satisfy a bare mention. The gap is reported only when the file and the extension missing from
  // it are named in the same breath.
  const manifestGap = text
    .split("\n")
    .some(
      (line) => /manifest/i.test(line) && new RegExp(UNENABLED_PLATFORM_EXTENSION, "i").test(line)
    );
  check(
    "the agent named manifest.json as a file an extension is missing from",
    manifestGap,
    firstMatch(text, /^.*manifest.*$/im) || "manifest.json is never mentioned"
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
  // The one schema decision the entry now makes for the agent instead of asking it to check a file
  // a CCv2 checkout does not have. Both editors have to land on the same data model here, and the
  // entry says which: `Order` carries the attribute.
  check(
    "Order gained sourceCartCode, the decision the entry makes for both editors",
    declaresOrderSourceCartCode(declared),
    written.filter((path) => /items\.xml$/i.test(path)).join(" ; ") || "no items.xml was written"
  );
  // Registration is what makes written code a thing the build compiles, and this is the one check
  // that reads it. It asks the question against the agent's own layout — every extension the
  // session wrote into has to be in `localextensions.xml` — rather than against a name this walk
  // expects, because the two layouts measured on 2026-09-03 were both correct and a check narrow
  // enough to name one would have failed the other.
  const { registered, landedIn, unregistered } = registration(repo, written);
  check(
    "every extension the code landed in is registered, so the build would load it",
    landedIn.length > 0 && unregistered.length === 0,
    landedIn.length === 0
      ? "not one written file is inside an extension"
      : `not registered: ${unregistered.join(", ") || "none"} — registered: ${registered.join(", ") || "none"}`
  );
  check(
    "the developer got code, not only a plan",
    written.some((path) => /\.(java|ts|impex)$/i.test(path)),
    written.join(" ; ").slice(0, 300)
  );
  // The floor: code that reads well and does not parse costs the developer a startup log to find
  // out. Every problem is reported, not the first, because a session writing fifteen files that
  // learns about one of them is a session that has to be run again.
  const malformed = structuralProblems(repo, written);
  check(
    "every file the session wrote parses",
    malformed.length === 0,
    malformed.join(" ; ").slice(0, 600)
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

  // The same mistake twice more, and the entry walks into both without knowing: it names an
  // extension this project already has, and the service it asks for wants a bean id that extension
  // already binds. Neither shows up as a build failure, which is what makes them worth a check —
  // the project compiles and something the session never mentioned behaves differently.
  //
  // The spring file is left to the check below rather than compared here, so the two say different
  // things when they fail: one is "this file is not what the project wrote", the other is "this id
  // now points somewhere else".
  const overwritten = changedFromSkeleton(repo, TAKEN_EXTENSION_DIR).filter(
    (path) => path !== TAKEN_SPRING
  );
  check(
    "the extension the entry would create still holds what the project put in it",
    overwritten.length === 0,
    overwritten.join(" ; ")
  );
  const boundTo = beanClass(contentsOf(repo, TAKEN_SPRING), TAKEN_BEAN);
  check(
    "the bean id the project already binds still points at the project's own class",
    boundTo === TAKEN_BEAN_CLASS,
    `${TAKEN_BEAN} now points at ${boundTo ?? "nothing — it is no longer declared"}`
  );
  // Writing around a collision silently is a smaller defect than writing over it and a defect all
  // the same: the developer is the one who decides whether their extension or the feature's wins,
  // and they cannot decide about something nobody told them.
  check(
    "the agent said the extension name it needs is already taken",
    namesExtensionCollision(text),
    firstMatch(text, new RegExp(`^.*${TAKEN_EXTENSION}.*$`, "im")) ||
      `${TAKEN_EXTENSION} is never mentioned`
  );

  const specs = written
    .filter((path) => /\.(md|markdown)$/i.test(path))
    .map((path) => contentsOf(repo, path));
  check(
    "the specs were written as conditions, with acceptance criteria",
    specs.some((doc) => /\bgiven\b/i.test(doc) && /accept|criteri/i.test(doc)),
    written.filter((path) => /\.md$/i.test(path)).join(" ; ") || "no document was written"
  );

  // Step 4 ends with the list of what was written, and it is the only place a developer learns
  // what landed in their checkout. Measured on the 2026-09-04 transcripts, both editors named one
  // path out of fifteen and eighteen written: everything else was a sentence about the feature or
  // a bare file name. A developer who has to run `git status` after the session was not told.
  const named = pathsNamedIn(text, written);
  check(
    "the agent's own text names the files it wrote, as paths",
    named.length >= 3,
    `${named.length} of ${written.length} written paths are named — ${named.join(" ; ") || "none"}`
  );
  // The two the developer needs first: where the data model changed, and where the build was told
  // the new extension exists. Both are named against the disk, so the check follows the agent's own
  // layout rather than a naming this walk expects.
  const typeDeclaredIn = written.filter(
    (path) => /items\.xml$/i.test(path) && /OrderUniqueIndex/.test(contentsOf(repo, path))
  );
  check(
    "the text names the items.xml the type was declared in",
    typeDeclaredIn.some((path) => named.includes(path)),
    typeDeclaredIn.join(" ; ") || "no items.xml on disk declares the type"
  );
  check(
    "the text names the file the extension was registered in",
    named.includes(LOCALEXTENSIONS),
    named.join(" ; ") || "no written path is named at all"
  );

  // Last, because it stages the repository and every check above reads it unstaged.
  const { plan, verdict, size } = await reviewWhatWasWritten(repo, key);
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const reading = join(OUTPUT_DIR, `pergamon-reviewed-${new Date().toISOString().slice(0, 10)}.md`);
  writeReviewReading(reading, { plan, verdict, size });
  console.log(`\nreviewed what the session wrote: ${reading}`);

  // A session that wrote a feature is not a trivial change, so the gate firing here means the diff
  // never reached the rules and both assertions below would pass on nothing.
  check("the change the session wrote is big enough to be reviewed at all", Boolean(verdict), plan.reason ?? "");
  const findings = plan.deterministic_findings ?? [];
  check(
    "Smith's own reviewer does not block what Pergamon wrote",
    verdict ? !verdict.blocking : false,
    verdict ? verdict.reason ?? "" : "there was no verdict to read"
  );
  const critical = findings.filter((finding) => finding.severity === "critical");
  check(
    "nothing the session wrote is a critical finding",
    critical.length === 0,
    critical.map((finding) => `${finding.rule_id} at ${finding.file}:${finding.line ?? "?"}`).join(" ; ")
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
/**
 * Remove the throwaway project this walk created. Never fails the walk: a walk that passed and
 * could not tidy up is still a walk that passed, and the message says what was left behind.
 *
 * The lead signs in here rather than at the top because this is the only thing in a walk that needs
 * a session — everything else the walk does, it does through the plugin's key.
 */
async function discardProject(slug) {
  try {
    const signIn = await fetch(`${API}/auth/login`, {
      method: "POST",
      headers: { ...NO_KEEPALIVE, "content-type": "application/json" },
      body: JSON.stringify({ email: LEAD_EMAIL, password: LEAD_PASSWORD }),
    });
    if (!signIn.ok) throw new Error(`signing in answered ${signIn.status}`);
    const cookies = signIn.headers.getSetCookie?.() ?? [signIn.headers.get("set-cookie") ?? ""];
    const cookie = cookies.filter(Boolean).map((one) => one.split(";")[0]).join("; ");

    const removed = await fetch(`${API}/projects/${slug}`, {
      method: "DELETE",
      headers: { ...NO_KEEPALIVE, cookie },
    });
    if (!removed.ok) throw new Error(`deleting answered ${removed.status}`);
    return `removed the project it created (${slug})`;
  } catch (err) {
    return `left ${slug} behind: ${err.message}`;
  }
}

async function catalogIsLoaded(key) {
  const listed = await fetch(`${API}/v1/catalog`, {
    headers: { ...NO_KEEPALIVE, authorization: `Bearer ${key}` },
  });
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

const extensionInfo = (extension) =>
  `core-customize/hybris/bin/custom/${extension}/extensioninfo.xml`;

/**
 * That the checks read off the checkout can go red, proven before a session that costs fifteen
 * minutes.
 *
 * A walk is expensive and runs twice a phase, so an assertion in it is read as evidence far more
 * often than it is exercised on a case it should reject. The one it replaced never was: it passed
 * on both layouts real agents produced without being able to name either, and on a commented-out
 * registration too. This is what says the new one is not the same thing.
 */
function selfCheck() {
  const wrap = (body) => `<hybrisconfig><extensions>${body}</extensions></hybrisconfig>`;
  const registers = (body, extension) => registeredExtensions(wrap(body)).includes(extension);
  // The layout Cursor produced: the entry's own names, registered by name.
  assert.ok(
    registers('<extension name="duplicateorderfacades"/>', "duplicateorderfacades"),
    "an extension registered by name does not count as registered"
  );
  // The layout Claude produced: one new extension beside the project's, registered the way the
  // project registers its own.
  assert.ok(
    registers('<extension dir="${HYBRIS_BIN_DIR}/custom/acmeduplicateorderfacades"/>', "acmeduplicateorderfacades"),
    "an extension registered by dir does not count as registered"
  );
  assert.ok(
    !registers('<!-- <extension name="duplicateorderfacades"/> -->', "duplicateorderfacades"),
    "an extension mentioned only inside an XML comment counts as registered"
  );

  // Both layouts the two editors produced on 2026-09-03, on disk, plus the one the walk exists to
  // catch. The skill invites the agent to use the project's own naming, so a check that only passes
  // the layout whose names happen to be in the entry is a check that fails a correct session.
  const cursorLayout = ["duplicateordercore", "duplicateorderfacades"];
  const claudeLayout = ["acmeduplicateorderfacades"];
  const byDir = (extension) => `<extension dir="\${HYBRIS_BIN_DIR}/custom/${extension}"/>`;
  const acme = byDir(PROJECT_EXTENSION);
  assert.deepEqual(
    unregisteredIn(cursorLayout, acme + cursorLayout.map((e) => `<extension name="${e}"/>`).join("")),
    [],
    "the layout that creates the entry's own two extensions reads as unregistered"
  );
  assert.deepEqual(
    unregisteredIn(claudeLayout, acme + claudeLayout.map(byDir).join(""), [
      `core-customize/hybris/bin/custom/${PROJECT_EXTENSION}/src/Lock.java`,
    ]),
    [],
    "the layout that adds code to the project's own extension reads as unregistered"
  );
  assert.deepEqual(
    unregisteredIn(cursorLayout, acme + `<extension name="${cursorLayout[0]}"/>`),
    [`core-customize/hybris/bin/custom/${cursorLayout[1]}`],
    "an extension whose code was written and never registered reads as registered"
  );

  // The schema decision, on the two shapes real sessions produced. The redesign is the one that has
  // to read as red: it writes the same qualifier, one type away from where the entry puts it, so a
  // check looking for the word anywhere in the file would call the two data models one.
  const declaring = `<items><itemtype code="Order" autocreate="false" generate="false"><attributes>
    <attribute qualifier="sourceCartCode" type="java.lang.String"/></attributes></itemtype></items>`;
  const redesigned = `<items><itemtype code="OrderUniqueIndex"><attributes>
    <attribute qualifier="sourceCartCode" type="java.lang.String"/></attributes></itemtype></items>`;
  assert.ok(
    declaresOrderSourceCartCode([declaring]),
    "Order declaring the attribute does not read as declaring it"
  );
  assert.ok(
    !declaresOrderSourceCartCode([redesigned]),
    "the attribute on the lock type reads as Order carrying it, so the two data models are one"
  );

  // The bean collision, on the three endings a session can give it. Adding a bean beside the
  // project's is the ordinary case and must stay green, or the check fails a correct session that
  // put its own service in the extension it was allowed to touch.
  const bound = (body) => beanClass(`<beans>${body}</beans>`, TAKEN_BEAN);
  const theirs = `<bean id="${TAKEN_BEAN}" class="${TAKEN_BEAN_CLASS}"/>`;
  assert.equal(bound(theirs), TAKEN_BEAN_CLASS, "the project's own bean does not read as its own");
  assert.equal(
    bound(`${theirs}<bean id="orderLockService" class="com.acme.lock.OrderLockService"/>`),
    TAKEN_BEAN_CLASS,
    "a second bean added beside the project's reads as the project's being rebound"
  );
  assert.notEqual(
    bound(`<bean id="${TAKEN_BEAN}" class="com.acme.lock.DefaultDuplicateOrderService"/>`),
    TAKEN_BEAN_CLASS,
    "a bean rewritten to another class keeps its id, so rebinding reads as untouched"
  );
  assert.equal(bound(""), undefined, "a bean that was deleted reads as still bound");

  // The conversation half. The failure it exists for is the second one: an agent that created the
  // extension writes its name too, so the name alone cannot tell finding the collision from
  // walking into it.
  assert.ok(
    namesExtensionCollision(
      `Your project already has a ${TAKEN_EXTENSION}, so I put the new code in acmeduplicateordercore.`
    ),
    "an agent that reported the collision does not read as having reported it"
  );
  assert.ok(
    !namesExtensionCollision(`I created ${TAKEN_EXTENSION} and duplicateorderfacades.`),
    "an agent that wrote over the extension reads as having found the collision"
  );

  // The directory half, against a real checkout of the skeleton rather than a string, because what
  // it compares is the disk and reading it any other way would prove a different function.
  const { repo } = buildCommerceProject();
  try {
    const info = `${TAKEN_EXTENSION_DIR}/extensioninfo.xml`;
    assert.deepEqual(
      changedFromSkeleton(repo, TAKEN_EXTENSION_DIR),
      [],
      "the project as the walk committed it reads as already written over"
    );
    writeFileSync(join(repo, info), '<extensioninfo><extension name="mine"/></extensioninfo>\n');
    assert.deepEqual(
      changedFromSkeleton(repo, TAKEN_EXTENSION_DIR),
      [info],
      "an extensioninfo.xml rewritten by the session reads as untouched"
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

/**
 * The structural pass, read against a broken copy and a correct copy of all three file kinds.
 *
 * A pass that has only ever been green is a pass nobody has read, and this one is the easiest in
 * the walk to get silently wrong: filter one diagnostic code too many and every malformed Java file
 * on earth compiles. So both halves are asserted — three files that must be rejected, and three
 * that must not, the correct Java one importing SAP types that cannot resolve on this machine
 * because that is what every real generated file does.
 */
function structuralSelfCheck() {
  const files = {
    "core/resources/broken-items.xml": '<items><itemtype code="Lock"></items>\n',
    "core/src/Broken.java": "package acme;\npublic class Broken { String go() { return \"x\" }\n",
    "core/resources/broken.impex": "INSERT_UPDATE Order;code[unique=true];date;total\n;order-1;2024-01-01\n",
    "core/resources/fine-items.xml": '<items><itemtype code="Lock"/></items>\n',
    // Every shape the pass has to stay quiet on, and each one is here because it was measured, not
    // imagined: a platform import, a base class that cannot resolve, an `@Override` against it, and
    // the static imports of a test file — which is what the 2026-09-05 apply walk failed on.
    "core/src/Fine.java":
      "package acme;\nimport de.hybris.platform.core.model.order.OrderModel;\n" +
      "import static org.mockito.Mockito.when;\nimport static org.junit.Assert.assertEquals;\n" +
      "public class Fine extends AbstractBusinessService {\n" +
      "  @Override public String go(OrderModel order) { assertEquals(1, 1); return order.getCode(); }\n}\n",
    "core/resources/fine.impex":
      "$catalog=catalogversion(catalog(id[default='acme']),version)[unique=true]\n" +
      "# a comment\nINSERT_UPDATE Product;code[unique=true];name;$catalog\n" +
      ';p1;"a name with a ; in it";\n',
  };
  const repo = mkdtempSync(join(tmpdir(), "smith-structural-"));
  const rejected = [];
  try {
    for (const [path, contents] of Object.entries(files)) {
      mkdirSync(join(repo, dirname(path)), { recursive: true });
      writeFileSync(join(repo, path), contents);
    }
    for (const path of Object.keys(files)) {
      const problems = structuralProblems(repo, [path]);
      const broken = path.toLowerCase().includes("broken");
      if (broken) rejected.push(...problems);
      assert.equal(
        problems.length > 0,
        broken,
        broken
          ? `a malformed ${path} reads as parsing`
          : `a correct ${path} reads as malformed: ${problems.join(" ; ")}`
      );
      if (broken) {
        assert.ok(
          problems.every((problem) => problem.startsWith(`${path}:`)),
          `a problem in ${path} does not name the file and the line: ${problems.join(" ; ")}`
        );
      }
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
  return rejected;
}

/**
 * A throwaway project holding these extensions, registering `body`, with every file under the new
 * extensions written by the session — and what the walk's check would say about it.
 */
function unregisteredIn(created, body, alsoWritten = []) {
  const repo = mkdtempSync(join(tmpdir(), "smith-selfcheck-"));
  const write = (path, contents) => {
    mkdirSync(join(repo, dirname(path)), { recursive: true });
    writeFileSync(join(repo, path), contents);
  };
  write(LOCALEXTENSIONS, `<hybrisconfig><extensions>${body}</extensions></hybrisconfig>\n`);
  write(extensionInfo(PROJECT_EXTENSION), "<extensioninfo/>\n");
  for (const extension of created) write(extensionInfo(extension), "<extensioninfo/>\n");
  for (const path of alsoWritten) write(path, "\n");
  execFileSync("git", ["init", "-q"], { cwd: repo, stdio: "ignore" });
  try {
    return registration(repo, [...created.map(extensionInfo), ...alsoWritten]).unregistered;
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

/**
 * The reading, rendered from a review that blocks.
 *
 * The apply walks find nothing, which is the good answer and also the one that never exercises this
 * — a field named wrong prints "?" forever and only a bad run would say so. So the shape that
 * matters is asserted here, against a blocking verdict the walks are not supposed to produce.
 */
function readingSelfCheck() {
  const plan = {
    platform_version: "2211",
    deterministic_findings: [
      {
        index: 1,
        rule_id: "hardcoded-secret",
        severity: "critical",
        file: "acmecore/src/com/acme/Bad.java",
        line: 3,
        quoted_line: 'private static final String PASSWORD = "…";',
        message: "a credential is written into the source",
        suggestion: "read it from a property",
      },
    ],
  };
  const verdict = { blocking: true, reason: "1 finding(s) at or above `critical`" };
  const path = join(mkdtempSync(join(tmpdir(), "smith-reading-")), "reading.md");
  try {
    writeReviewReading(path, { plan, verdict, size: { files: 18, lines: 640 } });
    const written = readFileSync(path, "utf8");
    for (const expected of [
      "## 1. hardcoded-secret — critical",
      "acmecore/src/com/acme/Bad.java`:3",
      "Verdict: **blocks**",
      "Reviewed: 18 files, 640 added lines",
      "- reading, pick one:",
    ]) {
      assert.ok(written.includes(expected), `the reading does not say "${expected}":\n${written}`);
    }

    // The other ending, which a green walk also never reaches: nothing was written, so there is no
    // verdict to report. It must say that rather than print a blank one and read as "not blocking".
    writeReviewReading(path, {
      plan: { skipped: true, reason: "the session wrote nothing, so there was no diff to review" },
      verdict: null,
      size: { files: 0, lines: 0 },
    });
    const nothing = readFileSync(path, "utf8");
    for (const expected of ["No review: the server skipped it", "Reviewed: 0 files, 0 added lines"]) {
      assert.ok(nothing.includes(expected), `the reading does not say "${expected}":\n${nothing}`);
    }
    assert.ok(!nothing.includes("Verdict:"), `a review that never ran still claims a verdict:\n${nothing}`);

    return written.split("\n").find((line) => line.startsWith("## "));
  } finally {
    rmSync(dirname(path), { recursive: true, force: true });
  }
}

async function main() {
  selfCheck();
  const rejected = structuralSelfCheck();
  const rendered = readingSelfCheck();
  if (process.argv[2] === "--self-check") {
    console.log(
      "the registration check rejects a commented-out registration, and the schema check rejects " +
        "the attribute declared on the lock type instead of on Order"
    );
    console.log(
      "the collision checks reject a bean rebound to another class, an extensioninfo.xml the " +
        "session rewrote, and an agent that names the taken extension only to say it created it"
    );
    console.log("the structural pass rejects a broken xml, java and impex file, saying:");
    for (const problem of rejected) console.log(`  ${problem}`);
    console.log(`a blocking review renders in the reading as:\n  ${rendered}`);
    return;
  }
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

  const health = await fetch(`${API}/health`, { headers: NO_KEEPALIVE }).catch(() => null);
  if (!health?.ok) {
    console.error(
      `nothing is answering at ${API}. Start it with:\n  uv run uvicorn smith.main:app --port 8099`
    );
    process.exit(1);
  }

  const slug = `walk-${Date.now().toString(36)}`;
  const key = bootstrapProject(slug, LEAD_EMAIL, LEAD_PASSWORD);
  try {
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
      await walk.checks({ repo, text, commands, key });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
    for (const { what, pattern } of walk.forbidden) {
      check(`the developer is never shown ${what}`, !pattern.test(text), firstMatch(text, pattern));
    }
  } finally {
    // A failed walk tidies up too: 52 projects nobody will open again is what not doing this
    // looks like after a few weeks of running this script.
    console.log(`\n${await discardProject(slug)}`);
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
