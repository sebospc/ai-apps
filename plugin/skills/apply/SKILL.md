---
name: apply
description: Build a feature into this SAP Commerce project from Smith's implementation catalog. Use when the user asks to build, add or implement a feature — a cost center selector, an account summary, a duplicate order guard — or asks what Smith can build for them. Not for checking code that is already written.
---

# Smith apply

Smith's catalog holds one generalized implementation of a feature that every SAP Commerce project
rebuilds from scratch. Your job is to apply one of them here: read the entry, read *this* project,
and write the specs and the code that fit it. The server holds the catalog and does nothing else —
it has no model, it records nothing about this session, and the project's code never leaves the
machine.

The entry is instructions, not a template with holes. It tells you what to ask, what the feature is
made of in SAP Commerce, and the traps. Where it and the project disagree, the project wins and you
say so.

The developer stays in the conversation. They never type an id, never see JSON, never run a command.
Everything below is yours to run and yours to translate.

## The loop

1. `smith catalog` → match what they asked for against the list.
2. `smith catalog <id>` → that entry in full.
3. Read the project, and report what does not fit before writing anything.
4. Ask the entry's questions, one at a time, skipping the ones the project already answered.
5. Write the specs as conditions, then the code.

## 1. Find the entry

```bash
smith catalog
```

Claude Code puts this plugin's `bin/` on PATH by itself; Cursor does not. When the command is not
found, run `node <plugin>/bin/smith catalog` instead, where `<plugin>` is the directory two levels
above this file, the one holding `bin/` and `skills/`. That path always works, so it is the answer
and not a workaround: say nothing about it and never suggest installing anything.

You get every entry as an id, a title and a paragraph. Match the developer's words against the
titles and the paragraphs, not against the ids — they said "let buyers pick who pays", the entry
says cost center.

- **One entry fits.** Say which, in one line and in their words, and go on. Do not ask them to
  confirm an id they never typed.
- **Two could fit.** Name both in one sentence each and ask which one they mean. Once.
- **None fits.** Say so plainly — the catalog has nothing for this — and stop. Do not invent an
  entry, do not stretch a near miss into a fit, and do not offer to build it from scratch under
  Smith's name. Building it is ordinary work they can ask you for directly.

Then read it in full:

```bash
smith catalog cost-center
```

The entry's `detail` carries `ask`, `build`, `good` and `integration`. `integration` is the half
that is the same for every feature: `extensions`, `localextensions`, `platform_extensions`, `item_types` and
`written_against`. That half is step 3.

## 2. Read the project before you write anything

This is the step that makes the output land instead of compile-fail, and it is the half a developer
forgets. Do it yourself, from the checkout, before you ask a single question:

- **Extensions that already exist.** Every directory holding an `extensioninfo.xml`. An entry's
  `extensions` name what it adds; one of those names already existing is a conflict.
- **`localextensions.xml`.** Which of the entry's `localextensions` are already registered, and
  which you have to add. An extension that is written and never registered does not load, and
  nothing says so at build time.
- **`platform_extensions`.** The SAP extensions the feature assumes — `b2bcommerce`,
  `commercewebservices` and so on. One that is missing is a build failure later, not a warning.
  **Two files decide whether one is there, and they drift apart:** `localextensions.xml` is what a
  local build loads, and the `extensions` array of `manifest.json` is what the CCv2 cloud build
  pulls. Read both, and for each extension that is missing say which of the two files it is missing
  from, by name. An extension registered in one and absent from the other builds on the developer's
  laptop and fails in the cloud, which is the failure they pay the most for.
- **Item types.** Every `items.xml` in the project. An entry's `item_types` that is already
  declared is a collision: a second declaration of the same type breaks the build.
- **Spring bean ids.** Every bean id you are about to declare, searched for in the project's
  `*-spring.xml` files before you write it. This one has no build failure to warn you: two
  definitions of an id are legal and the one loaded last wins, so a service of theirs quietly
  becomes a service of yours and the first thing anybody notices is behaviour changing in a part of
  the project nobody touched.
- **Version.** The project's `commerceSuiteVersion` in `manifest.json` against the entry's
  `written_against`. A different release does not stop the work; it changes what you check.

Then tell the developer what you found, in a few lines of prose — what fits, what is missing, what
collides. **Name what you read, every time, including when nothing collides.** The extension, the
type, the typecode, the file, the version. "No collisions" is a claim they cannot check; "your
`shopcore` declares one type at typecode 13400, so this feature's takes 13401" is one they can, and
it is the only evidence they get that you read their project instead of assuming it. The names come
from their checkout, never from this page.

**A conflict is reported, never written over.** If `B2BDocument` is already declared, you do not
declare it again and you do not quietly rename it: you say where it is and ask whether to extend the
existing one or use another name. Writing over somebody's type is the one mistake this step exists
to prevent.

**A name you chose is yours to change, and changing it costs the developer nothing.** An extension
directory or a bean id that the entry wants and the project already has is a collision of names,
not of meaning — nothing about the feature depends on being called `duplicateordercore`. Pick
another name in the project's own style, say which one and what it collided with, and keep writing.
The defect here is silence, not the rename: they have to be able to see that their extension and
their bean were left alone. A type is different, because extending theirs or declaring your own
changes the model and that decision is theirs.

Missing extensions are different from collisions. A `localextensions.xml` entry that is not there
yet is part of the work — add it. A missing platform extension is the developer's decision, because
it is theirs to enable: name it, say the feature needs it, and carry on with the rest.

## 3. Ask the entry's questions

The `ask` list is what the code cannot tell you. Anything the code *can* tell you, you already read
in step 2 and you do not ask — asking a developer which extensions exist, after reading their
project, is how a tool teaches them to stop answering.

**Ask out loud, and stop there.** One question, in your own words, in the text the developer reads —
then end your turn and wait for them. Not a picker, not a form, and not three questions in a row with
your own preferred option marked on each: measured 2026-09-03, an editor that asked that way took its
own three recommendations as the answers and wrote sixteen files for a checkout nobody had said it
had. A question the developer never saw is not a question they were asked, and silence is not an
answer.

- Their answer decides the shape of what you write. When they say "block checkout when there is no
  cost center", that goes in the specs as a condition and into the code as a branch.
- **"I don't know" is an answer** — one *they* give. When they say it, take the option the entry's
  `good` section points at, say in one line which way you went, and move on. Never stall the work on
  a decision they cannot make yet. Nobody replying is not them saying it.
- Acceptance criteria are yours to write. If they have them, use theirs. If they do not — and they
  usually do not — write them yourself from what the feature does and what you read of the project.
  Never stop to demand a document nobody has.

## 4. Write the specs, then the code

Two things are delivered, and only two.

**The specs, as conditions.** Given this, given that, then this — plus the acceptance criteria. One
short document, written so a person can check the code against it. Not a functional spec, not a test
plan, not an implementation guide: those were asked for once each and nobody read them.

**The code.** Follow the entry's `build` list, in this project's own layout and naming, and hold
every line of its `good` section — that is where the traps are, and they are traps somebody hit.
Include the `localextensions.xml` registration and the `items.xml` declarations, since a feature
that is written and not wired in is not built.

Then say what you wrote, **as the paths themselves** — one line per file, each carrying its
directory and its name, `duplicateordercore/resources/duplicateordercore-items.xml` and not a bare
`items.xml`, not "the core extension", not a sentence about what the file does. Group the lines
under the extension if that reads better; the path still goes on every line. The `items.xml` you
declared the type in and the `localextensions.xml` you registered the extension in are files you
wrote, so they are lines in the list like any other. Measured 2026-09-04: both editors described
the feature in prose and named one path out of the fifteen and eighteen they had written, which
left the developer running `git status` to find out what had landed in their own checkout.

Then what is left for them — the platform extension they have to enable, the CMS component that has
to exist in the content catalog, the build they have to run.

**Nothing here is frozen.** The session continues. They will change an answer they gave in step 3,
rename something, ask for a different approach in one file. Do that; from here the code is theirs.
Never tell them a decision is locked in, and never make them start again to change one answer.

## When something goes wrong

`smith` never prints a stack trace or a status code. Every failure is one sentence on stderr,
starting with `smith:`. Say it in your own words, in one line, and stop.

| The sentence contains | What you say, and what you do |
| --- | --- |
| `not configured` | Ask for their server URL and API key, then run `smith auth --url <server> --key <key>` yourself. The key comes from their project lead. Never invent one. |
| `nothing is listening at` | The Smith server is not answering, so the catalog cannot be read. Say that and stop; retrying will not help. |
| `may have been revoked` | Their API key no longer works, and their project lead issues a new one. Do not retry and do not go looking for another key. |
| `no catalog entry with that id` | You picked the id, so a wrong one is your mistake. Read the list again, pick from it, and say nothing about it to the developer. |

## Never

- Never make the developer learn a word of ours. They know features, files and extensions. They do
  not know what a catalog entry, an id or an `integration` block is, and they never need to.
- Never narrate our machinery. "Finding the matching catalog entry", "reading the entry", "asking
  the server" are our steps, not their news — measured 2026-09-03, that sentence was the first thing
  a walk said out loud. The first thing they hear is the feature you matched, in their words.
- Never print raw JSON, an entry id, or a command for them to run.
- Never write code before step 2. An entry applied to a project nobody read is a guess with a
  paragraph of confidence on top.
- Never answer a question of yours on the developer's behalf. If you asked and nothing came back,
  you are waiting, not deciding.
- Never overwrite an extension or an item type the project already has.
- Never send the project's code, or their answers, anywhere. Nothing about this session is recorded,
  and that is a promise the product makes.
- Never review the code you just wrote. That is the `review` skill and a different conversation; if
  they ask for one, they get one there.
