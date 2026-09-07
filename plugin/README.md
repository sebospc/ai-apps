# smith plugin

Code review inside your editor. You ask for a review in the chat you already use, the agent runs the
checks and reads the diff, and the Smith server decides whether the change is blocked.

Two editors are supported. **Cursor is first below** because it needs one more install step than
Claude Code and gets it wrong more easily. If you use Claude Code, skip to
[Claude Code](#claude-code).

Every command on this page was run on macOS before it was written down — the install sections on
2026-09-07, the rest on 2026-08-21. The `smith`
commands were run in an empty environment: nothing but `HOME`, and a PATH holding `node` and the
system tools. What was observed and what is still an assumption is listed at the end, in
[What was observed](#what-was-observed).

## Cursor

Everything you need is in this section: install, first review, and what to do when it does not
answer.

### 1. Install

One command in a terminal, then one pick inside Cursor. Nothing to clone.

```bash
cursor-agent plugin marketplace add https://github.com/sebospc/ai-apps
```

Then in Cursor, type `/plugins` and install **smith** from the list.

To update later, re-index and Cursor picks up the new version:

```bash
cursor-agent plugin marketplace update smith
```

If a `smith` marketplace already exists pointing somewhere else, the name collides and the old one
wins silently — `marketplace list` still shows the old URL after an `add` that printed a tick.
Remove it first:

```bash
cursor-agent plugin marketplace remove smith
```

#### From a checkout instead

Only when you are changing the plugin itself, or the machine cannot reach GitHub. From the root of
your checkout, all three lines:

```bash
rm -rf ~/.cursor/plugins/local/smith
mkdir -p ~/.cursor/plugins/local
cp -R "$PWD/plugin" ~/.cursor/plugins/local/smith
```

The first line is not decoration. `cp -R` onto a directory that already exists copies *into* it, so
running the third line twice on its own leaves you with a `plugin/` folder nested inside the
install, and Cursor then loads whichever of the two it reads first. Run all three every time you
pull, and it does not matter what was there before.

A copy, not a symlink. Cursor rejects a plugin whose target lies outside
`~/.cursor/plugins/local`, so a symlink to your checkout loads nothing and tells you nothing.

### 2. Your first review

Ask in Cursor's chat, in plain words, and give it the two things it cannot know:

> review this change with Smith. My Smith server is https://your-smith-server and my key is smk_...

Your key comes from your project lead, who issues it on the project's settings page in the Smith
web UI.

That is the whole thing. The agent reads the skill, finds the CLI inside the plugin directory, saves
your credentials, runs the review and tells you the verdict and what to fix. You never repeat the
server or the key: they are stored user-only in `~/.smith/config.json`, mode 600, and sent as a
bearer token. The server keeps only an argon2 hash of the key, so nobody can read it back out.

**One step, down from three.** The two that went away were putting `smith` on PATH and running
`smith auth` yourself. Neither was ever needed: the agent reaches the CLI through the plugin's own
directory, and it can run `auth` for you.

Every review after the first is shorter:

> review this change with Smith

If you would rather not put a key in a chat message, run this in a terminal once and then ask for
the review with no credentials in it:

```bash
node ~/.cursor/plugins/local/smith/bin/smith auth --url https://your-smith-server --key smk_...
```

Two steps instead of one, same result.

### 3. When it does not answer

There is no `/smith` command in Cursor and there is not meant to be. Cursor gives a plugin skill no
name and no namespace, so the agent picks it from its description: any request that mentions Smith
and a review reaches it.

**Do not type `/review`.** That one belongs to Cursor. It answers with a menu of `/review-bugbot`
and `/review-security` and never reaches this plugin.

If the agent says it cannot find Smith, check the install landed in the right shape:

```bash
ls ~/.cursor/plugins/local/smith
```

You should see `bin`, `skills`, `plugin.json`. If you also see `plugin`, the nested copy happened:
run the three install lines again, all of them.

## Claude Code

Two commands, and nothing to clone:

```bash
claude plugin marketplace add https://github.com/sebospc/ai-apps.git
claude plugin install smith@smith
```

Then ask for a review with `/smith:review`.

Give it the full `https://` URL, not the `owner/repo` shorthand. The shorthand clones over SSH, so on
a machine with no GitHub key it fails on a repository that is public and that `git clone` would have
read without asking anyone.

From a checkout instead, when you are changing the plugin itself, the same two commands with a path
in place of the repository:

```bash
claude plugin marketplace add "$PWD"
claude plugin install smith@smith
```

Claude Code puts the plugin's `bin/` on PATH by itself, so there is nothing else to set up. To run
against a checkout without installing anything: `claude --plugin-dir ./plugin`.

## What it does, and what it never does

`bin/smith` collects the diff, talks to the server and prints JSON. It does no reasoning. The agent
in your editor does that, using the plan the server returns. Node standard library only, so there is
nothing to install and no version to keep up with.

**No hooks, no status line, no background monitors, no state files.** Nothing in this plugin runs
between reviews. If you are not running a review, it is doing nothing at all. The only file it ever
writes is `~/.smith/config.json`, and only when `smith auth` runs.

## Put `smith` on PATH

Optional, and it changes nothing about a review. Without it the agent runs
`node ~/.cursor/plugins/local/smith/bin/smith`, which works and which you never see. Do this only if
you want to type the commands in the next section yourself, and run it from the root of your
checkout:

```bash
ln -sf "$PWD/plugin/bin/smith" "$(dirname "$(command -v node)")/smith"
```

It lands next to `node`, which is on PATH by definition because `bin/smith` starts with
`#!/usr/bin/env node`. No sudo, no shell config to edit.

One thing to know: if you manage Node with nvm and switch versions, the new version's `bin/` has no
`smith` and the line has to be run again. Any directory already on your PATH works the same way, if
you prefer one that outlives a version switch.

## By hand, or from CI

```bash
smith auth --url <server> --key <key>   # what the agent runs for you on the first review
smith status                            # configuration and reachability
smith plan                              # → review plan as JSON
smith plan --base main                  # review the branch against main instead of uncommitted work
smith submit 42 < findings.json         # → verdict; exits 1 when it blocks
smith respond 42 < answers.json         # → verdict after the developer's answers to the findings
smith review 42                         # → the review again, when the conversation lost its plan
```

`smith plan` reviews uncommitted work when there is any, otherwise the branch against its base.
Deleted, vendored, binary and oversized files are left out of the payload.

`--base main` compares `main...HEAD`, which is committed work only. Uncommitted edits are not in it,
and on a branch with nothing committed yet it exits 1 with `no changes to review`.

Exit codes are the point of this section: `submit` and `respond` exit 1 while the verdict blocks,
`plan` exits 1 when there is nothing to review, and everything else exits 0. A blocking verdict is
not a failure of the command, and `smith` never prints a stack trace or a status code — every
failure is one sentence on stderr starting with `smith:`.

## What was observed

Everything in this list was checked by running it on macOS on 2026-08-21, against the Cursor Agent
CLI `2026.08.11-e8db854` and Claude Code `2.1.238`. Nothing here comes from reading the loaders.

Observed:

- **Both install sections above run clean.** The Cursor copy was run twice in a row and produced the
  same tree both times; the two Claude Code commands were run in a fresh config directory and
  answered `Successfully installed plugin: smith@smith (scope: user)`.
- **`cp -R` onto an existing install nests the plugin.** A second plain copy left `plugin/` inside
  `smith/`. That is why the install is three lines and not one.
- **One prompt in Cursor gets a verdict, starting from nothing.** In a throwaway repository holding
  real code, with `~/.smith` empty, the prompt above made the agent run
  `smith auth ... && smith plan` on its own, read the whole diff, submit, and then report the
  verdict first and five numbered findings, closing with one question. It never showed an id, a
  piece of JSON, or the key it had just been given. The transcript is
  `output/first-review-cursor-2026-08-21.txt`.
- **The agent reaches the CLI through the plugin directory even when `smith` is on PATH.** Every
  command in that run was `node ~/.cursor/plugins/local/smith/bin/smith ...`, with a working `smith`
  sitting on PATH the whole time. It reads the path out of the skill; it does not go looking.
- **That conversation is asserted, not just read.** `node scripts/walk_skill.mjs cursor` and
  `node scripts/walk_skill.mjs claude` run the same session in each editor, with credentials already
  saved, and check the same twelve things about what the developer was shown. Twelve green in both,
  so the two editors cannot drift apart quietly.
- **The whole CLI works from a plain shell.** `auth`, `status`, `plan`, `plan --base`, `submit`,
  `respond` and `review` were each run against a live server in a shell with an empty environment,
  and the exit codes documented above are the ones they returned.
- **A plugin skill reaches the Cursor agent as a path and a description**, with no name and no
  namespace. That is why Cursor has no `/smith:review`. Asked to print every skill line mentioning
  Smith, the agent printed that line with the plugin installed and `NO SMITH ENTRY` without it.
- **`/review` is Cursor's own.** Typed with this plugin installed, it answers "Which review should I
  run?" and offers `/review-bugbot` and `/review-security`. This skill is not among them.
- **Cursor rejects a symlink** pointing outside `~/.cursor/plugins/local`. The same directory loaded
  nothing when symlinked and loaded when copied in.
- **`--plugin-dir <checkout>/plugin` loads the skill straight from a checkout**, in both editors,
  with no copy.
- **The PATH line is executed by the suite, not only written down here.** `node --test plugin/test`
  reads that block out of this file, runs it against a throwaway `node`, and fails if the `smith` it
  installs does not answer `smith status`. It caught this rewrite once, when the block still carried
  a `/path/to/...` placeholder and produced a dangling symlink.
- **Cursor does not put the plugin's `bin/` on PATH; Claude Code does.** Asked to run
  `command -v smith` with the plugin loaded and the Claude Code plugin directories stripped from
  PATH, the Cursor agent printed `NOT_ON_PATH`. That is why the section above is optional.
- **Cursor's agent shell runs Node 18**, not whatever `node -v` says in your terminal. Node 18 tries
  only the first address a name resolves to, and on macOS `localhost` resolves to `::1` before
  `127.0.0.1`, so a server bound to `127.0.0.1` was reported as not answering while `curl` reached
  it from the same shell. `bin/smith` now tries both families the way curl does, so a server on
  `localhost` works from either editor.
- **A copy in `~/.cursor/plugins/local` is loaded as well as the one `--plugin-dir` names**, and the
  agent picks whichever skill it reads first. A stale install reviews with a stale CLI.
- **A manifest `variables` schema cannot carry the server URL or the API key.** A throwaway plugin
  declaring `PROBE_URL` and `PROBE_KEY` loaded, and then the skill file still read
  `MARKER_PROBE_URL=${PROBE_URL}` when the agent opened it, `env` in the agent's shell had no
  `PROBE_*`, and `${CURSOR_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_ROOT}` came back literal too. The
  loader substitutes variables into the MCP server configuration and nowhere else, and a skill
  reaches the agent as a path, so what the agent reads is the file on disk, unexpanded.

Assumptions, not observed. Treat these as unproven:

- **The Cursor IDE**, as opposed to its CLI. Everything above is the CLI. The IDE is assumed to load
  the same directory the same way, and nobody has checked.
- **Which manifest name the Cursor loader prefers.** Both `.cursor-plugin/plugin.json` and
  `.claude-plugin/plugin.json` were present in every run, so no run can tell them apart. That both
  are accepted comes from reading an older loader, not from a run.
- **The root `plugin.json`.** It follows the Agent Plugin standard and is kept for other clients,
  but nothing on this machine has loaded it, and neither editor appears to read it.
- **Anything other than macOS.** Every run was macOS. The commands are POSIX and are expected to
  work on Linux; no Linux run exists.

## Test

```bash
node --test plugin/test
```
