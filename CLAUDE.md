# Smith — working agreement

Plugin-first code review. Read `README.md` for what it does; this file is how to change it.

## Working unsupervised

Much of this backlog is worked by an agent running on a loop, with nobody watching. If that is you:

**Start every iteration with `scripts/ensure_db.sh`.** Postgres is the database this product runs
on and it is expected to be up; the script exists because the podman VM does not restart itself
after a reboot, not because postgres is unreliable. It is a no-op when things are already running
and takes ~11 seconds from a cold VM.

If it fails, **retry it once** before concluding anything, and read its message — it names what it
could not start. Only if it fails twice: work a task that genuinely needs no database (phase D is
entirely doable on sqlite), and record `[!] postgres unavailable: <the script's message>` against
the tasks you skipped so Monday starts with a real diagnosis. Never mark a postgres-dependent task
`[x]` on the strength of sqlite alone.

**Pick exactly one task.** The first `[ ]` in `tasks.md`, top to bottom. Finish it completely before
looking at the next one. Half of two tasks is worth less than one whole one, and it is worth less
than nothing when the next iteration has to work out where you stopped.

**Never ask a question.** There is no one to answer it. When something is ambiguous, take the
simplest option that satisfies the task's acceptance criteria, write one line in the *Notes and
decisions log* at the bottom of `tasks.md` saying what you chose and why, and keep going. A blocked
task with a question in it is a wasted iteration.

**Done means all of this, every time:**

```bash
uv run pytest                                   # green
node --test plugin/test                         # green
cd web && npx next build                        # green, if web/ was touched

# and, whenever a rule, an analyzer or the reviewer's domain changed — that is the review's output,
# even though no screen moved, so read one for yourself before calling it done:
node scripts/rehearse.mjs                       # green, with the API up

# and, whenever web/ or the plugin conversation changed — you run this yourself, in a real browser:
nvm use 22
uv run uvicorn smith.main:app --port 8099 &     # API
(cd web && SMITH_API_URL=http://localhost:8099 npx next start &)
node scripts/e2e_browser.mjs                    # green, then kill both
```

then mark the task `[x]` with the commit sha and commit.

**Testing is your job, all of it.** Nobody is going to click through a screen, drive the plugin or
judge whether an error message is useful. You have a real browser (`scripts/cdp.mjs`), the real CLI
(`plugin/bin/smith`), a real database, and a real SAP Commerce corpus to measure against when
`SMITH_CORPUS` points at one. A feature you have not exercised is not finished, and "I could not
test this" is only acceptable when you write down what stopped you.

Two things you must never do, because both turn a red signal green while the product stays broken:
invent a test result you did not observe, and loosen an assertion so a failing check passes. If a
measurement comes out worse than the task expected, that is the finding — record the number.

**You run the functional tests yourself.** `scripts/cdp.mjs` drives real Chrome over the DevTools
Protocol, so there is no excuse to hand a UI change to a human to click through. If your task adds
something a developer or a lead touches, add its assertions to `scripts/e2e_browser.mjs` in the same
task. A screen that no browser has exercised is not finished.

Two traps that will cost you an hour each: `scripts/e2e_browser.mjs` needs **Node 22** (Node 20 has
no global `WebSocket`), while `next` needs Node 20 or 22 — switch with `nvm use`. And selectors must
be specific: `form button` on the projects page hits *Sign out*, and `input[name="email"]` on the
settings page hits a hidden field in a Remove form. Prefer `form:has(...)` and attribute selectors
that only the intended element satisfies. A task is not done because the code is
written. It is done when the checks pass and the work is committed.

**Committing is part of the task, not a favour to your future self.** One commit per task, straight
to main, message naming the task id.

**The remote is public.** `origin` is `github.com/sebospc/ai-apps`, and anyone can read it. Commit
freely; push only when asked. What must never reach a commit is anything that identifies a client:
their name, their file paths, their class names, the defects found in their code. That is not a
style preference — the measurements this repository lives on are taken against a real client
checkout, and the artifacts they produce (`tests/data/*-baseline.jsonl`, the audits under `output/`)
name paths in it. They are gitignored and they stay that way. Before adding a file that came out of
a measurement, read it and ask whose code it describes.

**When you get stuck**: try twice. If it still fails, revert your working-tree changes for that task
(`git checkout -- .`), mark it `[!]` with one sentence on what blocked you, and move to the next
task. Never commit a broken tree. Never leave the suite red for the next iteration to discover.

**Do not**: drop or recreate the postgres volume; delete anything outside this repository; weaken or
delete a test to make it pass; add a dependency where a few lines of standard library would do;
start work not in `tasks.md`. If you believe a task is wrong, do it as written and say so in the
notes log — the person reading on Monday can judge.

**Kill every process you start.** No orphan uvicorn, next or podman processes at the end of an
iteration.

Node is the one environment trap: the system default is 18 and Next 16 refuses it. Use
`export PATH="$HOME/.nvm/versions/node/v20.18.1/bin:$PATH"`.

## The two products

Two tools for SAP Commerce, one plugin surface. **Reviewer checks code that is already written.
Pergamon helps write new code from something that already works.** Only Reviewer exists; Pergamon
is described here so that what is built for one does not quietly make the other impossible.

**Reviewer** gives a company one engineering baseline across projects, without replacing what a
team already decided. Rules come in two layers — a base shared everywhere, a per-project overlay —
and a lead edits both. What makes it worth having over a generic analyzer is that it knows the
framework: Spring wiring, ImpEx, `items.xml`, item types, extensions, Spartacus. That knowledge is
what finds architectural problems, and it is also what keeps it quiet, because a rule written for a
framework fires where the framework is and nowhere else.

**Pergamon** is an implementation catalog. The same feature gets built many times, by different
developers, in a different way each time; Pergamon keeps one generalized implementation and applies
it to a project. It reads the project on its own — extensions, item types, existing files, where the
new code connects — and asks only what the code cannot tell it. Client code, names and business
logic never reach the catalog; only the engineering pattern does, and promoting one is a person's
job, never automatic. Two decisions are already made: a delivery is **not** frozen, because the
session continues and the developer keeps shaping the output, and git is the record of what was
delivered rather than Pergamon. The loop the two should eventually close is Pergamon → pull request
→ Reviewer.

They share identity and a deployment. That is why they are one repository with separate bounded
contexts rather than separate repositories: the seam that matters is a context that could get its
own `main.py`, not a second git remote.

## The four decisions

These were chosen deliberately after the previous version collapsed under its own weight. Do not
reopen them without being asked.

1. **The server has no LLM.** Reasoning happens in the developer's editor, on their model and their
   tokens. No API keys, no cost tracking, no model selection here — ever.
2. **The server never touches git.** The plugin sends a diff and the changed files. No clone, no git
   credentials, no webhooks, no polling a forge.
3. **The server owns the verdict.** Computed from the project's policy in `domain/verdict.py`. A
   language model contributes findings; it never decides whether a review blocks.
4. **Port on demand.** The old reviewer had 32 domain services. Six were carried over. Adding one
   back requires a real case that needs it, not a hunch that it might be useful.

## Architecture

Hexagonal, and it is enforced, not aspirational:

- `domain/` is pure. No SQLAlchemy, no FastAPI, no `open()`, no `subprocess`, no `datetime.now()`.
  If a domain module needs one of those, the design is wrong — pass the value in.
- `ports.py` declares what a context needs as `Protocol`s. Services depend only on ports.
- `adapters/` implement ports. An adapter never constructs another adapter.
- `container.py` is the **only** module that constructs adapters. Scripts are composition roots too,
  so they may build adapters directly; nothing else may.
- `auth` and `reviewer` never import each other's adapters. `reviewer` reads project config through
  its own port, which happens to be backed by the identity context's table.

The test for whether a seam is real: could this context be moved to its own process by giving it its
own `main.py` and nothing else? If not, the seam is fake.

## Conventions

- **English only**, everywhere: code, identifiers, comments, docstrings, commit messages, error
  messages, test names, the backlog, and every string a user ever sees. This holds *regardless of
  the language you were asked in* — instructions arrive in Spanish, the repository stays English.
  A Spanish string in the UI is a bug, and so is a Spanish comment.
- Comments explain *why*, never *what*. A comment restating the line below it is deleted.
- A deliberate shortcut is marked `# ponytail: <what> ; <upgrade path>` so it reads as a decision.
- Config a lead can change lives in `projects.config` (JSON, edited from the UI). `.env` holds
  infrastructure and secrets only — never product configuration.
- Type hints everywhere. `from __future__ import annotations` at the top.

## Product doctrine

`tasks.md` opens with the product decisions — finding fingerprints, dispositions, how a developer
argues with a review, when a review is not worth opening. They are settled. Implement them; do not
redesign them mid-task.

The bar for anything a developer touches: **it must be obvious without being explained.** The
developer says "3 is wrong, we do that on purpose" and the tool understands. They never type an id,
never see a fingerprint, never run a command themselves, never read JSON. Anything that asks a
developer to learn Smith's vocabulary is a design failure, not a documentation gap.

Precision over recall in every deterministic rule. A rule that cries wolf costs more than the bug it
would have caught, because it takes the credibility of every other rule with it. No rule ships
without a fixture proving it fires and a fixture proving it stays quiet.

**Deleting a noisy rule beats adding a careful one.** Five phases of this backlog deleted more rules
than they added and every measured number improved. When a reading says a rule is right 1 time in
14, that is the finding; write the reading down and let the rule die. A quiet case that cannot be
named is a rule that does not ship.

Four things learned by shipping, each one a defect that reached the database before it was noticed:

- **A finding's identity is the rule, the file and the line's content.** Anything that hands the
  server an empty half makes two findings one, and one disposition silently answers both. Whoever
  produces a finding fills the content.
- **Guards belong at the boundary, not in each rule.** Redaction lived in the one rule that looks
  for secrets, so a credential reached storage through whichever check pointed at the line second.
  A rule author should not have to remember; put it where every finding passes.
- **Two refusals must be indistinguishable in the message, not only in the status code.** A test
  comparing `403 == 403` passed for months while a non-member could tell an existing project from an
  imaginary one by reading the sentence. Compare what the user sees.
- **What the product records, a lead must be able to remove.** Every `quoted_line` is a line of
  somebody's source. Storage without an exit is fine on a laptop and an obligation on a server.

**Say what you have, not what you wish you had.** The reason a developer gives is written by their
agent, so the screen says "Reason recorded", not a colon and their words in quotation shape. The
same rule applies to every sentence with a person's name on it.

## Adding things

Every rule, of either kind, ships with two fixtures under `rules/fixtures/<case>/` — `diff`,
optional `files/`, and `expected.json` — one where it fires and one of ordinary code where nothing
does. `uv run pytest -k fixtures` runs them all; an empty `expected.json` fails on any finding at
all. A rule added without them has no evidence it is precise, which is the only thing that makes it
worth shipping.

**A regex rule** — a `checks:` entry in a `rules/*.yaml` ruleset. No code.

**A rule a regex cannot express** — a function in `reviewer/domain/rules.py`:

```python
@rule("my-rule", emits=("my-rule",))
def my_rule(ctx: RuleContext) -> list[Finding]:
    ...
```

`emits` is the rule_ids its findings carry, which is not the registry key — `properties-hygiene`
emits two. It is what lets the suite check every id has a fixture behind it, so a wrong `emits`
fails the build rather than hiding a rule.

Pure, and it must not raise: `run_rules` logs and skips a rule that throws, so a broken rule
degrades the review instead of failing it. Same contract for analyzers — a missing binary returns
`[]`.

**An endpoint** — the plugin surface is deliberately three calls. Adding a fourth needs a reason
that survives the question "what breaks for a developer if this doesn't exist?"

## Who can do what

Two roles, scoped to a project. There is no org-wide admin and none is needed.

| | dev | lead |
|---|---|---|
| Run reviews with a key | yes | yes |
| Read the project's review setup | yes | yes |
| Change rules, policy, conventions | no | yes |
| Add / remove members, change roles | no | yes |
| Issue and revoke keys | no | yes |
| Create a project | yes — and becomes its lead | — |

Rules that hold everywhere:

- **A key is bound to a person, not to whoever created it.** A lead issues a developer's key with
  `for_email`, so reviews are attributed to the developer. Getting this wrong makes "see what each
  developer did" a lie, which is the product.
- **Developers have no password.** Their account carries `UNUSABLE_PASSWORD`; login rejects it with
  the same error as any other failure. They use the plugin, never the UI — that was the point.
- **A project always keeps at least one lead.** Removing or demoting the last one is refused.
- **Non-membership and non-existence look identical** (403 `unknown project`). Membership must not
  become a way to enumerate which projects exist.
- Still undecided, needed when review-reading endpoints land in phase 4: a lead sees every review in
  their project, a developer sees only their own.

## The plugin

`plugin/` is the whole client surface. It ships a skill and one Node script — **no hooks, no status
line, no background monitors, no state files**. The previous version wired a status-line badge and a
`UserPromptSubmit` hook; a stale flag file left a review permanently pinned in the user's status
line and the plugin had to be uninstalled. Nothing in this plugin may run between reviews. If a
feature seems to need one, it does not.

`bin/smith` uses the Node standard library only. Adding a dependency means every user needs an
install step; a few lines of `http`/`child_process` do not.

## The web UI

`web/` is Next.js with exactly five dependencies: next, react, react-dom, tailwindcss, typescript.
Observatory's stack (react-query, radix, shadcn, recharts, zod, sonner, next-themes…) was
deliberately not carried over — four read-mostly screens do not need it.

The state model is: **there is no client state**. Pages are Server Components that fetch through
`lib/api.ts` with the session cookie forwarded; mutations are Server Actions that call the API and
`revalidatePath`. Never introduce a client-side data cache, a store, or a fetch from the browser to
the API — the browser must never hold a credential or a second copy of the truth.

The UI hiding a control is cosmetic. Authorisation lives in the API and is tested there.

## Testing

The suite runs on **sqlite**, one temporary file per test: two seconds, no container. That is a
fast check of logic, not proof the product works. sqlite does not enforce string lengths, has JSON
rather than JSONB, and behaves differently under concurrency — so anything about storage is proven
against real postgres, through `scripts/e2e_browser.mjs` or a postgres-backed test that skips when
the database is down. Foreign keys *are* enforced under test (`make_engine` switches the pragma on).

`uv run pytest` must be green before anything is called done. Every non-trivial path gets one check
in `tests/test_reviewer.py` — the smallest thing that fails if the logic breaks. No fixtures
factories, no mocks of things we own; the suite runs on sqlite and needs no containers.

Beyond unit tests, exercise the real thing: bring up postgres, bootstrap, drive the two endpoints,
and read the rows back. A green suite against sqlite is not proof the product works.

**Prove a test fails before you trust it passing.** Every check written for a defect gets run once
against the code from before the fix, and the failure message must name the defect rather than an
index or a length. A test that has only ever been green is a test nobody has read.

### The corpus

Six tests measure precision and recall against a real SAP Commerce checkout and skip without one:

```bash
SMITH_CORPUS=/path/to/a/checkout uv run pytest      # 141 passed
uv run pytest                                        # 135 passed, 6 skipped
```

No corpus ships here and none ever will — the one the rules were tuned against is client code. It
is read, never written, and nothing derived from it is committed. When a measurement produces a
document worth keeping, it goes under `output/` and stays local.

The corpus is a development tool. **The server never sees it** and does not need it: production
receives a diff from the plugin and runs the rules against that. Anyone confusing the two ends up
trying to ship 370,000 lines of somebody else's code to a host.

One corpus is one client and one team's habits, so a rule precise here may be noisy elsewhere. That
is a known limit of every number in this repository, not a solved problem.

## It is deployed

There is a real server with real users, which changes what "done" means for anything touching
storage, authorisation or what a developer's words become. It is a Lightsail box running
`docker-compose.prod.yml` behind Caddy with a Let's Encrypt certificate; `scripts/prod_drill.sh`
brings the same stack up locally and drives the browser suite against it.

Nothing about the deployment lives in this repository yet — it was built by hand — so recreating it
means repeating commands nobody wrote down. That is a task waiting to be written, not a decision.

## Commands

```bash
scripts/ensure_db.sh                            # postgres, starting the podman VM if needed
uv run pytest                                   # server: unit + HTTP tests
SMITH_REFRESH_BASELINE=1 uv run pytest -k baseline -s   # re-pin what the ruleset catches
SMITH_REFRESH_BASELINE=1 uv run pytest -k analyzer_precision -s  # re-pin what the analyzers catch
node --test plugin/test                         # plugin CLI tests
node scripts/rehearse.mjs                       # the finding lifecycle, end to end (needs the API up)
node scripts/walk_skill.mjs [claude|cursor]     # an agent walks the skill in a real session (needs the API up)
uv run python scripts/seed_catalog.py           # load catalog/*.yaml into the catalog table
uv run alembic upgrade head                     # schema (bootstrap does this for you)
uv run uvicorn smith.main:app --reload          # API on :8000
cd web && npm run dev                           # UI on :3100 (needs Node >= 20.9)
uv run python scripts/bootstrap.py --help       # first user, project, API key
```

Kill every dev server you start. No orphan uvicorn processes left behind.

## Security, non-negotiable

- Anything from the plugin is untrusted: diffs, file paths, file contents. Paths are validated
  before touching the filesystem (`adapters/pmd.py::_materialize` is the reference).
- API keys are argon2-hashed. The plaintext key is shown once at creation and never stored.
- Authentication failures are indistinguishable from each other — same message, same timing (see
  `_decoy` in `auth/service.py`). Do not add an error that says "no such user".
- A review is only readable and submittable by the project it belongs to.
