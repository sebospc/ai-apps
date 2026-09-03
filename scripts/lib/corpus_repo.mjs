/**
 * A throwaway git repository built from real client code, and the project that reviews it.
 *
 * Shared by the two scripts that rehearse a review end to end: `rehearse.mjs` drives the CLI
 * itself, `walk_skill.mjs` drives an agent reading the skill. Both need the same starting point —
 * somebody else's Java, with problems introduced on purpose — and a lifecycle that only works on
 * files we wrote has proved nothing about the product.
 *
 * Env: SMITH_CORPUS points at a real SAP Commerce checkout.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

export const CORPUS =
  process.env.SMITH_CORPUS ??
  join(
    homedir(),
    "corpus/sap-commerce-project"
  );

const REPO_ROOT = new URL("../..", import.meta.url).pathname;

// Enough real files that the baseline is somebody else's code rather than ours. The change under
// review touches exactly one of them; the rest are there so the repository is not a toy.
const BASELINE_FILES = 6;

// The three problems a rehearsal argues about: one blocking, two not. They go into a real file, in
// a method that keeps the file valid Java, so nothing about the injection is special.
export const SYSTEM_OUT = '        System.out.println("rehearsal marker");';
export const JALO_SESSION =
  "        final SessionContext ctx = JaloSession.getCurrentSession().createSessionContext();";
export const PRINT_STACK_TRACE =
  '        new IllegalStateException("rehearsal marker").printStackTrace();';
/**
 * The fix Smith's own checks carry for each injected problem, as the token a faithful rendering
 * keeps. An agent rewrites `Use modelService, userService, or other ServiceLayer APIs.` into a
 * sentence of its own; it does not rewrite `modelService` into another word. Matching the whole
 * suggestion would only assert that the agent copied it, which is not what the skill asks for.
 *
 * Each `fix` must be a token the check's `suggestion` has and its `message` does not, or the
 * assertion is green on a review that showed the message alone. Measured 2026-08-22: `\bLOG\b`
 * matched the message of the day, "System.out/err detected. Use LOG instead.", and proved nothing.
 * That message has since dropped its fix clause; the trap it showed has not gone anywhere.
 */
export const INJECTED_FIXES = [
  { what: "System.out", finding: /System\.(out|err)|println/, fix: /LOG\.(info|warn|error)/ },
  { what: "JaloSession", finding: /jalo\s?session|sessioncontext/i, fix: /modelService|ServiceLayer/i },
  { what: "printStackTrace", finding: /printStackTrace/, fix: /LOG\.error/i },
];

const MARKER_METHOD = [
  "",
  "    /** Rehearsal marker. Three problems on purpose, so the rehearsal has something to argue. */",
  "    public void rehearsalMarker() {",
  SYSTEM_OUT,
  JALO_SESSION,
  PRINT_STACK_TRACE,
  "    }",
];

/** Real, hand-written Java from the corpus, in a fixed order so two runs review the same code. */
function corpusJavaFiles() {
  let entries;
  try {
    entries = readdirSync(CORPUS, { recursive: true, withFileTypes: true });
  } catch {
    throw new Error(`no corpus at ${CORPUS} — point SMITH_CORPUS at a real SAP Commerce checkout`);
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".java"))
    .map((entry) => join(entry.parentPath ?? entry.path, entry.name))
    .filter((path) => !/\/(gensrc|target|build|node_modules)\/|[Tt]est/.test(path))
    .sort();
}

/**
 * A throwaway git repository holding real files, with the first commit already in place.
 *
 * The file the change lands in has to survive having a method appended, so it is the first one that
 * declares a package and closes on a brace of its own.
 */
export function buildRepo(prefix = "smith-rehearse-repo-") {
  const files = corpusJavaFiles();
  const target = files.find((path) => {
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    return lines.some((line) => /^\s*package\s/.test(line)) && lines.at(-1).trim() === "}";
  });
  if (!target || files.length < BASELINE_FILES) {
    throw new Error(`${CORPUS} holds no reviewable Java a change can be built from`);
  }

  const chosen = [target, ...files.filter((path) => path !== target)].slice(0, BASELINE_FILES);
  const repo = mkdtempSync(join(tmpdir(), prefix));
  for (const source of chosen) {
    const path = relative(CORPUS, source);
    mkdirSync(join(repo, dirname(path)), { recursive: true });
    writeFileSync(join(repo, path), readFileSync(source));
  }

  const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "dev@acme.com");
  git("config", "user.name", "Rehearsal");
  git("add", ".");
  git("commit", "-q", "-m", "baseline from real client code");
  return { repo, target: relative(CORPUS, target) };
}

export function edit(repo, target, change) {
  const file = join(repo, target);
  writeFileSync(file, change(readFileSync(file, "utf8")));
}

export function introduceProblems(repo, target) {
  edit(repo, target, (text) => {
    const lines = text.trimEnd().split("\n");
    lines.splice(lines.length - 1, 0, ...MARKER_METHOD);
    return `${lines.join("\n")}\n`;
  });
}

/** A project and a key of its own, so a run owns every disposition it is about to read back. */
export function bootstrapProject(slug, email, password) {
  const out = execFileSync(
    "uv",
    [
      "run",
      "python",
      "scripts/bootstrap.py",
      "--email",
      email,
      "--password",
      password,
      "--project",
      slug,
    ],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
  const key = out.match(/smk_[a-z0-9]+_[A-Za-z0-9_-]+/)?.[0];
  if (!key) throw new Error(`bootstrap printed no API key:\n${out}`);
  return key;
}
