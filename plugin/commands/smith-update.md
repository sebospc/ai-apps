---
name: smith-update
description: Report whether the Smith plugin installed here is current, and what to do if it is not. Runs only when the developer types this command.
---

# Smith update

A Cursor plugin is pinned to the commit it had when it was added. It does not follow the repository
and nothing says so, which is how a developer ended up on the first commit in this repository with
the review command missing.

This command reports. It installs nothing.

## Run

```bash
node <plugin>/bin/smith update
```

`<plugin>` is the directory one level above this file, holding `bin/` and `commands/`.

Use that path, never a bare `smith`. Claude Code puts a plugin's `bin/` on PATH and Cursor does not,
so a bare command can reach a different copy than the one the editor loaded — measured 2026-09-08:
an old symlink on PATH reported "current" while the loaded plugin was 65 commits behind. This is the
one command whose answer is about the copy it runs from.

No credentials are needed. It asks the source repository, never the Smith server.

## Report

Print what the command said, near enough word for word. It is already written for the developer.

- **Current** — one line. Offer nothing further.
- **Behind** — hand over its command block unchanged. The order matters and the last step is
  interactive: the developer types `/plugins` themselves.
- **Could not check** — offline, or no access to the repository. Say that. Do not guess.

**If it printed the usage list instead of an answer**, this copy has no `update` subcommand. That is
the answer: `update` shipped in 0.3.0, so the copy is older than that. Say where the number came
from, then give them the block above.

## Never

- **Never run the update commands yourself.** `marketplace remove` touches account state and the
  reinstall is interactive; a developer left half way through has no plugin.
- **Never install by hand** — no cloning, no copying into `~/.cursor/plugins/cache`, no editing
  anything under `~/.cursor`. Measured 2026-09-09: a correct copy placed there did not load, and
  Cursor then deleted the working one beside it. Installation state lives on the Cursor account.
- **Do not go hunting for an installer.** Say nothing about paths, and never suggest
  installing anything to make the CLI reachable.

If they ask why it is like this: a plugin added with `cursor-agent plugin marketplace add` is pinned
by design. A team avoids it with a Team Marketplace and Auto Refresh, which updates on push and is
set up once by whoever administers the account.
