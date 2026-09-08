"use strict";

/**
 * Unit checks for the parts of `smith` that can be wrong quietly: argument parsing, credential file
 * permissions, what gets excluded from the payload, and which diff it picks.
 *
 *   node --test plugin/test
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const smith = require("../bin/smith");

// Every command the plugin ships. The shape checks below hold for all of them: one that leaks a
// Claude-only variable or points at a CLI that moved is a command that fails in silence.
const COMMANDS = fs
  .readdirSync(path.join(__dirname, "../commands"))
  .filter((entry) => entry.endsWith(".md"))
  .map((entry) => entry.replace(/\.md$/, ""));

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function initRepo() {
  const root = tempDir("smith-repo-");
  const run = (...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  run("init", "-q", "-b", "main");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "Test");
  fs.writeFileSync(path.join(root, "app.properties"), "solr.host=localhost\n");
  run("add", ".");
  run("commit", "-q", "-m", "initial");
  return { root, run };
}

test("parseArgs separates flags, values and positionals", () => {
  const { flags, positional } = smith.parseArgs(["submit", "42", "--base", "main", "--json"]);
  assert.deepEqual(positional, ["submit", "42"]);
  assert.equal(flags.base, "main");
  // A flag followed by another flag is a boolean, not a value.
  assert.equal(flags.json, true);
});

test("credentials are written user-only", () => {
  const home = tempDir("smith-home-");
  process.env.SMITH_HOME = home;
  delete process.env.SMITH_URL;
  delete process.env.SMITH_KEY;
  try {
    const file = smith.writeConfig({ url: "http://localhost:8099", key: "smk_abc_secret" });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, "config must not be readable by others");
    assert.equal(smith.readConfig().key, "smk_abc_secret");

    // The environment wins, so CI can run without touching the user's file.
    process.env.SMITH_KEY = "smk_env_key";
    assert.equal(smith.readConfig().key, "smk_env_key");
  } finally {
    delete process.env.SMITH_HOME;
    delete process.env.SMITH_KEY;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("uncommitted work is what gets reviewed by default", () => {
  const { root, run } = initRepo();
  try {
    fs.appendFileSync(path.join(root, "app.properties"), "db.password=hunter2\n");
    const uncommitted = smith.collectDiff(root, null);
    assert.equal(uncommitted.spec, "HEAD");
    assert.match(uncommitted.diff, /db\.password=hunter2/);

    // Once committed there is nothing uncommitted left, so it falls back to the branch base.
    run("add", ".");
    run("commit", "-q", "-m", "add password");
    const branch = smith.collectDiff(root, "HEAD~1");
    assert.equal(branch.spec, "HEAD~1...HEAD");
    assert.match(branch.diff, /db\.password=hunter2/);
    assert.deepEqual(
      branch.names.map((n) => n.path),
      ["app.properties"]
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("payload skips deleted, vendored, binary and oversized files", () => {
  const { root } = initRepo();
  try {
    fs.mkdirSync(path.join(root, "node_modules/dep"), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules/dep/index.js"), "module.exports = 1;");
    fs.writeFileSync(path.join(root, "logo.png"), "not really a png");
    fs.writeFileSync(path.join(root, "huge.java"), "x".repeat(smith.MAX_FILE_BYTES + 1));
    fs.writeFileSync(path.join(root, "Kept.java"), "class Kept {}");

    const files = smith.readChangedFiles(root, [
      { status: "M", path: "app.properties" },
      { status: "D", path: "gone.java" },
      { status: "A", path: "node_modules/dep/index.js" },
      { status: "A", path: "logo.png" },
      { status: "A", path: "huge.java" },
      { status: "A", path: "Kept.java" },
    ]);

    assert.deepEqual(
      files.map((f) => f.path).sort(),
      ["Kept.java", "app.properties"],
      "only reviewable source should reach the server"
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const CLI = path.join(__dirname, "../bin/smith");

/**
 * Run the CLI the way a developer's agent does: as a process, with JSON on stdin.
 *
 * Async on purpose. `spawnSync` would block this process's event loop, and the stub server the
 * child talks to lives in this process — nothing would ever answer it.
 */
function runCli(args, { input = "", url = "http://127.0.0.1:1", key = "smk_test", cwd } = {}) {
  const child = require("child_process").spawn("node", [CLI, ...args], {
    cwd,
    env: { ...process.env, SMITH_URL: url, SMITH_KEY: key, SMITH_HOME: tempDir("smith-home-") },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdin.end(input);
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status) => resolve({ stdout, stderr, status }));
  });
}

/** A stand-in server that records the one request it is sent. */
function stubServer(reply) {
  const received = [];
  const server = require("http").createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      received.push({ method: req.method, url: req.url, body: raw ? JSON.parse(raw) : null });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(reply));
    });
  });
  return { server, received };
}

test("responsesFrom accepts both shapes an agent writes and refuses anything else", () => {
  assert.deepEqual(smith.responsesFrom('{"responses": [{"finding": 1, "disposition": "fixed"}]}'), [
    { finding: 1, disposition: "fixed" },
  ]);
  assert.deepEqual(smith.responsesFrom('[{"finding": "abc", "disposition": "dismissed"}]'), [
    { finding: "abc", disposition: "dismissed" },
  ]);
  for (const bad of ["", "   ", "not json", "{}", "[]"]) {
    assert.throws(() => smith.responsesFrom(bad), /stdin is not valid JSON/);
  }
});

test("respond sends the developer's answers and prints the new verdict", async () => {
  const { server, received } = stubServer({ blocking: false, reason: "nothing blocking", counts: {} });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const { stdout, status } = await runCli(["respond", "7"], {
      url,
      input: '{"responses": [{"finding": 2, "disposition": "dismissed", "note": "on purpose"}]}',
    });
    assert.equal(status, 0, "a non-blocking verdict must not fail the command");
    assert.equal(received[0].url, "/v1/reviews/7/respond");
    assert.deepEqual(received[0].body.responses, [
      { finding: 2, disposition: "dismissed", note: "on purpose" },
    ]);
    assert.equal(JSON.parse(stdout).reason, "nothing blocking");
  } finally {
    server.close();
  }
});

test("respond refuses a missing review id and malformed stdin, without touching the server", async () => {
  const noId = await runCli(["respond"], { input: '{"responses": [{"finding": 1}]}' });
  assert.equal(noId.status, 1);
  assert.match(noId.stderr, /usage: smith respond <review_id>/);
  assert.equal(noId.stdout, "");

  // Port 1 is unreachable on purpose: a malformed body must fail before any request is made.
  const badBody = await runCli(["respond", "7"], { input: "half a { json" });
  assert.equal(badBody.status, 1);
  assert.match(badBody.stderr, /stdin is not valid JSON/);
  assert.equal(badBody.stdout, "");
});

test("review re-fetches a review the conversation lost track of", async () => {
  const { server, received } = stubServer({ review_id: 12, findings: [] });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const { stdout, status } = await runCli(["review", "12"], { url });
    assert.equal(status, 0);
    assert.equal(received[0].method, "GET");
    assert.equal(received[0].url, "/v1/reviews/12");
    assert.equal(JSON.parse(stdout).review_id, 12);

    const badId = await runCli(["review", "zero"], { url });
    assert.match(badId.stderr, /usage: smith review <review_id>/);
  } finally {
    server.close();
  }
});

/** Nothing a developer reads should be a stack trace, a JSON blob or an HTTP line. */
function assertReadable(text) {
  assert.doesNotMatch(text, /\bat [\w.]+ \(|node:internal/, "a stack trace reached the developer");
  assert.doesNotMatch(text, /^\s*[{[]/m, "a JSON blob reached the developer");
  assert.doesNotMatch(text, /→ \d{3}|\bstatusCode\b/, "a raw HTTP failure reached the developer");
}

test("status says what is missing when nothing is set up", async () => {
  const { stdout, status } = await runCli(["status"], { url: "", key: "" });
  assert.equal(status, 0, "status is a diagnosis, not a failure");
  assert.match(stdout, /Run: smith auth --url <server> --key <api key>/);
  assert.match(stdout, /No API key yet\./);
  assertReadable(stdout);
});

test("an invalid key is explained, not reported as a status code", async () => {
  const server = require("http").createServer((req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ detail: "invalid API key" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const { stdout, stderr, status } = await runCli(["review", "1"], { url });
    assert.equal(status, 1);
    assert.equal(stdout, "", "a failure must not print half a result");
    assert.equal(
      stderr.trim(),
      "smith: the API key is not valid — it may have been revoked. Ask your project lead for a " +
        `new one, then run: smith auth --url ${url} --key <api key>`
    );
    assertReadable(stderr);
  } finally {
    server.close();
  }
});

test("an unreachable server is named, not stack-traced", async () => {
  const { root } = initRepo();
  try {
    fs.appendFileSync(path.join(root, "app.properties"), "db.password=hunter2 is wrong here\n");
    // Port 1 is closed on every machine this runs on.
    const { stdout, stderr, status } = await runCli(["plan"], { url: "http://127.0.0.1:1", cwd: root });
    assert.equal(status, 1);
    assert.equal(stdout, "");
    assert.equal(stderr.trim(), "smith: nothing is listening at http://127.0.0.1:1");
    assertReadable(stderr);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("every explained failure is one actionable sentence", () => {
  const config = { url: "https://smith.example", key: "k" };
  for (const [code, expected] of [
    [401, /revoked/],
    // 403 and 422 are the server's own refusals, already written for a developer to read.
    [403, /^server words$/],
    [404, /no such review/],
    [422, /^server words$/],
    [500, /check its log/],
  ]) {
    const message = smith.explainHttp(code, { detail: "server words" }, "", "", config);
    assert.match(message, expected);
    assertReadable(message);
  }

  // A 500 carries a reference the server also wrote to its log. Passing it on is what turns
  // "it broke" into something the person running Smith can actually look up.
  const traced = smith.explainHttp(500, { detail: "...", request_id: "9f2c1ab04e77" }, "", "", config);
  assert.match(traced, /check its log for 9f2c1ab04e77$/);
  assertReadable(traced);

  // FastAPI's validation errors are a list, and a proxy's error page is HTML. Neither is prose.
  for (const unreadable of [[{ loc: ["body", "diff"], msg: "field required" }], "<html>502</html>"]) {
    const message = smith.explainHttp(422, { detail: unreadable }, "", "", config);
    assert.match(message, /not in the shape it expected/);
    assertReadable(message);
  }
  for (const [code, expected] of [
    ["ECONNREFUSED", /nothing is listening at https:\/\/smith\.example/],
    ["ENOTFOUND", /cannot resolve the host/],
    ["ECONNRESET", /was cut/],
    ["EPIPE", /could not reach the Smith server/],
  ]) {
    const err = Object.assign(new Error("socket says so"), { code });
    assertReadable(smith.explainNetwork(err, config).message);
    assert.match(smith.explainNetwork(err, config).message, expected);
  }
});

/** A server that refuses the way the real one does: a status and one sentence in `detail`. */
function refusingServer(statusCode, detail) {
  return require("http").createServer((req, res) => {
    res.writeHead(statusCode, { "content-type": "application/json" });
    res.end(JSON.stringify({ detail }));
  });
}

async function withServer(server, run) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

test("a key issued for another project says so, and says who fixes it", async () => {
  await withServer(refusingServer(403, "review belongs to another project"), async (url) => {
    const { stdout, stderr, status } = await runCli(["review", "4"], { url });
    assert.equal(status, 1);
    assert.equal(stdout, "", "a failure must not print half a result");
    assert.equal(
      stderr.trim(),
      "smith: that review belongs to a different project, and an API key only works on its own " +
        "— ask your project lead for a key for this project"
    );
    assertReadable(stderr);
  });
});

test("a change too large to review is refused in the server's own words", async () => {
  const refusal =
    "this change is too large to review in one go (7.5 MB of diff, and the limit is 2.0 MB) " +
    "— review it a commit or a branch at a time";
  const { root } = initRepo();
  try {
    fs.appendFileSync(path.join(root, "app.properties"), "db.password=hunter2 is wrong here\n");
    await withServer(refusingServer(422, refusal), async (url) => {
      const { stdout, stderr, status } = await runCli(["plan"], { url, cwd: root });
      assert.equal(status, 1);
      assert.equal(stdout, "");
      assert.equal(stderr.trim(), `smith: ${refusal}`);
      assertReadable(stderr);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("responding about a finding that is not there names the number, not a status code", async () => {
  await withServer(refusingServer(422, "there is no finding 9 in this review"), async (url) => {
    const { stdout, stderr, status } = await runCli(["respond", "3"], {
      url,
      input: '{"responses": [{"finding": 9, "disposition": "fixed"}]}',
    });
    assert.equal(status, 1);
    assert.equal(stdout, "");
    assert.equal(stderr.trim(), "smith: there is no finding 9 in this review");
    assertReadable(stderr);
  });
});

test("a change not worth reviewing comes back as a skip, not as a failure", async () => {
  const { server, received } = stubServer({
    skipped: true,
    reason: "only documentation or generated files changed: README.md",
  });
  const { root } = initRepo();
  try {
    fs.appendFileSync(path.join(root, "app.properties"), "one more line of real settings here\n");
    await withServer(server, async (url) => {
      const { stdout, stderr, status } = await runCli(["plan"], { url, cwd: root });
      assert.equal(status, 0, "a change not worth reviewing is not a failed command");
      assert.equal(stderr, "");
      const plan = JSON.parse(stdout);
      assert.equal(plan.skipped, true);
      assert.equal(plan.reason, "only documentation or generated files changed: README.md");
      assert.equal(plan.review_id, undefined, "nothing was opened, so there is no review to report");
      assert.equal(received[0].url, "/v1/reviews");
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a change with nothing wrong exits clean, so it cannot read as a failure", async () => {
  const { server, received } = stubServer({
    review_id: 5,
    blocking: false,
    reason: "no blocking findings",
    counts: {},
  });
  await withServer(server, async (url) => {
    const { stdout, stderr, status } = await runCli(["submit", "5"], {
      url,
      input: '{"findings": []}',
    });
    assert.equal(status, 0, "finding nothing is the best outcome and must exit 0");
    assert.equal(stderr, "");
    assert.deepEqual(received[0].body.findings, []);
    assert.equal(JSON.parse(stdout).reason, "no blocking findings");
  });
});

test("the sentences SKILL.md tells the agent to look for are the ones smith prints", () => {
  // The table in the skill is the whole handling of a failure: the agent matches on these phrases.
  // Reword an error without it and the agent silently stops recognising what went wrong.
  const skill = fs.readFileSync(path.join(__dirname, "../commands/smith-review.md"), "utf8");
  const config = { url: "https://smith.example", key: "k" };
  const printed = [
    smith.explainHttp(401, { detail: "invalid API key" }, "", "", config),
    smith.explainHttp(403, { detail: "review belongs to another project" }, "", "", config),
    smith.explainHttp(403, { detail: "only a project lead can accept a finding" }, "", "", config),
    smith.explainNetwork(Object.assign(new Error("refused"), { code: "ECONNREFUSED" }), config)
      .message,
  ];
  for (const phrase of [
    "nothing is listening at",
    "may have been revoked",
    "belongs to a different project",
    "only a project lead",
  ]) {
    assert.ok(skill.includes(phrase), `smith-review.md no longer names "${phrase}"`);
    assert.ok(
      printed.some((message) => message.includes(phrase)),
      `smith no longer prints "${phrase}"`
    );
  }
});

test("the command teaches the agent no vocabulary the developer would have to learn", () => {
  // The agent says back whatever words the skill uses. A word in backticks is a wire field it reads;
  // the same word in prose is a word it repeats at someone who has never heard of this product.
  const skill = fs.readFileSync(path.join(__dirname, "../commands/smith-review.md"), "utf8");
  // Everything up to "## Never": that closing section names these words in order to forbid them.
  const prose = skill
    .slice(0, skill.indexOf("## Never"))
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`\n]*`/g, "");
  assert.ok(skill.includes("## Never"), "the command lost the section that forbids our vocabulary");
  for (const word of ["disposition", "fingerprint", "suppress", "scoped"]) {
    const found = prose.split("\n").find((line) => line.toLowerCase().includes(word));
    assert.equal(found, undefined, `SKILL.md explains "${word}" in prose: ${found}`);
  }
});

test("the platform version comes from the repository's manifest, or is left unanswered", () => {
  const { root, run } = initRepo();
  try {
    assert.equal(smith.platformVersion(root), "", "no manifest means no claim about the version");

    fs.mkdirSync(path.join(root, "core-customize"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "core-customize/manifest.json"),
      JSON.stringify({ commerceSuiteVersion: "2211.28", useConfig: {} })
    );
    run("add", ".");
    assert.equal(smith.platformVersion(root), "2211.28");

    // A manifest that is not a Commerce manifest says nothing, and must not throw.
    fs.writeFileSync(path.join(root, "core-customize/manifest.json"), '{"name": "something else"}');
    assert.equal(smith.platformVersion(root), "");
    fs.writeFileSync(path.join(root, "core-customize/manifest.json"), "not json at all");
    assert.equal(smith.platformVersion(root), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a rename reports the new path, not the old one", () => {
  const { root, run } = initRepo();
  try {
    run("mv", "app.properties", "renamed.properties");
    const names = smith.nameStatus(root, ["diff", "--name-status", "--cached", "-M", "HEAD"]);
    assert.equal(names.length, 1);
    assert.equal(names[0].path, "renamed.properties");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Cursor's plugin loader rejects a non-kebab-case name and reads only these two manifests. It fails
// silently, so a drifting name would uninstall the plugin from Cursor without anyone noticing.
test("both editor manifests agree and carry a name Cursor's loader accepts", () => {
  const pluginRoot = path.join(__dirname, "..");
  const manifests = [".claude-plugin/plugin.json", ".cursor-plugin/plugin.json"].map((relative) =>
    JSON.parse(fs.readFileSync(path.join(pluginRoot, relative), "utf8")),
  );

  for (const manifest of manifests) {
    assert.match(manifest.name, /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/);
    assert.deepEqual(manifest, manifests[0]);
  }

  // No `commands` key, so both editors fall back to scanning this directory.
  assert.ok(!("commands" in manifests[0]));
  assert.ok(fs.existsSync(path.join(pluginRoot, "commands/smith-review.md")));

  // The plugin must volunteer nothing. A skills/ directory puts an entry in Cursor's "Agent
  // Decides" list, which is how this plugin used to answer developers who never asked for it.
  assert.ok(!fs.existsSync(path.join(pluginRoot, "skills")), "skills/ is back: the plugin would auto-fire again");
});

test("catalog lists the entries, and one id fetches that entry in full", async () => {
  const { server, received } = stubServer({ entries: [{ id: "cost-center", title: "t", about: "a" }] });
  await withServer(server, async (url) => {
    const listed = await runCli(["catalog"], { url });
    assert.equal(listed.status, 0);
    assert.equal(received[0].url, "/v1/catalog");
    assert.deepEqual(JSON.parse(listed.stdout).entries[0].id, "cost-center");

    const one = await runCli(["catalog", "cost-center"], { url });
    assert.equal(one.status, 0);
    assert.equal(received[1].url, "/v1/catalog/cost-center");
    assert.equal(received[1].method, "GET");
  });
});

// An id reaches the CLI from a model, so it is untrusted input that ends up in a URL path. A
// slash in it must stay part of the id rather than addressing a different endpoint.
test("an id carrying a path separator addresses the entry, not another endpoint", async () => {
  const { server, received } = stubServer({ id: "x", title: "t", about: "a", detail: {} });
  await withServer(server, async (url) => {
    await runCli(["catalog", "../reviews/7"], { url });
    assert.equal(received[0].url, "/v1/catalog/..%2Freviews%2F7");
  });
});

// The 404 a developer's agent actually reaches: an id it remembered instead of read. Telling it
// there is no such review sends it looking in the wrong half of the product.
test("an unknown entry says to read the catalog again, not that a review is missing", async () => {
  await withServer(refusingServer(404, "no such catalog entry"), async (url) => {
    const { stdout, stderr, status } = await runCli(["catalog", "no-such-entry"], { url });
    assert.equal(status, 1);
    assert.equal(stdout, "");
    assert.equal(
      stderr.trim(),
      "smith: there is no catalog entry with that id — list the catalog and pick one from it"
    );
    assertReadable(stderr);
  });
  // The wording is the catalog's own: a missing review still reads as a missing review.
  const config = { url: "https://smith.example", key: "smk_x" };
  assert.match(smith.explainHttp(404, null, "", "", config, "/v1/reviews/7"), /no such review/);
});

// A command is reached by being typed, so its frontmatter `name` is the whole handle.
function frontmatterOf(name) {
  const command = fs.readFileSync(path.join(__dirname, `../commands/${name}.md`), "utf8");
  const frontmatter = command.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(frontmatter, `${name}.md must open with frontmatter`);
  const declared = frontmatter[1].match(/^name:\s*(.+)$/m);
  const description = frontmatter[1].match(/^description:\s*(.+)$/m);
  assert.ok(declared, `${name} frontmatter must carry a name`);
  assert.ok(description, `${name} frontmatter must carry a description`);
  return { name: declared[1].trim(), description: description[1].trim() };
}

test("every command is named for the plugin, so a developer types one door", () => {
  // The collision that started this: Cursor ships its own /review, and a command called `review`
  // never reaches this plugin. Every name carries the prefix, and the file name is the name.
  for (const file of COMMANDS) {
    const { name } = frontmatterOf(file);
    assert.equal(name, file, `${file}.md declares a different name than its file`);
    assert.match(name, /^smith-/, `${file} does not carry the smith- prefix`);
  }

  assert.ok(COMMANDS.includes("smith-review"));
  assert.ok(COMMANDS.includes("smith-apply"));

  // A description that reads like a skill's — "use when the user mentions..." — is how this plugin
  // got into ordinary conversations.
  for (const file of COMMANDS) {
    const { description } = frontmatterOf(file);
    assert.doesNotMatch(description, /\bUse when\b/i, `${file} reads like an auto-selected skill`);
  }
});

// Cursor expands no plugin-root variable and puts nothing on PATH, so the README line is the only
// thing standing between a Cursor developer and a broken command. Run it the way they would.
test("the install line in README puts a smith on PATH that answers", () => {
  const repoRoot = path.join(__dirname, "../..");
  const readme = fs.readFileSync(path.join(__dirname, "../README.md"), "utf8");
  // Anchored on the heading text, not its level: the section has moved up and down the outline
  // more than once, and the test is about the command underneath it.
  const documented = readme.match(/#+ Put `smith` on PATH[\s\S]*?```bash\n([\s\S]*?)```/);
  assert.ok(documented, "README no longer documents how to reach the CLI");
  const install = documented[1].trim();

  const home = tempDir("smith-install-");
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  // The line installs next to node, so a throwaway node is what makes this hermetic.
  fs.symlinkSync(process.execPath, path.join(bin, "node"));
  const clean = { HOME: home, PATH: `${bin}:/usr/bin:/bin`, SMITH_HOME: path.join(home, ".smith") };

  try {
    execFileSync("/bin/sh", ["-c", install], { cwd: repoRoot, env: clean });
    const answer = execFileSync("/bin/sh", ["-c", "smith status"], { cwd: home, env: clean });
    assert.match(String(answer), /No server yet/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// `${CLAUDE_PLUGIN_ROOT}` expands to nothing in Cursor, so a Claude-only variable in the skill is a
// command the agent runs against a path that starts at the filesystem root.
test("no command names a variable only one editor defines", () => {
  for (const name of COMMANDS) {
    const skill = fs.readFileSync(path.join(__dirname, `../commands/${name}.md`), "utf8");
    assert.doesNotMatch(skill, /CLAUDE_[A-Z_]+/);
    for (const editor of ["Claude Code", "Cursor"]) {
      assert.ok(skill.includes(editor), `${name} does not say how to reach the CLI in ${editor}`);
    }
  }
});

// Cursor puts nothing on PATH, so this sentence in the skill is the only thing that gets a Cursor
// agent to the CLI. Move `bin/` or nest the skill one level deeper and the skill goes stale in
// silence: the agent would run a path that does not exist and report the server as unreachable.
test("the CLI is where every command tells the agent to look for it", () => {
  for (const name of COMMANDS) {
    const skill = fs.readFileSync(path.join(__dirname, `../commands/${name}.md`), "utf8");
    assert.match(skill, /one level\s+above this file/, `${name} does not point at the CLI`);
  }

  const pluginRoot = path.join(__dirname, "..");
  for (const directory of ["bin", "commands"]) {
    assert.ok(fs.existsSync(path.join(pluginRoot, directory)), `${directory}/ is not one level up`);
  }

  const home = tempDir("smith-plugin-relative-");
  try {
    const answer = execFileSync(process.execPath, [path.join(pluginRoot, "bin/smith"), "status"], {
      env: { HOME: home, PATH: "/usr/bin:/bin", SMITH_HOME: path.join(home, ".smith") },
    });
    assert.match(String(answer), /No server yet/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// Measured on 2026-08-21 in a real Cursor session: the skill called the closing line "not
// optional", so a review that hid nothing still closed with "Not shown: none ruled out." — a
// sentence about the absence of a thing the developer was never told about. The agent has nothing
// to go on but this document, so the condition has to be written down.
test("the line naming what was hidden is conditional on something being hidden", () => {
  const skill = fs.readFileSync(path.join(__dirname, "../commands/smith-review.md"), "utf8");
  assert.doesNotMatch(skill, /not optional/i);
  assert.match(skill, /empty[\s\S]{0,80}no closing line/i);
});

// Measured on 2026-08-21: the skill used to tell the agent to recommend the PATH install line, and
// a Cursor agent duly closed a "Clear. Nothing to fix." verdict with a shell command to run. The
// review had already worked without it, so the advice cost the developer a step and bought nothing.
test("no command sends the developer off to install something", () => {
  for (const name of COMMANDS) {
    const skill = fs.readFileSync(path.join(__dirname, `../commands/${name}.md`), "utf8");
    assert.doesNotMatch(skill, /ln -s/);
    assert.doesNotMatch(skill, /install line/i);
    assert.ok(skill.includes("never suggest installing anything"), `${name} may send them to install`);
  }
});

// Measured on 2026-08-21, in a real Cursor session: `smith plan` answered "nothing is listening at
// http://localhost:8099" while curl reached the same URL. Cursor's agent shell runs Node 18, which
// tries only the first address `localhost` resolves to — `::1` on macOS — while the server listens
// on 127.0.0.1. The flags below reproduce that on Node 20+, where the fallback is on by default:
// the request carries its own `autoSelectFamily`, so it survives a runtime whose default is off.
test("a server on localhost is reached whichever address family resolves first", async () => {
  const server = stubServer({ ok: true }).server;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const home = tempDir("smith-family-");
    const child = require("child_process").spawn("node", [CLI, "status"], {
      env: {
        ...process.env,
        NODE_OPTIONS: "--dns-result-order=ipv6first --no-network-family-autoselection",
        SMITH_URL: `http://localhost:${port}`,
        SMITH_KEY: "smk_test",
        SMITH_HOME: home,
      },
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stdout += chunk));
    await new Promise((resolve) => child.on("close", resolve));
    assert.match(stdout, /The server answered/);
    fs.rmSync(home, { recursive: true, force: true });
  } finally {
    server.close();
  }
});

test("submit quotes the line each finding points at, and never reads outside the repository", async () => {
  const { root } = initRepo();
  fs.writeFileSync(
    path.join(root, "Totals.java"),
    "class Totals {\n  int total = 0;\n  int tax = 0;\n}\n"
  );
  // Written beside the repository, not in it: a finding pointing here must be submitted unquoted.
  const outside = path.join(root, "..", `smith-outside-${path.basename(root)}.txt`);
  fs.writeFileSync(outside, "a credential the plugin must never read\n");

  const { server, received } = stubServer({ blocking: false, reason: "ok", counts: {} });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const findings = [
      { file: "Totals.java", line: 2, message: "total is always zero" },
      { file: "Totals.java", line: 3, message: "tax is always zero" },
      { file: "Totals.java", line: 99, message: "past the end of the file" },
      { file: "does/not/exist.java", line: 1, message: "the file is gone" },
      { file: `../${path.basename(outside)}`, line: 1, message: "outside the repository" },
      { file: "Totals.java", message: "no line at all" },
    ];
    const inRepo = await runCli(["submit", "5"], { url, cwd: root, input: JSON.stringify({ findings }) });
    assert.equal(inRepo.status, 0, inRepo.stderr);

    const sent = received[0].body.findings;
    assert.equal(sent.length, findings.length, "every finding is submitted, quoted or not");
    assert.equal(sent[0].quoted_line, "int total = 0;");
    assert.equal(sent[1].quoted_line, "int tax = 0;");
    assert.notEqual(sent[0].quoted_line, sent[1].quoted_line, "two lines, two identities");
    for (const unquotable of sent.slice(2)) {
      assert.equal(unquotable.quoted_line, undefined, `${unquotable.file} must not be quoted`);
    }
    assert.equal(
      fs.readFileSync(outside, "utf8").includes("credential"),
      true,
      "the file outside the repository is untouched"
    );

    // Quoting is a bonus, never a precondition: submitting from outside a repository still works.
    const noRepo = await runCli(["submit", "5"], {
      url,
      cwd: tempDir("smith-not-a-repo-"),
      input: JSON.stringify({ findings: [findings[0]] }),
    });
    assert.equal(noRepo.status, 0, noRepo.stderr);
    assert.deepEqual(received[1].body.findings, [findings[0]]);
  } finally {
    server.close();
    fs.rmSync(outside, { force: true });
  }
});

// --------------------------------------------------------------------------------------------
// AA2 / AA3 — what the review is compared against, and what it is called
// --------------------------------------------------------------------------------------------

/** A repository with a real remote on disk, so `ls-remote` answers without a network. */
function repoWithRemote() {
  const remote = tempDir("smith-remote-");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote], { stdio: "ignore" });
  const { root, run } = initRepo();
  run("remote", "add", "origin", remote);
  run("push", "-q", "-u", "origin", "main");
  return { root, run, remote };
}

test("the base is the branch's own upstream, not a guess", () => {
  const { root, run } = repoWithRemote();
  try {
    // A developer who branched from `develop` must not be reviewed against `main`. The old list
    // walked origin/main first and would have compared them to it.
    run("checkout", "-q", "-b", "develop");
    run("push", "-q", "-u", "origin", "develop");
    run("checkout", "-q", "-b", "feature");
    run("push", "-q", "-u", "origin", "feature");
    execFileSync("git", ["branch", "--set-upstream-to=origin/develop"], { cwd: root, stdio: "ignore" });
    assert.equal(smith.defaultBase(root), "origin/develop");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a base the remote has moved past is reported stale, with how far", () => {
  const { root, run, remote } = repoWithRemote();
  const other = tempDir("smith-other-");
  try {
    // Somebody else pushes two commits. This machine never fetches, so `origin/main` here is two
    // behind — which is exactly the state that made a review carry other people's work.
    execFileSync("git", ["clone", "-q", remote, other], { stdio: "ignore" });
    const there = (...args) => execFileSync("git", args, { cwd: other, stdio: "ignore" });
    there("config", "user.email", "other@example.com");
    there("config", "user.name", "Other");
    for (const n of [1, 2]) {
      fs.writeFileSync(path.join(other, `theirs-${n}.txt`), "x\n");
      there("add", ".");
      there("commit", "-q", "-m", `theirs ${n}`);
    }
    there("push", "-q", "origin", "main");

    const stale = smith.baseFreshness(root, "origin/main");
    assert.equal(stale.state, "stale");
    assert.equal(stale.remote, "origin");

    run("fetch", "-q", "origin");
    assert.equal(smith.baseFreshness(root, "origin/main").state, "current");
  } finally {
    for (const dir of [root, other, remote]) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an unreachable remote is unknown, never a failure", () => {
  const { root, run } = initRepo();
  try {
    // A remote that cannot be contacted must not stop a review. The developer is told the base may
    // be stale; they are not refused.
    run("remote", "add", "origin", path.join(root, "does-not-exist.git"));
    const answer = smith.baseFreshness(root, "origin/main");
    assert.equal(answer.state, "unknown");
    // And a ref with no remote behind it is local, not unknown: there is nothing to be stale about.
    assert.equal(smith.baseFreshness(root, "main").state, "local");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the ticket comes off the branch, then off the branch's own commits", () => {
  const { root, run } = initRepo();
  try {
    run("checkout", "-q", "-b", "feature/ABC-123-add-a-thing");
    assert.equal(smith.ticketFromRepository(root, "main"), "ABC-123");

    run("checkout", "-q", "-b", "no-ticket-here");
    fs.writeFileSync(path.join(root, "x.txt"), "x\n");
    run("add", ".");
    run("commit", "-q", "-m", "DEF-9 make it work");
    assert.equal(smith.ticketFromRepository(root, "main"), "DEF-9");

    // Nothing to find is empty, not a guess. A review titled with a number that is not a ticket is
    // worse than an untitled one.
    run("checkout", "-q", "-b", "plain");
    fs.writeFileSync(path.join(root, "y.txt"), "y\n");
    run("add", ".");
    run("commit", "-q", "-m", "tidy up");
    assert.equal(smith.ticketFromRepository(root, "no-ticket-here"), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("preview says what would be reviewed and creates nothing", () => {
  const { root, run } = initRepo();
  try {
    // The branch case is the one worth confirming with a developer, and `plan` cannot be used to
    // look: calling it opens a review. Preview answers the same question with no server and no key.
    run("checkout", "-q", "-b", "feature/ABC-77-thing");
    fs.writeFileSync(path.join(root, "b.txt"), "b\n");
    run("add", ".");
    run("commit", "-q", "-m", "work");

    const branch = smith.previewOf(root, null);
    assert.equal(branch.kind, "branch");
    assert.equal(branch.base, "main");
    assert.equal(branch.ticket, "ABC-77");
    assert.equal(branch.empty, false);
    assert.equal(branch.branch, "feature/ABC-77-thing");

    // Uncommitted work wins, and that case is not worth a question.
    fs.writeFileSync(path.join(root, "b.txt"), "changed\n");
    assert.equal(smith.previewOf(root, null).kind, "uncommitted");

    // Nothing to review is said here rather than discovered after a review row exists.
    run("checkout", "-q", "--", ".");
    run("checkout", "-q", "main");
    assert.equal(smith.previewOf(root, null).empty, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A plugin installed from a repository is pinned to the commit it was added at, and Cursor never
// says so. A developer who deleted their cache to force an update landed on the first commit in the
// repository with the review command gone. `smith update` is the only thing that tells them, so
// what it says has to be right in all three states without a network to reach.
test("update names both commits when behind, one line when current, and neither when unreachable", () => {
  const installed = "8a1262f6e4f552a386514430c89aaa63332f72f5";
  const current = "7d91ee955677d79ddd1c61674649d8fff08661e5";

  const behind = smith.updateReport({ installed, current, version: "0.1.0", ahead: 47 });
  assert.match(behind, /8a1262f/);
  assert.match(behind, /7d91ee9/);
  assert.match(behind, /47 commits/);
  // The steps are in the only order that works: the marketplace index moves first, the interactive
  // reinstall moves the copy the agent actually loads.
  assert.ok(
    behind.indexOf("marketplace remove") < behind.indexOf("marketplace add"),
    "remove has to come before add",
  );
  assert.ok(behind.indexOf("marketplace add") < behind.indexOf("/plugins"), "the reinstall comes last");
  assert.match(behind, /--git-ref main/, "without a ref, add can restore the pin they already had");

  const up = smith.updateReport({ installed: current, current, version: "0.3.0", ahead: null });
  assert.equal(up, "Smith is current: 0.3.0 (7d91ee9).");

  // Offline must not read as current, and must not read as an error either.
  const unknown = smith.updateReport({ installed, current: null, version: "0.1.0", ahead: null });
  assert.match(unknown, /Could not reach/);
  assert.doesNotMatch(unknown, /current:/);
  assert.doesNotMatch(unknown, /marketplace/, "nothing to do until it is known there is something to do");

  // A count the forge would not give is a missing sentence, not a missing report.
  const noCount = smith.updateReport({ installed, current, version: "0.1.0", ahead: null });
  assert.match(noCount, /Current is 7d91ee9\./);
});

// The sha comes from the install path rather than from a constant, because the copy that is out of
// date is exactly the copy whose constant was never bumped.
test("update reads its own commit from where it is installed, not from a constant", async () => {
  const cache = tempDir("smith-cache-");
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const installed = path.join(cache, "smith/smith", sha);
  fs.mkdirSync(path.join(installed, "bin"), { recursive: true });
  fs.copyFileSync(CLI, path.join(installed, "bin/smith"));
  fs.writeFileSync(path.join(installed, "plugin.json"), JSON.stringify({ version: "9.9.9" }));

  try {
    const child = require("child_process").spawnSync("node", [path.join(installed, "bin/smith"), "update"], {
      encoding: "utf8",
      // No remote reachable, so this exercises the path that only reads the install itself.
      env: { ...process.env, GIT_ALLOW_PROTOCOL: "none" },
    });
    assert.equal(child.status, 0);
    assert.match(child.stdout, /9\.9\.9 \(0123456\)/);
  } finally {
    fs.rmSync(cache, { recursive: true, force: true });
  }
});
