/**
 * Functional test through a real browser: sign in, walk the screens, change the review setup.
 *
 * This is the half that unit tests cannot reach — the login Server Action moving a cookie from the
 * API onto the browser, and forms that only exist once React has hydrated. Assume nothing about the
 * data: it creates its own project and drives the plugin CLI to produce a review to look at.
 *
 *   node scripts/e2e_browser.mjs            (needs Node >= 22 and the API + web running)
 *
 * Env: SMITH_WEB_URL, SMITH_API_URL, SMITH_LEAD_EMAIL, SMITH_LEAD_PASSWORD
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { launch } from "./cdp.mjs";

const WEB = process.env.SMITH_WEB_URL ?? "http://localhost:3000";
const API = process.env.SMITH_API_URL ?? "http://localhost:8099";
const EMAIL = process.env.SMITH_LEAD_EMAIL ?? "lead@acme.com";
const PASSWORD = process.env.SMITH_LEAD_PASSWORD ?? "correct-horse-battery";
const SLUG = `e2e-${Date.now().toString(36)}`;
const SCREENS = new URL("../output/screens/", import.meta.url).pathname;

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

/** `rgba(0, 0, 0, 0)` is a body with no background at all, which paints white — not black. */
function isDark(color) {
  const channels = String(color).match(/[\d.]+/g);
  if (!channels) return false;
  const [red, green, blue, alpha = 1] = channels.map(Number);
  return alpha === 1 && (red + green + blue) / 3 < 40;
}

/**
 * A screen is only working if it is also quiet. Nothing in the console, nothing 404ing, nothing
 * moving under the reader, and dark from the first frame rather than after hydration.
 */
/** Remove the throwaway project this run created, whatever happened to the run. Signs in over HTTP
 *  rather than through the page, because the browser is already closed by the time this runs.
 *  Never throws: a red run reporting its own failure beats a red run reporting a cleanup error. */
async function discardProject() {
  try {
    const login = await fetch(`${API}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) return `left ${SLUG} behind: could not sign in to remove it`;
    const gone = await fetch(`${API}/projects/${SLUG}`, { method: "DELETE", headers: { cookie } });
    // 403 is the expected answer once the happy path already deleted it through the screen.
    return gone.ok ? `removed the project it created (${SLUG})` : `${SLUG} was already gone`;
  } catch (err) {
    return `left ${SLUG} behind: ${err.message}`;
  }
}

async function auditScreen(page, screen) {
  const seen = await page.audit();
  check(`${screen}: says nothing to the console`, seen.messages.length === 0, seen.messages.join(" | "));
  check(`${screen}: every request succeeded`, seen.requests.length === 0, seen.requests.join(" | "));
  check(
    `${screen}: content does not jump under the reader`,
    seen.cumulativeLayoutShift !== null && seen.cumulativeLayoutShift < 0.1,
    `cumulative layout shift ${seen.cumulativeLayoutShift}`
  );
  check(
    `${screen}: dark from the first frame, not after hydration`,
    isDark(seen.firstPaintBackground) && isDark(seen.background),
    `first paint ${seen.firstPaintBackground}, hydrated ${seen.background}`
  );
  await captureWidths(page, screen);
}

/** A phone, a tablet and a laptop. Between them they catch the layouts that only break at one size. */
const WIDTHS = [390, 768, 1440];

/**
 * Photograph the screen at each width and check nothing sticks out sideways.
 *
 * The screenshots are for a human — or an agent — to look at afterwards; no baseline is stored,
 * because a baseline only tells you the page changed, never whether the change was an improvement.
 * The overflow check is the part a machine can settle on its own, and it is the failure that
 * actually happens: a card an inch wider than a phone, scrollable to nowhere.
 */
async function captureWidths(page, screen) {
  for (const width of WIDTHS) {
    await page.screenshot(join(SCREENS, String(width), `${screen}.png`), { width });
    const { viewport, scrollWidth, offenders } = await page.overflow();
    check(
      `${screen} at ${width}px: nothing reaches past the edge of the screen`,
      scrollWidth <= viewport + 1 && offenders.length === 0,
      `scrollWidth ${scrollWidth} > viewport ${viewport}${offenders.length ? ` — ${offenders.join(", ")}` : ""}`
    );
  }
  await page.resetViewport();
}

const SMITH_CLI = new URL("../plugin/bin/smith", import.meta.url).pathname;

/** The plugin CLI, run the way the agent runs it: credentials in the environment, JSON on stdin. */
function smithCli(apiKey, args, input = "", cwd = undefined) {
  const options = {
    cwd,
    input,
    encoding: "utf8",
    env: { ...process.env, SMITH_HOME: mkdtempSync(join(tmpdir(), "smith-e2e-home-")), SMITH_URL: API, SMITH_KEY: apiKey },
  };
  try {
    return execFileSync("node", [SMITH_CLI, ...args], options);
  } catch (err) {
    // Exit 1 is how a blocking verdict is reported, not a failure to run. The JSON is still there.
    if (err.stdout) return err.stdout;
    throw new Error(`smith ${args.join(" ")} failed: ${err.stderr || err.message}`);
  }
}

/** Produce a real review through the plugin CLI, so the screens have something truthful to show. */
function seedReview(apiKey) {
  const repo = mkdtempSync(join(tmpdir(), "smith-e2e-repo-"));
  const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "dev@acme.com");
  git("config", "user.name", "Dev");
  const propertiesPath = "hybris/config/customer/acme/local-integration.properties";
  // Paths as long as the real ones. A short path is how a screen passes a width check it would fail
  // in front of a customer, and a class name is the worst case: a browser wraps a path after a
  // slash or a hyphen, so only a long CamelCase segment proves the layout can take one.
  const javaPath =
    "hybris/bin/custom/acme/acmecore/src/com/acme/core/service/impl/DefaultAcmeStorefrontIntegrationService.java";
  for (const path of [propertiesPath, javaPath]) {
    mkdirSync(join(repo, dirname(path)), { recursive: true });
  }
  writeFileSync(join(repo, propertiesPath), "solr.host=localhost\n");
  writeFileSync(join(repo, javaPath), "package com.acme.core.service.impl;\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  writeFileSync(
    join(repo, propertiesPath),
    // `solr.host=search.internal` is deliberately wordy: a change whose every added line is
    // shorter than four tokens is triaged as trivial and never becomes a review.
    "solr.host=localhost\ndb.password=Sup3rSecret!\nsolr.host=search.internal\ntimeout.ms=\n"
  );
  writeFileSync(
    join(repo, javaPath),
    "package com.acme.core.service.impl;\n\n" +
      "public class DefaultAcmeStorefrontIntegrationService {\n" +
      '  private static final String CLIENT_SECRET = "Hf83kdmZq19xPl";\n' +
      "}\n"
  );

  const plan = JSON.parse(
    smithCli(apiKey, ["plan", "--title", "e2e seeded review"], "", repo)
  );
  // Submitting is what makes it a review. A row that only ever got a plan is a mechanism `submit`
  // needs, and a lead never sees one — so seeding without this would seed something invisible.
  smithCli(apiKey, ["submit", String(plan.review_id)], JSON.stringify({ findings: [] }));

  // A second plan, abandoned the way a cancelled session abandons one. It exists, it has the same
  // deterministic findings, and it must not reach the screens below.
  const abandoned = JSON.parse(
    smithCli(apiKey, ["plan", "--title", "e2e abandoned plan"], "", repo)
  );
  rmSync(repo, { recursive: true, force: true });
  return { ...plan, abandoned_id: abandoned.review_id };
}

async function main() {
  console.log(`web ${WEB} · api ${API} · project ${SLUG}\n`);
  const page = await launch({ headless: process.env.SMITH_HEADFUL !== "1" });

  try {
    // --- sign in -------------------------------------------------------------------------------
    await page.goto(`${WEB}/`);
    await page.waitForText("Sign in");
    check("anonymous visitor is sent to the sign-in page", (await page.url()) === "/login");
    await auditScreen(page, "login");

    await page.fill('input[name="email"]', EMAIL);
    await page.fill('input[name="password"]', "wrong-password-entirely");
    await page.click('button[type="submit"]');
    await page.waitForText("Invalid credentials");
    check("a wrong password is refused in the browser", true);

    // Refill both: the form re-rendered to show the error, and an uncontrolled input may have
    // been reset in the process.
    await page.fill('input[name="email"]', EMAIL);
    await page.fill('input[name="password"]', PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForText("Projects");
    check("signing in lands on the projects page", (await page.text()).includes(EMAIL));

    // Signing in leaves the browser mid-way through a client-side render. Load the screen again so
    // the audit measures it the way a developer arriving with a cookie already set would see it.
    await page.goto(`${WEB}/`);
    await page.waitForText("Projects");
    await auditScreen(page, "projects");

    // --- create a project ----------------------------------------------------------------------
    await page.fill('input[name="slug"]', SLUG);
    // The name carries the slug: waiting for a fixed name would match a project left behind by an
    // earlier run and race ahead of this one being created.
    await page.fill('input[name="name"]', `E2E ${SLUG}`);
    // Be specific: the first form on this page is Sign out.
    await page.click('form:has(input[name="slug"]) button');
    await page.waitForText(`E2E ${SLUG}`);
    check("a created project appears in the list", true);

    // --- members and keys ------------------------------------------------------------------------
    await page.goto(`${WEB}/p/${SLUG}/settings`);
    await page.waitForText("Review setup");
    check("settings screen loads for a lead", (await page.text()).includes("Plugin keys"));
    await auditScreen(page, "settings");

    // `input[name="email"]` also matches the hidden inputs in each member's Remove form; the typed
    // field is the only one of type=email.
    await page.fill('input[type="email"]', "dev@acme.com");
    await page.click('form:has(input[type="email"]) button');
    await page.waitForText("dev@acme.com");
    check("a developer can be added from the browser", true);

    await page.evaluate(`
      const select = document.querySelector('select[name="for_email"]');
      const setter = Object.getOwnPropertyDescriptor(select.constructor.prototype, "value").set;
      setter.call(select, "dev@acme.com");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    `);
    await page.fill('input[name="name"]', "e2e key");
    await page.click('form:has(select[name="for_email"]) button');
    const afterKey = await page.waitForText("copy it now");
    const key = afterKey.match(/smk_[a-z0-9]+_[A-Za-z0-9_-]+/)?.[0];
    check("a key issued for a developer is shown once", Boolean(key));
    check("the key list attributes it to the developer", afterKey.includes("dev@acme.com"));

    // --- the review a developer produced ----------------------------------------------------------
    const plan = seedReview(key);
    check("the plugin could review with that key", Boolean(plan.review_id));

    await page.goto(`${WEB}/p/${SLUG}`);
    await page.waitForText("e2e seeded review");
    const list = await page.text();
    check("the review is listed under the developer who ran it", list.includes("dev@acme.com"));
    // Reported 2026-09-08: a cancelled session left a review in the lead's list with six warnings
    // on a change nobody had read. A plan is not a review until it has a verdict.
    check(
      "a plan nobody finished is not in the list",
      !list.includes("e2e abandoned plan"),
      list.slice(0, 400)
    );
    await auditScreen(page, "reviews");

    // --- one developer's reviews ------------------------------------------------------------------
    // The author on a row is the way in: a lead answering "how is this person doing" clicks the
    // name they are already reading, and never types a query.
    await page.click(`a[href="/p/${SLUG}?author=dev%40acme.com"]`);
    await page.waitForText("Reviews by dev@acme.com");
    const filtered = await page.text();
    check("clicking an author filters the list to that developer", filtered.includes("e2e seeded review"));

    await page.goto(`${WEB}/p/${SLUG}?author=${encodeURIComponent(EMAIL)}`);
    await page.waitForText(`No reviews from ${EMAIL}`);
    check("an author with no reviews gets the empty state, not an error", true);

    await page.click(`a[href="/p/${SLUG}"]`);
    await page.waitForText("Every review in this project");
    check("the filtered list offers the way back to all of them", (await page.text()).includes("dev@acme.com"));

    await page.click(`a[href="/p/${SLUG}/review/${plan.review_id}"]`);
    await page.waitForText("What happened");
    const detail = await page.text();
    check("the finding is on the review page", detail.includes("properties-hardcoded-secret"));
    check("the trail explains what the server did", detail.includes("deterministic rules"));

    // --- every answer carries a reference a lead can quote ----------------------------------------
    const traced = await fetch(`${API}/health`);
    check("every response hands back a reference for the log", Boolean(traced.headers.get("x-request-id")));

    // --- a developer argues with a finding, and the lead sees the argument -------------------------
    // Through the CLI, not a raw fetch: `smith respond` is what the agent actually runs.
    const answered = JSON.parse(
      smithCli(
        key,
        ["respond", String(plan.review_id)],
        JSON.stringify({
          responses: [
            { finding: 1, disposition: "dismissed", note: "that password is a throwaway fixture" },
          ],
        })
      )
    );
    check("a developer can dismiss a finding with a reason", answered.recorded === 1);

    // The argument has to land on the review it was made about, not only on the next one.
    await page.goto(`${WEB}/p/${SLUG}/review/${plan.review_id}`);
    await page.waitForText("What happened");
    const argued = await page.text();
    check(
      "the review the developer argued on shows what they said",
      argued.includes("ruled this out") && argued.includes("throwaway fixture"),
      argued.slice(0, 600)
    );
    // Reported, not quoted. What reaches the lead is the developer's agent's wording, so the screen
    // must not print it as if it were the sentence the developer typed.
    check(
      "the reason reaches the lead as recorded rather than as a quotation",
      argued.includes("Reason recorded: that password is a throwaway fixture"),
      argued.slice(0, 600)
    );
    check(
      "the trail names the step in words, not in Smith's vocabulary",
      argued.includes("Developer answered the findings") &&
        !argued.includes("responses:") &&
        !argued.includes("[object Object]"),
      argued.slice(argued.indexOf("What happened"), argued.indexOf("What happened") + 400)
    );

    const refetched = JSON.parse(smithCli(key, ["review", String(plan.review_id)]));
    check(
      "a review can be re-fetched when the conversation lost the plan",
      refetched.review_id === plan.review_id && refetched.findings.every((f) => f.fingerprint)
    );

    // The same code again: the dismissal has to follow the fingerprint into the next review.
    const second = seedReview(key);
    await page.goto(`${WEB}/p/${SLUG}/review/${second.review_id}`);
    await page.waitForText("recorded but not counted");
    // Audit before opening the <details> below: that shift is one the test caused, not one the app
    // inflicts on a reader, and the observer cannot tell scripted clicks from real ones.
    await auditScreen(page, "review");
    // The suppressed list is a collapsed <details>, and innerText skips what is not shown.
    await page.evaluate(`document.querySelector("details").open = true; return true`);
    const suppressed = await page.text();
    check("the lead sees the dismissed finding, not a silence", suppressed.includes("Not counted:"));
    check(
      "the dismissal quotes who said it and why",
      suppressed.includes("dev@acme.com") && suppressed.includes("throwaway fixture"),
      suppressed.slice(0, 400)
    );

    // --- the dismissal comes back to the lead as rule health ---------------------------------------
    await page.goto(`${WEB}/p/${SLUG}/settings`);
    await page.waitForText("Review setup");
    const setup = await page.text();
    check("the settings screen reports how often a rule fired", /fired \d+×, dismissed \d+×/.test(setup));
    check(
      "the lead can read the argument against the rule on its row",
      setup.includes("throwaway fixture"),
      setup.slice(setup.indexOf("Rules"), setup.indexOf("Rules") + 300)
    );

    // --- change the setup and prove it takes effect -------------------------------------------------
    await page.goto(`${WEB}/p/${SLUG}/settings`);
    await page.waitForText("Review setup");
    await page.evaluate(`
      const box = document.querySelector('input[value="properties-hardcoded-secret"]')
        ?? [...document.querySelectorAll('input[name="enabled"]')].find(i => i.value.includes("facades"));
      if (box && box.checked) box.click();
      document.querySelector('textarea[name="conventions"]').focus();
    `);
    await page.fill('textarea[name="conventions"]', "Direct model use in facades is intentional here.");
    await page.fill(
      'textarea[name="reviewer_prompt"]',
      "Be strict about transaction boundaries in this project."
    );
    await page.click('form:has(textarea[name="conventions"]) button');
    await page.waitForText("Saved.");
    check("the review setup saves", true);

    await page.goto(`${WEB}/p/${SLUG}/settings`);
    await page.waitForText("Review setup");
    check(
      "the saved conventions survive a reload",
      (await page.text()).includes("Direct model use in facades is intentional here.") ||
        (await page.evaluate(
          `return document.querySelector('textarea[name="conventions"]').value`
        )).includes("intentional here")
    );

    const savedPrompt = await page.evaluate(
      `return document.querySelector('textarea[name="reviewer_prompt"]').value`
    );
    check(
      "the project's reviewer prompt survives a reload",
      savedPrompt.includes("transaction boundaries"),
      savedPrompt
    );

    // What the lead wrote reaches the agent, and Smith's contract still follows it.
    const steered = seedReview(key);
    check(
      "the project prompt reaches the agent's instructions",
      steered.instructions.includes("transaction boundaries")
    );
    check(
      "the contract comes after the project's words and still owns the verdict",
      steered.instructions.indexOf("transaction boundaries") <
        steered.instructions.indexOf("## The contract") &&
        steered.instructions.includes("You do not decide the verdict.")
    );

    const disabled = await page.evaluate(`
      return [...document.querySelectorAll('input[name="enabled"]')].filter(i => !i.checked).map(i => i.value);
    `);
    check("a rule switched off stays off", disabled.length > 0, `disabled: ${disabled.join(", ")}`);

    // --- a client overlay composes onto the base ruleset -------------------------------------------
    const settings = await page.text();
    check(
      "the settings screen names the base ruleset and the client overlay apart",
      settings.includes("Client overlay") && settings.includes("the base"),
      settings.slice(settings.indexOf("Review setup"), settings.indexOf("Review setup") + 200)
    );
    const overlay = await page.evaluate(`
      const select = document.querySelector('select[name="overlay"]');
      const option = [...select.options].find((o) => o.value);
      if (!option) return "";
      const setter = Object.getOwnPropertyDescriptor(select.constructor.prototype, "value").set;
      setter.call(select, option.value);
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return option.value;
    `);
    check("the settings screen offers a client overlay to compose", Boolean(overlay), overlay);

    await page.click('form:has(textarea[name="conventions"]) button');
    await page.waitForText("Saved.");
    await page.goto(`${WEB}/p/${SLUG}/settings`);
    await page.waitForText("Review setup");
    check(
      "the chosen overlay survives a reload",
      (await page.evaluate(`return document.querySelector('select[name="overlay"]').value`)) ===
        overlay,
      overlay
    );

    // The proof that matters: the next real review is planned with the composed ruleset.
    const composed = seedReview(key);
    const ruleIds = composed.guidelines.map((g) => g.id);
    check(
      "the overlay's own rule reaches the agent's plan",
      ruleIds.includes("acme-outbound-via-gateway"),
      ruleIds.slice(0, 8).join(", ")
    );
    check(
      "the base rule the overlay switches off does not",
      !ruleIds.includes("no-system-out")
    );

    // --- the catalog on screen, read-only ---------------------------------------------------------
    // The entries are in the database because `bootstrap.py` seeded them, which is also how the
    // production stack gets them. Nothing here writes.
    // Reached the way a lead reaches it, so the navigation link is proven and not only the route.
    await page.goto(`${WEB}/`);
    await page.waitForText("Projects");
    await page.click('a[href="/catalog"]');
    await page.waitForText("Features Smith knows how to build");
    const catalog = await page.text();
    check(
      "the catalog lists the entries a deployment was seeded with",
      catalog.includes("A cost center selector in the B2B checkout"),
      catalog.slice(0, 500)
    );
    check(
      "the catalog page sends a reader to their editor rather than offering to build",
      catalog.includes("ask for it in your editor"),
      catalog.slice(0, 500)
    );
    const catalogControls = await page.evaluate(
      `return document.querySelectorAll("button, input, textarea, select, form").length`
    );
    check("nothing on the catalog list starts anything", catalogControls === 0, `${catalogControls} controls`);
    await auditScreen(page, "catalog");

    await page.click('a[href="/catalog/cost-center"]');
    await page.waitForText("What the agent asks you");
    const entry = await page.text();
    check(
      "an entry shows the questions it will ask the developer",
      entry.includes("Where do this project's cost centers come from"),
      entry.slice(0, 600)
    );
    check(
      "an entry shows the integration facts, named rather than printed as JSON",
      entry.includes("Goes in localextensions.xml") &&
        entry.includes("b2bacceleratorservices") &&
        entry.includes("Written against SAP Commerce 2211"),
      entry.slice(entry.indexOf("Integration"), entry.indexOf("Integration") + 400)
    );
    check(
      "a section this entry has nothing in reads as an answer, not as a gap",
      entry.includes("None"),
      entry.slice(entry.indexOf("Integration"), entry.indexOf("Integration") + 400)
    );
    const entryControls = await page.evaluate(
      `return document.querySelectorAll("button, input, textarea, select, form").length`
    );
    check("nothing on an entry page starts anything", entryControls === 0, `${entryControls} controls`);
    await auditScreen(page, "catalog-entry");

    // The one irreversible control in the product. It is last on purpose: it removes the project
    // every check above just used.
    await page.goto(`${WEB}/p/${SLUG}/settings`);
    await page.waitForText("Delete this project");

    await page.fill('form:has(input[name="confirm"]) input[name="confirm"]', "not-the-slug");
    await page.click('form:has(input[name="confirm"]) button');
    await page.waitForText(`Type ${SLUG} to confirm.`);
    check("a mistyped confirmation does not delete the project", true);

    // The settings screen is still the settings screen, so the refusal refused rather than half-ran.
    check("the project survived the refused delete", (await page.text()).includes("Plugin keys"));

    // No reload between the two submits. A freshly loaded page has not hydrated its form yet, so
    // the click would submit natively and the action would never run.
    await page.fill('form:has(input[name="confirm"]) input[name="confirm"]', SLUG);
    await page.click('form:has(input[name="confirm"]) button');
    await page.waitForText("Projects");
    check("deleting the project lands the lead back on their projects", true);

    const stillListed = (await page.text()).includes(SLUG);
    check("the deleted project is gone from the list", !stillListed);
  } finally {
    await page.close();
    // The happy path deletes the project through the screen, which is the point of the last four
    // checks. This is for every other path: a run that fails at check 3 must not leave a project
    // behind either.
    console.log(`\n${await discardProject()}`);
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`\ne2e failed: ${err.message}`);
  process.exit(1);
});
