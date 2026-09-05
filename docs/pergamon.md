# Pergamon — the decisions, before any code

Settled 2026-09-03. This document exists so that the first line of Pergamon is written against a
shape somebody chose, rather than one that grew. Nothing here is built yet.

The governing rule for all of it: **the little it does, it does very well.** Every section below is
written to be small. When something can be left out, it is left out and the reason is written down.

## What it is

The same feature gets built many times, by different developers, in a different way each time.
Pergamon keeps one generalized implementation of it and applies that to a project.

Reviewer checks code that is already written. Pergamon helps write new code from something that
already works. They share a plugin, an identity model and a deployment.

## The shape, and it is Reviewer's

Four decisions, all of them the same ones Reviewer took, and taken again on purpose rather than
inherited by accident.

**1. The server has no LLM.** Generation happens in the developer's editor, on their model and their
tokens. No providers, no cost per generation, no keys to hold. It also means the client's code never
leaves their machine to be generated against, which is what made the egress protection in the
previous version necessary and what makes it unnecessary here.

**2. The server serves the catalog and nothing else.** It answers two calls and holds one table.

**3. The web is read-only.** You browse the catalog and read what an entry does. You cannot generate
from it, and you cannot author from it. This mirrors Reviewer exactly, where the web shows reviews
and cannot start one.

**4. The server records nothing about a generation.** No commissions table, no answers, no generated
code. What happens in the session stays in the developer's editor and in their git history.

## What a catalog entry is

Instructions for an agent, not a template with holes. The agent reads the project it is landing in
and adapts; a template cannot.

An entry carries four things:

- **What it is.** A title and a paragraph, written for a developer scanning a list.
- **What to ask.** The decisions the code cannot reveal — a name, an extension, what varies per
  environment. Free text, because the answers are.
- **How it is built here.** The pieces the feature needs in SAP Commerce, named: a type in
  `items.xml`, a Spring bean, an ImpEx that creates the instance, the Java class.
- **What good looks like.** The traps. "The performable does not open its own transaction."
  "Configuration goes in properties, never hardcoded."

Sketched, for a feature every project rebuilds:

```yaml
id: scheduled-cronjob
title: A cronjob with its own configuration and a schedule
about: >
  A CronJob type, its performable, the ImpEx that creates the instance and its trigger, and the
  properties that make it configurable per environment.

ask:
  - What is the job called?
  - Which extension does it belong in?
  - What has to be configurable per environment?

build:
  - A type in items.xml extending CronJob, carrying the job's own attributes.
  - A JobPerformable registered as a Spring bean.
  - An ImpEx creating the job instance and its trigger.
  - The Java class implementing perform().

good:
  - The performable does not open its own transaction; the framework owns it.
  - Configuration is read from properties, never hardcoded.
  - The job is idempotent: running it twice does not double its effect.
```

## The part that is the same for every feature

An entry says what *this* feature needs. On top of that there is a fixed layer that runs whatever
the feature is, because every SAP Commerce feature lands the same way and gets integrated wrong in
the same places:

- **Extensions.** Which ones the feature adds, and which of them go into `localextensions.xml`.
- **Platform dependencies.** Which SAP extensions have to already be there — `commercewebservices`,
  `b2bcommerce`, and so on. A feature that assumes one the project does not have fails at build.
- **Item types.** What `items.xml` declares, and whether it collides with something the project
  already has.
- **Version fit.** The platform and Spartacus versions the entry was written against, checked
  against the project's.

This is the half a developer forgets, and it is the same list every time, which is exactly why it
belongs in the tool rather than in each entry.

## What a generation delivers

Two things, and only two:

- **The specs**, written as conditions — given this, given that, and the acceptance criteria.
- **The code.**

When an entry asks for acceptance criteria and the developer has them, they are used. When the
developer does not, Pergamon writes them: it has already read the project and it knows what the
feature does, and a tool that stops to demand a document nobody has is friction rather than rigour.

Not delivered, and each was in the previous version: a separate functional spec, separate test
cases, an implementation guide. They can be added when somebody asks for one by name.

## How far a check on the generated code can go here

There is no SAP Commerce platform in this repository and none is coming: `bin/platform` is not in
the corpus checkout, `ant` is not installed, and the framework jars every generated file imports
exist nowhere on the machine. So the one question a developer actually wants answered — does this
compile against the platform it targets — is the one question the apply walk cannot answer, and
nothing here should be read as if it did.

What the walk does check is that each written file parses: `xmllint` on every `.xml`, the reviewer's
own ImpEx reader on every `.impex`, and `javac -proc:only` on every `.java`. That `javac` run is
syntax and never linking. `-proc:only` stops it after the symbols are entered, which is the last
point where a diagnostic still means something without a classpath — past there an unresolved base
class invents a bad `@Override`, an unknown method and an incompatible type, none of them real. What
that phase can still say about a type it cannot find is three codes, and they are dropped by code
rather than by message: `cant.resolve`, `doesnt.exist`, `cant.access` and the static-import form
`static.imp.only.classes.and.interfaces`. What survives is a file that would not parse on any
classpath. A missing method, a wrong argument type, an interface implemented incompletely: all of
that passes here and fails in a real build.

That is a floor, not a ceiling, and it is worth having because the failures under it are the
expensive kind. A `<bean>` missing its closing tag is not a compile error, it is a platform that
refuses to start, and before this existed nothing in the walk read a generated file as anything but
text.

## Nothing is frozen

A delivery is not immutable. The session continues, the developer changes a decision they made
earlier, adjusts what was written, asks for a different approach on one file. From that point the
code is theirs.

The previous version froze every delivery for traceability. Git already is that record, and it keeps
it better than a second copy would. A delivery that cannot be touched stops being useful at exactly
the moment it is 90% right, which is where it will be almost every time.

The one thing worth keeping from that idea is not immutability but provenance: knowing which entry
and which version a piece of code came from, so that fixing an entry can be told to the projects that
started from the broken one. That needs a record the server does not keep today, so it is named here
and deliberately not built. If it is ever wanted, it is one column and a reason.

## What crosses the wire

The catalog is Smith's own writing and carries no client anything, so it travels freely. The
project's code does not travel: the agent reads it locally and never sends it. The developer's
answers do not travel either, since nothing records them.

That is the whole data story, and it is short because of decision 1.

## The surface

Small enough to list completely.

**Server:** one table of catalog entries, and two endpoints.

- `GET /v1/catalog` — every entry as id, title and `about`. Small enough to send whole; the agent
  matches the developer's words against it.
- `GET /v1/catalog/{id}` — one entry in full.

Two rather than one because the full entries are long and a developer applies one at a time. Two
rather than three because nothing is submitted back.

**Plugin:** a second skill in the same plugin. No new install for anyone who already has it, and
Cursor picks the skill from its description exactly as it picks `review`. The CLI grows the two
commands the skill needs and nothing else.

**Web:** one page, read-only. The catalog, browsable, laid out to be read rather than operated.

**Authoring:** entries are written as YAML files in the repository and loaded into the table by a
script, the way `bootstrap.py` loads a first user. This was chosen rather than a web form: adding an
entry is then a commit somebody reviews, which is what "a person promotes a pattern" means in
practice, and it costs no screen, no table beyond the one, and no approval flow. Say so if a lead
should be able to write one without touching git — it changes this line and nothing else in this
document.

## What is deliberately absent

Each of these was in the previous version and none of it survives decision 1:

- AI provider configuration, model selection, cost metering, generation budgets
- Provenance-based egress protection — nothing egresses
- A conversational agent and a generation engine as separate server components
- Deterministic fallback generators for when a provider is down
- An approval gate before publication, and immutable frozen deliveries

## What has to be true before the first line is written

- The catalog table and the two endpoints, with the authorisation Reviewer already has: a key is
  bound to a person, a project's members can read, non-membership and non-existence are
  indistinguishable in the message.
- Real entries, and they already exist. The previous Pergamon packaged thirteen features with a
  `feature.json` each, under `~/Documents/commerce/projects/features/` and `features-best-run/`.
  That format already carries the fixed layer above — `extensions`, `addToLocalextensions`,
  `requiresPlatformExtensions`, `occEndpoints`, `impex`, `compatibility` — which is evidence it is
  the right list rather than a guess. The entries are the input; the format is a starting point to
  cut down, not to copy whole.
- The skill, and a walkthrough that a real agent completes in a real session, the way
  `scripts/walk_skill.mjs` does for the review skill today.
