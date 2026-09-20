/**
 * How good the review is, scored on defects somebody planted.
 *
 * Everything else in this repository measures the deterministic half — precision against a corpus,
 * a fixture per check, a probe per guideline. All of it stops where the agent starts reasoning, and
 * the agent half is what a developer reads. The one time it was measured it scored 1 of 4, by hand,
 * once, because a person noticed.
 *
 *   scripts/ensure_db.sh
 *   uv run uvicorn smith.main:app --port 8094 &
 *   SMITH_API_URL=http://localhost:8094 node scripts/review_score.mjs            # every case, twice
 *   SMITH_API_URL=http://localhost:8094 node scripts/review_score.mjs --case duplicate-rule --runs 3
 *   SMITH_API_URL=http://localhost:8094 node scripts/review_score.mjs --control  # a command that should miss
 *   SMITH_CONTROL_SHA=<sha> ... --case stock-badge --control   # a held-out case, against an older command
 *   node scripts/review_score.mjs --self-check                                   # the scoring, without a session
 *   ... --record                                                                 # write scripts/review_score.json
 *
 * **Recall** is how many planted defects were reported. **Noise** is how many findings came back
 * that were not planted. One number without the other hides half the answer: a review that reports
 * everything reports the three real defects too.
 *
 * Read as a range. Two runs of the same case differ — that is what a model is — so a case runs more
 * than once and what is written down is the spread, never the best run.
 *
 * What this is not:
 *
 * - **Not a benchmark to tune against.** Tune `plugin/commands/smith-review.md` until the set
 *   passes and the set measures the tuning. It answers "is this worse than last month", never "is
 *   this good".
 * - **Not proof.** Defects planted by a model and reviewed by a model share a blind spot that no
 *   number of cases fixes. Worth having, worth distrusting.
 *
 * Env: SMITH_API_URL (default http://localhost:8094).
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildPlainRepo } from "./lib/plain_repo.mjs";
import { CASES, HELD_OUT } from "./lib/review_cases.mjs";
import { PLUGIN_DIR, pluginWithCommandAt, runSession, searchesOf, seedCredentials } from "./lib/review_session.mjs";
import { throwawaySlug, tidyAfterEarlierRuns } from "./lib/throwaway_project.mjs";

const API = process.env.SMITH_API_URL ?? "http://localhost:8094";
const EVERY_CASE = { ...CASES, ...HELD_OUT };
const ROOT = new URL("..", import.meta.url).pathname;
const OUTPUT_DIR = join(ROOT, "output");
const SCORE_FILE = join(ROOT, "scripts", "review_score.json");

const LEAD_EMAIL = "score@smith.test";
const LEAD_PASSWORD = "score-password";

// The last commit before AK1 taught step 4 to look outside the diff. A case that scores the same
// against this command as against the current one is a case that measures nothing, so every case
// gets run against it once before its number is believed.
//
// `SMITH_CONTROL_SHA` points the control at a different revision, which is how a change to the
// command is read against the revision before it rather than against AK1's.
const BEFORE_THE_FIX = process.env.SMITH_CONTROL_SHA || "ebc6330ed4ef407d90b27fecd95db83151694b21";

const PROMPT = "/smith-review my uncommitted changes";
const TOOLS = "Bash,Read,Glob,Grep";

// The walk leaves a connection idle for minutes while the session works, and a pooled socket the
// server has since closed surfaces as ECONNRESET on the next read.
const NO_KEEPALIVE = { connection: "close" };

// --------------------------------------------------------------------------------------------
// the server's side of it
// --------------------------------------------------------------------------------------------

function bootstrapProject(slug) {
  const out = execFileSync(
    "uv",
    ["run", "python", "scripts/bootstrap.py", "--email", LEAD_EMAIL, "--password", LEAD_PASSWORD, "--project", slug],
    { cwd: ROOT, encoding: "utf8" }
  );
  const key = out.match(/smk_[a-z0-9]+_[A-Za-z0-9_-]+/)?.[0];
  if (!key) throw new Error(`bootstrap printed no API key:\n${out}`);
  return key;
}

async function leadCookie() {
  const signIn = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { ...NO_KEEPALIVE, "content-type": "application/json" },
    body: JSON.stringify({ email: LEAD_EMAIL, password: LEAD_PASSWORD }),
  });
  if (!signIn.ok) throw new Error(`signing in answered ${signIn.status}`);
  const cookies = signIn.headers.getSetCookie?.() ?? [signIn.headers.get("set-cookie") ?? ""];
  return cookies.filter(Boolean).map((one) => one.split(";")[0]).join("; ");
}

/**
 * What the session actually sent, read through the lead's own view of the project.
 *
 * Never the prose. What a session says it found and what reached the server are two different
 * things, and only one of them is what the product recorded — AK1 paid for that lesson with a
 * session that described a defect it never submitted.
 */
async function reviewsInProject(slug) {
  const cookie = await leadCookie();
  const listed = await fetch(`${API}/projects/${slug}/reviews`, { headers: { ...NO_KEEPALIVE, cookie } });
  if (!listed.ok) throw new Error(`listing the project's reviews answered ${listed.status}`);
  const reviews = [];
  for (const summary of (await listed.json()).reviews) {
    const detail = await fetch(`${API}/projects/${slug}/reviews/${summary.id}`, {
      headers: { ...NO_KEEPALIVE, cookie },
    });
    if (!detail.ok) throw new Error(`review ${summary.id} answered ${detail.status}`);
    reviews.push(await detail.json());
  }
  return reviews;
}

async function discardProject(slug) {
  try {
    const cookie = await leadCookie();
    const removed = await fetch(`${API}/projects/${slug}`, { method: "DELETE", headers: { ...NO_KEEPALIVE, cookie } });
    if (!removed.ok) throw new Error(`deleting answered ${removed.status}`);
  } catch {
    console.log(`  (left ${slug} behind)`);
  }
}

// --------------------------------------------------------------------------------------------
// scoring
// --------------------------------------------------------------------------------------------

const said = (finding) => `${finding.message} ${finding.suggestion ?? ""}`;

/**
 * Why this run is not a reading, or "" when it is one.
 *
 * A session killed part-way — a quota limit is how it happens here — still carries messages, so
 * `session.ran` is true and every planted defect scores as missed. That reads as a review that
 * looked and found nothing, which is the one thing it is not. The project holding no review at all
 * is what separates them: `smith plan` is the first thing the command runs and the server creates
 * the review there, so a run with none never started reviewing. A review with an empty finding list
 * is the opposite — it is an answer, and on a case with defects planted it is a real miss.
 */
export function refuseToScore(reviews) {
  return reviews.length === 0
    ? "the session opened no review, so it never reached `smith plan` — not a reading, and not a zero"
    : "";
}

/**
 * One run's score.
 *
 * Only findings the *session* produced are scored. The deterministic checks are measured everywhere
 * else in this repository and counting them here would credit the agent half with the other half's
 * work — and, worse, would let a ruleset change move a number that is supposed to be about a
 * command file.
 */
export function scoreRun(theCase, reviews) {
  const findings = reviews.flatMap((r) => r.findings ?? []);
  const agent = findings.filter((f) => f.source === "agent");

  const found = theCase.planted.map((defect) => {
    const hits = agent.filter((f) => defect.evidence.test(said(f)));
    const landed = hits.filter((f) => f.file === defect.lands);
    return {
      name: defect.name,
      // Reported means it reached the developer, which means it landed where the server keeps it.
      reported: landed.length > 0,
      // Worth separating: a session that saw the defect and put it on an untouched line did the
      // hard half and lost it at the last step. That is a different repair from not looking.
      seenButMisplaced: landed.length === 0 && hits.length > 0,
      matched: (landed[0] ?? hits[0])?.message?.slice(0, 160) ?? "",
    };
  });

  const plantedFindings = new Set(
    theCase.planted.flatMap((defect) => agent.filter((f) => defect.evidence.test(said(f))))
  );
  const noise = agent.filter((f) => !plantedFindings.has(f));

  const quiet = (theCase.quiet ?? []).map((one) => {
    const hits = agent.filter(one.matches);
    return {
      name: one.name,
      reported: hits.length > 0,
      blocking: hits.some((f) => f.severity === "critical"),
      severity: hits.map((f) => f.severity).join(","),
    };
  });

  return {
    planted: theCase.planted.length,
    recall: found.filter((f) => f.reported).length,
    missed: theCase.planted.length - found.filter((f) => f.reported).length,
    noise: noise.length,
    found,
    quiet,
    noiseSaid: noise.map((f) => `${f.severity} ${f.file}:${f.line} ${f.message}`.slice(0, 160)),
    blocking: reviews.some((r) => r.blocking === true),
    submitted: agent.length,
    deterministic: findings.length - agent.length,
  };
}

// --------------------------------------------------------------------------------------------
// one run
// --------------------------------------------------------------------------------------------

async function runCase(name, { control }) {
  const theCase = EVERY_CASE[name];
  const slug = throwawaySlug(`score-${name.slice(0, 12)}`);
  const key = bootstrapProject(slug);
  const repo = buildPlainRepo(`smith-score-${name}-`, theCase.files());
  const home = mkdtempSync(join(tmpdir(), "smith-score-home-"));
  const pluginDir = control ? pluginWithCommandAt(BEFORE_THE_FIX) : PLUGIN_DIR;

  try {
    seedCredentials(home, API, key);
    console.log(`  ${name}${control ? " (control)" : ""} · ${theCase.about} · project ${slug}`);
    const session = runSession({ prompt: PROMPT, tools: TOOLS, repo, home, pluginDir });
    if (!session.ran) throw new Error(`the session did not run: ${session.failure}`);

    const reviews = await reviewsInProject(slug);
    const refusal = refuseToScore(reviews);
    if (refusal) throw new Error(`${refusal}\n  what it answered: ${session.text.slice(0, 200) || "(nothing)"}`);
    const score = scoreRun(theCase, reviews);
    score.searches = searchesOf(session.toolCalls).length;
    score.opened = reviews.length;
    score.saidIt = theCase.planted.map((d) => d.evidence.test(session.text));
    writeTranscript(name, control, { session, score, slug });
    return score;
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
    if (control) rmSync(join(pluginDir, ".."), { recursive: true, force: true });
    await discardProject(slug);
  }
}

function writeTranscript(name, control, { session, score, slug }) {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const path = join(OUTPUT_DIR, `score-${name}${control ? "-control" : ""}-${stamp}.txt`);
  const lines = [
    `case ${name}${control ? ` (control: the command at ${BEFORE_THE_FIX.slice(0, 7)})` : ""}`,
    `project ${slug} · ${score.searches} searches · ${score.opened} reviews opened`,
    `recall ${score.recall}/${score.planted} · noise ${score.noise} · blocking ${score.blocking}`,
    "",
    "planted:",
    ...score.found.map(
      (f) => `  ${f.reported ? "found " : f.seenButMisplaced ? "off-line" : "missed"}  ${f.name}${f.matched ? ` — ${f.matched}` : ""}`
    ),
    "",
    "not planted:",
    ...(score.noiseSaid.length ? score.noiseSaid.map((s) => `  ${s}`) : ["  (nothing)"]),
    "",
    "known non-defects:",
    ...(score.quiet.length ? score.quiet.map((q) => `  ${q.reported ? `reported as ${q.severity}` : "not reported"}  ${q.name}`) : ["  (none in this case)"]),
    "",
    "commands:",
    ...session.commands.map((c) => `  $ ${c}`),
    "",
    "what the developer read:",
    session.text,
  ];
  writeFileSync(path, `${lines.join("\n")}\n`);
  console.log(`    transcript: ${path}`);
}

// --------------------------------------------------------------------------------------------
// the reading
// --------------------------------------------------------------------------------------------

const range = (values) => {
  const low = Math.min(...values);
  const high = Math.max(...values);
  return low === high ? `${low}` : `${low}-${high}`;
};

function render(reading) {
  console.log("\ncase                       runs  recall        noise    blocked");
  for (const [name, runs] of Object.entries(reading.cases)) {
    const planted = runs[0].planted;
    console.log(
      `${name.padEnd(26)} ${String(runs.length).padStart(4)}  ` +
        `${`${range(runs.map((r) => r.recall))} of ${planted}`.padEnd(13)} ` +
        `${range(runs.map((r) => r.noise)).padEnd(8)} ` +
        `${runs.filter((r) => r.blocking).length}/${runs.length}`
    );
    for (const defect of runs[0].found.map((_, i) => i)) {
      const hits = runs.filter((r) => r.found[defect].reported).length;
      const off = runs.filter((r) => r.found[defect].seenButMisplaced).length;
      console.log(
        `    ${hits}/${runs.length}  ${runs[0].found[defect].name}` + (off ? `  (${off} off the changed line)` : "")
      );
    }
    for (const q of runs[0].quiet.map((_, i) => i)) {
      const hits = runs.filter((r) => r.quiet[q].reported).length;
      console.log(`    ${hits}/${runs.length}  reported anyway: ${runs[0].quiet[q].name}`);
    }
  }
  console.log(
    `\nworst run of each case: ${reading.missed} of ${reading.planted} planted defects missed, ` +
      `${reading.noise} findings that were not planted`
  );
}

/** The worst run of each case, summed. A budget set to the best run is a budget that fails randomly. */
function summarise(cases) {
  const runs = Object.values(cases);
  return {
    date: new Date().toISOString().slice(0, 10),
    cases: Object.fromEntries(Object.entries(cases).map(([name, list]) => [name, list])),
    caseCount: runs.length,
    runCount: runs.reduce((total, list) => total + list.length, 0),
    planted: runs.reduce((total, list) => total + list[0].planted, 0),
    missed: runs.reduce((total, list) => total + Math.max(...list.map((r) => r.missed)), 0),
    noise: runs.reduce((total, list) => total + Math.max(...list.map((r) => r.noise)), 0),
  };
}

/**
 * The scoring, exercised on findings nobody had to run a session for.
 *
 * Two measurement scripts here shipped able only to print zero and both read as good news for
 * weeks. So this proves the arithmetic moves in both directions before anything is read off it: a
 * review that finds everything scores full marks, one that finds nothing scores none, and one that
 * names the right thing on the wrong line is a miss.
 */
function selfCheck() {
  const theCase = CASES["first-reading"];
  const changed = theCase.changed;
  const perfect = theCase.planted.map((defect, i) => ({
    source: "agent",
    file: changed,
    line: 30 + i,
    severity: "warning",
    rule_id: "bug",
    message: `see ${defect.evidence.source.split("|")[0]}`,
    suggestion: "",
  }));

  const full = scoreRun(theCase, [{ findings: perfect, blocking: false }]);
  const empty = scoreRun(theCase, [{ findings: [], blocking: false }]);
  const offLine = scoreRun(theCase, [
    { findings: perfect.map((f) => ({ ...f, file: "core/src/com/acme/core/pricing/AcmePricingRules.java" })), blocking: false },
  ]);
  const noisy = scoreRun(theCase, [
    {
      findings: [
        ...perfect,
        { source: "agent", file: changed, line: 9, severity: "suggestion", rule_id: "bug", message: "this constant could be configurable" },
        { source: "deterministic", file: changed, line: 9, severity: "critical", rule_id: "hardcoded-secret", message: "not the agent's" },
      ],
      blocking: false,
    },
  ]);
  const falsePositive = scoreRun(theCase, [
    {
      findings: [
        { source: "agent", file: changed, line: 27, severity: "critical", rule_id: "no-model-in-facade", message: "the facade takes a Model" },
      ],
      blocking: true,
    },
  ]);

  const rows = [
    ["a review that reports all three", full.recall === 3 && full.missed === 0 && full.noise === 0],
    ["a review that reports nothing", empty.recall === 0 && empty.missed === 3 && empty.noise === 0],
    ["the right defect on an untouched line is a miss", offLine.recall === 0 && offLine.found.every((f) => f.seenButMisplaced)],
    ["a fourth finding nobody planted is noise", noisy.recall === 3 && noisy.noise === 1],
    ["a deterministic finding is not the agent's noise", noisy.deterministic === 1],
    ["the known non-defect is reported and blocking", falsePositive.quiet[0].reported && falsePositive.quiet[0].blocking],
    ["and it is noise as well as a non-defect", falsePositive.noise === 1 && falsePositive.missed === 3],
    // Both halves, because conflating them is what wrote a reading of five misses nobody ran.
    ["a session that opened no review is refused, not scored", refuseToScore([]) !== ""],
    ["a review that found nothing is scored, and it is a miss", refuseToScore([{ findings: [] }]) === "" && empty.missed === 3],
  ];
  let bad = 0;
  for (const [what, ok] of rows) {
    console.log(`  ${ok ? "ok  " : "FAIL"}  ${what}`);
    if (!ok) bad++;
  }
  return bad;
}

// --------------------------------------------------------------------------------------------

function arg(flag, fallback) {
  const at = process.argv.indexOf(flag);
  return at === -1 ? fallback : process.argv[at + 1];
}

async function main() {
  if (process.argv.includes("--self-check")) {
    console.log("the score, on findings nobody had to run a session for:");
    process.exit(selfCheck() ? 1 : 0);
  }

  const control = process.argv.includes("--control");
  const runs = Number(arg("--runs", control ? "1" : "2"));
  const only = arg("--case", "");
  // A held-out case runs only when it is named. Putting one in the default set would make it part
  // of what the command is tuned against, which is the one thing it is for.
  const names = only ? only.split(",") : Object.keys(CASES);
  for (const name of names) {
    if (!EVERY_CASE[name]) {
      console.error(`unknown case "${name}" — one of: ${Object.keys(EVERY_CASE).join(", ")}`);
      process.exit(1);
    }
  }

  const health = await fetch(`${API}/health`, { headers: NO_KEEPALIVE }).catch(() => null);
  if (!health?.ok) {
    console.error(`nothing is answering at ${API}. Start it with:\n  uv run uvicorn smith.main:app --port 8094`);
    process.exit(1);
  }

  // A run killed mid-case never reaches its own cleanup, so this one clears what the last one left.
  console.log(await tidyAfterEarlierRuns({ api: API, email: LEAD_EMAIL, password: LEAD_PASSWORD }));

  console.log(
    `api ${API} · ${names.length} cases · ${runs} runs each` +
      `${control ? ` · against the command at ${BEFORE_THE_FIX.slice(0, 7)}` : ""}\n`
  );
  const cases = {};
  for (const name of names) {
    cases[name] = [];
    for (let run = 0; run < runs; run++) {
      cases[name].push(await runCase(name, { control }));
    }
  }

  const reading = summarise(cases);
  render(reading);

  if (process.argv.includes("--record")) {
    if (control) {
      console.error("\na control reading is not the score. --record writes what the shipped command did.");
      process.exit(1);
    }
    const heldOut = names.filter((name) => name in HELD_OUT);
    if (heldOut.length) {
      console.error(`\n${heldOut.join(", ")} is held out. Recording it makes it part of the scored set.`);
      process.exit(1);
    }
    writeFileSync(SCORE_FILE, `${JSON.stringify(reading, null, 2)}\n`);
    console.log(`\nrecorded in ${SCORE_FILE}`);
  }
}

main().catch((err) => {
  console.error(`\nthe scored set did not finish: ${err.message}`);
  process.exit(1);
});
