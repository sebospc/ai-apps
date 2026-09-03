/**
 * The finding lifecycle, rehearsed end to end through the plugin CLI, then read back by the lead.
 *
 * No language model takes part: every step here belongs to the deterministic half of a review, so
 * the script runs the same way every time and can be run on every change. What it proves is the
 * part unit tests cannot reach — that a dismissal survives into the next review, that a fix which
 * held is settled quietly, that a fix which did not hold comes back saying so, and that every one
 * of those answers reaches the lead's two screens with the developer's name on it.
 *
 * The reviews are run with a developer's key, never the lead's, because a rehearsal where both
 * halves are the same person proves nothing about attribution — which is the whole of phase K.
 *
 * The repository under review is built from real client code, not from our own fixtures: a
 * lifecycle that only works on files we wrote has proved nothing about the product.
 *
 *   scripts/ensure_db.sh
 *   uv run uvicorn smith.main:app --port 8099 &
 *   node scripts/rehearse.mjs
 *
 * Env: SMITH_API_URL, SMITH_CORPUS.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  bootstrapProject,
  buildRepo,
  edit,
  introduceProblems,
  JALO_SESSION,
  SYSTEM_OUT,
} from "./lib/corpus_repo.mjs";

const API = process.env.SMITH_API_URL ?? "http://localhost:8099";
const SMITH_CLI = new URL("../plugin/bin/smith", import.meta.url).pathname;

const OUTPUT_DIR = new URL("../output", import.meta.url).pathname;

const LEAD_EMAIL = "rehearsal@smith.test";
const LEAD_PASSWORD = "rehearsal-password";
const DEV_EMAIL = "rehearsal-dev@smith.test";

const DISMISSAL = "this rehearsal reaches Jalo on purpose";

const TRANSCRIPT = join(OUTPUT_DIR, `rehearsal-lead-${new Date().toISOString().slice(0, 10)}.txt`);

let passed = 0;
const failures = [];
const transcript = [];

/** Everything the run says, kept so the whole walkthrough lands on disk as evidence. */
function say(line = "") {
  transcript.push(line);
  console.log(line);
}

// Written on the way out, whichever way out it is: the transcript somebody wants to read is the
// one from the run that failed.
process.on("exit", () => {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const header = `# Smith rehearsal, developer and lead — ${new Date().toISOString()}`;
  writeFileSync(TRANSCRIPT, `${[header, ...transcript].join("\n")}\n`);
});

function check(name, condition, detail = "") {
  if (condition) {
    passed++;
    say(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    say(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// --------------------------------------------------------------------------------------------
// the plugin CLI
// --------------------------------------------------------------------------------------------

/**
 * The plugin CLI, run the way the agent runs it.
 *
 * Credentials arrive in the environment, except when a home directory is passed on its own: that is
 * a new shell finding what `smith auth` saved to disk, which is the path a resumed conversation
 * takes.
 */
function smith(args, { key = "", input = "", cwd = undefined, home } = {}) {
  const env = { ...process.env, SMITH_HOME: home };
  delete env.SMITH_URL;
  delete env.SMITH_KEY;
  if (key) {
    env.SMITH_URL = API;
    env.SMITH_KEY = key;
  }
  try {
    return execFileSync("node", [SMITH_CLI, ...args], { cwd, input, encoding: "utf8", env });
  } catch (err) {
    // Exit 1 is how a blocking verdict is reported, not a failure to run. The JSON is still there.
    if (err.stdout) return err.stdout;
    throw new Error(`smith ${args.join(" ")} failed: ${err.stderr || err.message}`);
  }
}

const smithJson = (args, options) => JSON.parse(smith(args, options));

const byRule = (plan, ruleId) => plan.deterministic_findings.find((f) => f.rule_id === ruleId);
const byFingerprint = (findings, fingerprint) =>
  findings.find((f) => f.fingerprint === fingerprint);

/** Answer one finding the way a developer does: by the number they can see in front of them. */
function respond(key, reviewId, finding, disposition, note = "") {
  return smithJson(["respond", String(reviewId)], {
    key,
    input: JSON.stringify({ responses: [{ finding: finding.index, disposition, note }] }),
  });
}

// --------------------------------------------------------------------------------------------
// the review's own trail
// --------------------------------------------------------------------------------------------

/**
 * What the server recorded about a plan, read the way the lead reads it.
 *
 * A confirmed fix is a quiet reward: the developer is told about it by an absence, so the plan the
 * plugin prints has nothing to show. The count lives on the review's trail, and that is the only
 * place a claim being settled can be told apart from a claim nobody ever made.
 */
let sessionCookie = "";

// The run leaves a connection idle for minutes at a time while the CLI works, and a pooled socket
// the server has since closed surfaces as ECONNRESET on the next read. Never reuse one.
const NO_KEEPALIVE = { connection: "close" };

async function signInAsLead() {
  const res = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { ...NO_KEEPALIVE, "content-type": "application/json" },
    body: JSON.stringify({ email: LEAD_EMAIL, password: LEAD_PASSWORD }),
  });
  if (!res.ok) throw new Error(`could not sign in as ${LEAD_EMAIL}: ${res.status}`);
  const cookies = res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie") ?? ""];
  sessionCookie = cookies.filter(Boolean).map((cookie) => cookie.split(";")[0]).join("; ");
}

/** What the lead's browser would ask for, asked with the lead's session and nothing else. */
async function asLead(path, body = null) {
  const res = await fetch(`${API}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      ...NO_KEEPALIVE,
      cookie: sessionCookie,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${path} answered ${res.status}: ${await res.text()}`);
  return res.json();
}

/** Remove the throwaway project this run created. Never fails the run: a rehearsal that passed and
 *  could not tidy up is still a rehearsal that passed, and the message says what was left. */
async function discardProject(slug) {
  try {
    await fetch(`${API}/projects/${slug}`, {
      method: "DELETE",
      headers: { ...NO_KEEPALIVE, cookie: sessionCookie },
    });
    return `removed the project it created (${slug})`;
  } catch (err) {
    return `left ${slug} behind: ${err.message}`;
  }
}

async function planStep(slug, reviewId) {
  const detail = await asLead(`/projects/${slug}/reviews/${reviewId}`);
  return detail.steps.find((step) => step.kind === "plan")?.payload ?? {};
}

/** A developer on the project and a key bound to them, issued the way a lead issues one. */
async function hireDeveloper(slug) {
  await asLead(`/projects/${slug}/members`, { email: DEV_EMAIL, role: "dev" });
  const { key } = await asLead(`/projects/${slug}/keys`, {
    name: "rehearsal developer",
    for_email: DEV_EMAIL,
  });
  return key;
}

// The sentence the review page builds out of one answer. Kept in step with the wording in
// `web/app/p/[slug]/review/[id]/page.tsx`: if what the lead reads there stops making sense on its
// own, this rehearsal prints the same nonsense and the failure is visible instead of theoretical.
const ANSWER_VERB = {
  fixed: "fixed this",
  dismissed: "ruled this out",
  accepted: "accepted this",
  confirmed_fixed: "fixed this, and a later review confirmed it",
};

function answerSentence(answer) {
  const said = `${answer.by} ${ANSWER_VERB[answer.disposition] ?? "answered this"} on ${answer.at}`;
  return answer.note ? `${said}. Reason recorded: ${answer.note}` : said;
}

// --------------------------------------------------------------------------------------------
// the repository under review
// --------------------------------------------------------------------------------------------

const removeSystemOut = (text) => text.replace(`${SYSTEM_OUT}\n`, "");
const restoreSystemOut = (text) =>
  text.replace(`${JALO_SESSION}\n`, `${SYSTEM_OUT}\n${JALO_SESSION}\n`);

// --------------------------------------------------------------------------------------------
// the rehearsal
// --------------------------------------------------------------------------------------------

async function main() {
  const health = await fetch(`${API}/health`, { headers: NO_KEEPALIVE }).catch(() => null);
  if (!health?.ok) {
    console.error(
      `nothing is answering at ${API}. Start it with:\n  uv run uvicorn smith.main:app --port 8099`
    );
    process.exit(1);
  }

  const slug = `rehearse-${Date.now().toString(36)}`;
  bootstrapProject(slug, LEAD_EMAIL, LEAD_PASSWORD);
  await signInAsLead();
  const key = await hireDeveloper(slug);
  const { repo, target } = buildRepo();
  const home = mkdtempSync(join(tmpdir(), "smith-rehearse-home-"));
  const freshShell = mkdtempSync(join(tmpdir(), "smith-rehearse-shell-"));
  say(`api ${API} · project ${slug} · developer ${DEV_EMAIL} · change in ${target}\n`);

  try {
    // --- 1. a change a developer would actually ask about ---------------------------------------
    introduceProblems(repo, target);
    const plan = smithJson(["plan", "--title", "rehearsal"], { key, home, cwd: repo });

    check("plan opens a review", Number.isInteger(plan.review_id) && plan.review_id > 0);
    check(
      "the plan carries the policy the verdict will be computed from",
      plan.policy?.block_on === "critical" && plan.policy.max_findings > 0,
      JSON.stringify(plan.policy)
    );
    check(
      "every finding carries the number a developer points at and the id Smith keeps",
      plan.deterministic_findings.length > 0 &&
        plan.deterministic_findings.every(
          (f, i) => f.index === i + 1 && /^[0-9a-f]{40}$/.test(f.fingerprint)
        )
    );

    const jalo = byRule(plan, "service-no-session");
    const systemOut = byRule(plan, "no-system-out");
    const stackTrace = byRule(plan, "no-printstacktrace");
    check(
      "the three injected problems are all found in real code",
      Boolean(jalo && systemOut && stackTrace),
      plan.deterministic_findings.map((f) => f.rule_id).join(", ")
    );
    if (!jalo || !systemOut || !stackTrace) throw new Error("nothing left to rehearse");

    // --- 2. the verdict, and what moves it -------------------------------------------------------
    const opened = smithJson(["submit", String(plan.review_id)], {
      key,
      home,
      input: JSON.stringify({ findings: [] }),
    });
    const criticals = opened.counts.critical ?? 0;
    check("a critical finding blocks the review", opened.blocking === true && criticals >= 1);

    const argued = respond(key, plan.review_id, jalo, "dismissed", DISMISSAL);
    check(
      "dismissing a finding recomputes the verdict rather than acknowledging it",
      (argued.counts.critical ?? 0) === criticals - 1,
      `critical went ${criticals} -> ${argued.counts.critical ?? 0}`
    );

    // --- 3. the dismissal survives into the next review -------------------------------------------
    const second = smithJson(["plan"], { key, home, cwd: repo });
    const muted = byFingerprint(second.suppressed_findings, jalo.fingerprint);
    check("a dismissed finding comes back suppressed, not silently gone", Boolean(muted));
    check(
      "the suppression quotes who muted it and why",
      Boolean(muted?.suppressed_reason?.includes(DISMISSAL)) &&
        muted.suppressed_reason.includes("dismissed by"),
      muted?.suppressed_reason
    );
    check(
      "a dismissed finding is never shown as open again",
      !byFingerprint(second.deterministic_findings, jalo.fingerprint)
    );
    const afterMuting = smithJson(["submit", String(second.review_id)], {
      key,
      home,
      input: JSON.stringify({ findings: [] }),
    });
    check(
      "a dismissed finding no longer counts toward the verdict",
      (afterMuting.counts.critical ?? 0) === criticals - 1,
      JSON.stringify(afterMuting.counts)
    );

    // --- 4. a fix that held ------------------------------------------------------------------------
    const systemOutAgain = byRule(second, "no-system-out");
    check(
      "a finding keeps its identity across reviews even as its number changes",
      systemOutAgain?.fingerprint === systemOut.fingerprint
    );
    respond(key, second.review_id, systemOutAgain, "fixed");
    edit(repo, target, removeSystemOut);

    const third = smithJson(["plan"], { key, home, cwd: repo });
    check(
      "a finding reported fixed and actually fixed does not come back",
      !byFingerprint(third.deterministic_findings, systemOut.fingerprint) &&
        !byFingerprint(third.suppressed_findings, systemOut.fingerprint)
    );
    const confirming = await planStep(slug, third.review_id);
    check(
      "the review that met the fix records it as confirmed",
      confirming.fixed_confirmed === 1 && confirming.regressed === 0,
      JSON.stringify(confirming)
    );

    // Settled, not merely quiet: writing the same problem again is met as a new problem, which is
    // the only way to tell a confirmed fix apart from a claim nobody ever checked.
    edit(repo, target, restoreSystemOut);
    const fourth = smithJson(["plan"], { key, home, cwd: repo });
    const writtenAgain = byFingerprint(fourth.deterministic_findings, systemOut.fingerprint);
    check(
      "a confirmed fix settles the claim instead of leaving it standing",
      Boolean(writtenAgain) && writtenAgain.regressed === false
    );

    // --- 5. a fix that did not hold ----------------------------------------------------------------
    const stackTraceAgain = byRule(fourth, "no-printstacktrace");
    respond(key, fourth.review_id, stackTraceAgain, "fixed");

    const fifth = smithJson(["plan"], { key, home, cwd: repo });
    const stillThere = byFingerprint(fifth.deterministic_findings, stackTrace.fingerprint);
    check(
      "a finding reported fixed that is still there comes back saying the fix did not hold",
      Boolean(stillThere) && stillThere.regressed === true,
      JSON.stringify(stillThere)
    );
    const regressing = await planStep(slug, fifth.review_id);
    check(
      "the review that met the unfixed claim records the regression",
      regressing.regressed === 1 && regressing.fixed_confirmed === 0,
      JSON.stringify(regressing)
    );

    // --- 6. a conversation that lost its plan --------------------------------------------------------
    smith(["auth", "--url", API, "--key", key], { home: freshShell });
    const recovered = smithJson(["review", String(fifth.review_id)], { home: freshShell });
    check(
      "a new shell recovers the review from the credentials on disk alone",
      recovered.review_id === fifth.review_id
    );
    check(
      "the recovered review numbers its findings the same way the plan did",
      recovered.findings.length === fifth.deterministic_findings.length &&
        recovered.findings.every((f, i) => f.index === i + 1)
    );
    check(
      "the recovered review still shows what was muted and why",
      Boolean(
        byFingerprint(recovered.suppressed_findings, jalo.fingerprint)?.suppressed_reason?.includes(
          DISMISSAL
        )
      )
    );
    // --- 7. the same conversation, read by the lead --------------------------------------------
    // Everything above went through the plugin, under the developer's key. The question the lead
    // opens the UI to answer is what that developer did with the findings, and there is only one
    // place that answer can come from: these two endpoints, behind the lead's session.
    const project = await asLead(`/projects/${slug}/reviews`);
    check(
      "the lead's project page lists the reviews under the developer who ran them",
      project.role === "lead" &&
        project.reviews.length >= 5 &&
        project.reviews.every((r) => r.author === DEV_EMAIL),
      project.reviews.map((r) => r.author).join(", ")
    );

    const filtered = await asLead(
      `/projects/${slug}/reviews?author=${encodeURIComponent(DEV_EMAIL)}`
    );
    check(
      "narrowing the list to that developer names them and keeps every one of their reviews",
      filtered.author === DEV_EMAIL && filtered.reviews.length === project.reviews.length,
      `${filtered.author} · ${filtered.reviews.length} of ${project.reviews.length}`
    );

    const reviewPage = await asLead(`/projects/${slug}/reviews/${plan.review_id}`);
    const argument = byFingerprint(reviewPage.findings, jalo.fingerprint)?.answer;
    const held = byFingerprint(reviewPage.findings, systemOut.fingerprint)?.answer;
    check(
      "the finding the developer argued with reaches the lead with their words on it",
      argument?.disposition === "dismissed" &&
        argument.note === DISMISSAL &&
        argument.by === DEV_EMAIL,
      JSON.stringify(argument)
    );
    check(
      "the finding the developer fixed reaches the lead as a fix that held",
      held?.disposition === "confirmed_fixed" && held.by === DEV_EMAIL,
      JSON.stringify(held)
    );
    check(
      "a finding nobody answered carries nothing for the lead to read into",
      reviewPage.findings.some((f) => f.answer === null)
    );

    // The point of the phase, out loud. If either of these needs explaining, the screen does too.
    const sentences = [argument, held].map(answerSentence);
    check(
      "both sentences name the developer, and the one they argued quotes what they said",
      sentences.every((sentence) => sentence.includes(DEV_EMAIL)) &&
        sentences[0].includes(DISMISSAL),
      sentences.join(" / ")
    );
    say("\nWhat the lead reads on that review, and the reason recorded against each answer:");
    for (const sentence of sentences) say(`  ${sentence}`);
  } finally {
    for (const path of [repo, home, freshShell]) rmSync(path, { recursive: true, force: true });
    // A failing run cleans up too: 94 projects nobody could open is what not doing this looks like
    // after a few weeks.
    say(`\n${await discardProject(slug)}`);
  }

  say(`\n${passed} passed, ${failures.length} failed`);
  for (const failure of failures) say(`  - ${failure}`);
  say(`transcript: ${TRANSCRIPT}`);
  if (failures.length) process.exit(1);
}

main().catch((err) => {
  // `fetch` reports every network problem as "fetch failed" and hides the reason in `cause`.
  const message = `\nrehearsal failed: ${err.message}${err.cause ? ` (${err.cause})` : ""}`;
  transcript.push(message);
  console.error(message);
  process.exit(1);
});
