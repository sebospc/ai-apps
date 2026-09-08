---
name: smith-update
description: Check whether the Smith plugin installed here is current, and print how to update it. Runs only when the developer types this command.
---

# Smith update

A Cursor plugin installed from a repository is pinned to the commit it had when it was added. It
does not follow the repository, and nothing tells the developer that. Somebody deleting their plugin
cache to force an update landed on the first commit in the repository with the review command gone,
and found out by typing it.

This command exists so they find out by asking instead.

## What to run

```bash
node <plugin>/bin/smith update
```

`<plugin>` is the directory one level above this file, the one holding `bin/` and `commands/`.

**Use that path, never a bare `smith`.** Claude Code puts a plugin's `bin/` on PATH and Cursor does
not, so every other command here takes whichever copy it finds — they all talk to the same server
and it makes no difference. This one is a question *about the copy it runs from*. Measured
2026-09-08: a machine with an old symlink on PATH was told it was current while the plugin the
editor had actually loaded was sixty-five commits behind.

**If that command prints the usage list instead of an answer**, the copy has no `update` subcommand.
That is the answer, not a failure: `update` shipped in version 0.3.0, so a copy without it is older
than that and the developer is behind. Hand them the block below and say where the number came from.

No credentials are needed either way. This asks the source repository what it has; it never reaches
the Smith server, and it works before the developer has an API key.

## What to say

Print what the command says, near enough word for word. It is already written for the developer:

- **Current** — one line, and stop. Do not offer to update anything.
- **Behind** — the commands are in the order they have to run, and the last one is interactive: the
  developer types `/plugins` in the session themselves. You cannot do that step for them.
- **Could not check** — offline, or a repository this machine has no access to. Say that, and do not
  guess whether they are current.

When you had to fall back to the block yourself, it is this, in this order:

```bash
cursor-agent plugin marketplace remove smith
cursor-agent plugin marketplace add https://github.com/sebospc/ai-apps --git-ref main
cursor-agent            # then type /plugins and install smith
```

Three things in that path report success without doing anything, so none of them can be skipped:
`marketplace update` prints that it indexed the plugin and moves neither copy; `marketplace add`
without `--git-ref` can put them back on the commit they already had; deleting the cache directory
uninstalls the plugin rather than refreshing it.

Two things never to do here:

- **Do not run those commands yourself.** `marketplace remove` uninstalls the plugin you are running
  from, and if the reinstall does not happen the developer is left with nothing. It is three commands
  typed by a person who can see what happened after each one.
- **Do not work around it** by cloning the repository, copying files into the plugin cache, or
  editing anything under `~/.cursor`. A hand-made copy is a plugin nobody can update again. Say
  nothing about paths, and never suggest installing anything.

If they ask why it is this awkward: a plugin added with `cursor-agent plugin marketplace add` is
pinned by design, and a team avoids the whole thing with a Team Marketplace and Auto Refresh, which
updates plugins on push. That is set up once, by whoever administers the team.
