# Smith Reviewer

Plugin-first code review. The developer never leaves the editor; the lead reads the trail on the web.

## How a review works

```
plugin                          server                       agent (Cursor / Claude Code)
  |  POST /v1/reviews  --------->|
  |    diff + changed files      | deterministic rules + PMD
  |                              | scope to added lines, store
  |<---- review plan ------------|  findings + guidelines + policy
  |                                        |
  |            reasoning over the diff ----+
  |  POST /v1/reviews/{id}/findings ------>|
  |                              | scope, cap, dedup, apply policy
  |<---- verdict ----------------|  blocking: true|false
```

The server owns the deterministic findings, the rules and the verdict. The agent owns the reasoning
and runs on the developer's own model. **No LLM keys live here.**

## Layout

```
web/               Next.js UI: sign in, projects, reviews, one review, settings
plugin/            the editor plugin: two commands and one Node script
src/smith/
  main.py          process entry point: one app, one router per context
  container.py     composition root — the only place adapters are constructed
  db.py            engine, session, unit of work
  auth/            identity: users, projects, memberships, API keys
  reviewer/
    domain/        pure: diff parsing, rules, dedup, verdict
    ports.py       what the reviewer needs from outside
    service.py     the two use cases
    adapters/      postgres, yaml rules, pmd, eslint, depcruise, http
rules/             rulesets: prose guidelines + regex checks (clients/ holds per-client overlays)
```

`auth` and `reviewer` never import each other's adapters. Splitting one into its own service means a
second `main.py` with one router.

## Run it

The whole stack — postgres, the API on :8000, the UI on :3100 — in one command:

```bash
podman compose up -d
podman exec smith-api python scripts/bootstrap.py --email you@co.com --password '...' --project acme
```

The API image carries PMD (and the JRE it needs), applies `alembic upgrade head` on start, and is
the only reason the Dockerfile is not three lines. `docker compose` works the same way.

Working on the code instead, with the database in a container and the rest on the host:

```bash
scripts/ensure_db.sh                 # postgres: reviewer + pergamon databases
cp .env.example .env                 # set SMITH_SECRET_KEY
uv sync
uv run python scripts/bootstrap.py --email you@co.com --password '...' --project acme
uv run uvicorn smith.main:app --reload
uv run pytest
```

### Measuring against a real codebase

Six tests measure precision and recall against a real SAP Commerce checkout, and they skip unless
one is present:

```bash
SMITH_CORPUS=/path/to/a/sap-commerce/checkout uv run pytest
```

No corpus ships with this repository. The one the rules were tuned against is client code, so the
measurements it produced — `tests/data/*-baseline.jsonl` and the audits under `output/` — are kept
out of version control too. Point `SMITH_CORPUS` at any checkout of your own and re-pin with
`SMITH_REFRESH_BASELINE=1 uv run pytest -k baseline -s`.

## Run it somewhere else

`docker-compose.prod.yml` is the same product with the parts a host needs: Caddy in front holding
the certificate, nothing else published, and secrets that have to be supplied rather than defaulted.

```bash
export SMITH_SECRET_KEY=$(openssl rand -hex 32)
export SMITH_DB_PASSWORD=$(openssl rand -hex 16)
podman compose -f docker-compose.prod.yml up -d
podman exec smith-prod-api python scripts/bootstrap.py --email you@co.com --password '...' --project acme
```

The UI and the plugin then share one origin — `https://localhost:8443` by default, because rootless
podman cannot bind 443. On a host that can, set `SMITH_HTTPS_PORT=443 SMITH_HTTP_PORT=80` and Caddy's
redirect from plain HTTP lands where it should. `SMITH_SITE` is the hostname on the certificate, and
`SMITH_TLS` is `internal` (Caddy signs it itself) until you give it an email address, at which point
Caddy fetches a real one.

One origin is worth the reverse proxy on its own: `/v1`, `/auth`, `/projects` and `/health` go to the
API and everything else to the UI, so there is one certificate, no CORS and one hostname to keep
alive. And because TLS ends at Caddy, the API sets `Secure` on the session cookie.

```bash
scripts/prod_drill.sh          # build it, start it, and drive the whole product through a browser
scripts/prod_drill.sh --keep   # ...and leave it running to look at
```

The drill is the part worth running. There is no host to deploy to, so this is what stands in for
one: it starts from empty volumes, waits for every service to report itself healthy, creates the
first lead, hands Node the CA Caddy invented so the plugin verifies the chain rather than skipping
it, and then runs the 64-check browser suite against the containers over HTTPS.

One thing it will not do for you. The generated `SMITH_DB_PASSWORD` only reaches postgres on the run
that initialises its data directory, so changing it later means the API cannot log in — that is
postgres, not Smith, and the fix is to change the role's password rather than the variable.

## On a host

```bash
SMITH_SITE=smith.example.com SMITH_TLS=you@example.com \
SMITH_SECRET_KEY=$(openssl rand -hex 32) SMITH_DB_PASSWORD=$(openssl rand -hex 16) \
  scripts/provision.sh              # docker, the checkout, .env.prod, the stack, the certificate

scripts/provision.sh --check        # the same detection, changing nothing, plus the backup's age
scripts/deploy.sh                   # backup, then origin/main, then rebuild and check
scripts/provision_drill.sh          # both of those, drilled here against podman
```

Provisioning is idempotent on purpose: the host that has users on it is the only host there is to
test against, so running it there has to be a diagnosis rather than a risk. It says what changed and
what was already right, and it leaves the four secrets to you — a secret a script invents is one
nobody has a copy of, and it ends up in whatever log ran it.

Three things it does not do, printed on every run with the values it expects: the instance itself,
the DNS record, and opening 80 and 443. It does check the one that is cheap to get wrong — when the
hostname resolves somewhere that is not this host, it stops before asking Let's Encrypt for a
certificate and burning the rate limit.

Deploying takes a dump before it changes anything, refuses a checkout somebody edited by hand, and
ends by fetching `/health` through Caddy rather than trusting that the containers came up.

Bootstrap prints the API key once. It is stored argon2-hashed and cannot be recovered.

The schema is alembic's. Bootstrap runs `alembic upgrade head` for you; on an existing database use
it directly, and after changing a model write the revision:

```bash
uv run alembic upgrade head
uv run alembic revision --autogenerate -m "what changed"
```

Revisions target postgres, so the unit suite builds its sqlite schema from the metadata instead.
`tests/test_migrations.py` is what proves the revisions run, and it skips when postgres is down.

## Backups

```bash
scripts/backup.sh            # → backups/reviewer-20260821-052651.dump, keeping the newest 14
scripts/backup_verify.sh     # newest dump → a scratch database, counted against the live one
scripts/restore.sh           # newest dump in backups/, asks before it drops anything
scripts/backup_drill.sh      # what the schedule runs, including both ways the verify says no
scripts/restore_drill.sh     # dump, drop, restore over the real database, check nothing was lost
```

All of them run inside the postgres container, so the host needs no client installed. `backup.sh`
reads the archive back before keeping it, deletes it if it is not readable, and then deletes the
dumps past the newest `SMITH_BACKUP_KEEP` — a disk that fills is an outage the backup caused.

On a host, `provision.sh` installs `smith-backup.timer`, which runs the dump at 03:20 and then
`backup_verify.sh` on what it just wrote. That second half is the point: a dump `pg_restore` can
list is a readable file, and only restoring it says it still holds the database. The restore goes
into a scratch database and the live one is never written to.

Nothing on the host pages anybody. `scripts/provision.sh --check` prints how old the newest dump is
and shouts when that is over two days, and `journalctl -u smith-backup` is what it did last. That is
a number somebody has to read, not monitoring, and calling it monitoring would be the lie.

Restoring for real is destructive: it drops the database, terminates whatever was connected, and
recreates it from the dump. It asks for a typed `yes` first, and refuses outright when there is no
terminal to ask on — pass `--yes` when a script is driving it.

The two drills are the part worth running. `backup_drill.sh` is cheap and non-destructive: it checks
the pruning keeps what it should and deletes only what it should, then shows the verify passing on a
good dump and failing on a dump that no longer matches the database. `restore_drill.sh` is the
expensive one, restoring over the real database and comparing every table, index and constraint.
Until those have run, a backup is a file, not a recovery plan.

## Logs

One JSON line per request, on stdout:

```json
{"ts": "...", "level": "INFO", "logger": "smith.request", "msg": "request", "request_id": "660b5d5a4c99",
 "method": "POST", "route": "/v1/reviews", "path": "/v1/reviews", "status": 201, "duration_ms": 812.4,
 "project": 3, "review_id": 141}
```

`route` is the template, so lines from different reviews aggregate; `path` is the concrete URL. The
plugin's routes carry `project` because their URL does not name one.

Every response also carries the same reference in `X-Request-Id`. When something fails in a way
nobody anticipated, the caller gets that reference and nothing else — the traceback stays in the
log, on an `unhandled error` line with the same `request_id`. So "it broke this morning" becomes:

```bash
podman compose -f docker-compose.prod.yml logs api | grep 660b5d5a4c99
```

## Roles

Two per project: `lead` and `dev`. A lead configures rules and policy, manages members and issues
keys. A developer runs reviews and reads the setup.

```bash
POST   /projects                       {slug, name}            create one, you become its lead
POST   /projects/{slug}/members        {email, role}           add someone, or change their role
DELETE /projects/{slug}/members/{email}
POST   /projects/{slug}/keys           {name, for_email}       key bound to that developer
```

Adding a developer creates a passwordless account for them: they never sign into the UI, they use
the plugin. A key issued with `for_email` belongs to that developer, so their reviews are attributed
to them rather than to the lead who handed out the key.

## Adding a rule

Regex, per project — add to a ruleset in `rules/`:

```yaml
checks:
  - id: no-sysout
    file_pattern: "*.java"
    pattern: 'System\.out\.println'
    severity: warning
    message: "Use a logger."
```

Anything a regex cannot see — a duplicate `.properties` key, a cross-file pattern — is a function:

```python
@rule("my-rule")
def my_rule(ctx: RuleContext) -> list[Finding]:
    ...
```

Rules must be pure and must not raise; one that does is logged and skipped, never failing the review.

A client that differs from the base gets an overlay in `rules/clients/<slug>.yaml`, holding only the
difference: extra `rules:`, extra `checks:`, and `disabled:` ids it switches off from the base. The
project points at `sap-commerce-base+<slug>` and the two compose, base first.

Login is rate limited per email and per address: ten failures in fifteen minutes and the next
attempt is refused with 429 before any password is hashed. A password that works clears the count.

## Deliberate limits

- What one review may be: 25 MB of request, 2 MB of diff, 400 files, 400 kB per file, 200
  deterministic findings. The first is checked on Content-Length and answered with a 413 before the
  body is read; the diff limit is a 422 that names the size and the way out. The plugin applies the
  file limits itself, so a developer meets them as "that file was too big to send whole", never as a
  refused review.
- The findings cap is the one that changes what you see. A file that trips the same rule on every
  line would otherwise return thousands of findings nobody reads, so the 200 most severe are kept
  and the agent is told what was cut and where. Under 200 nothing moves — the numbers you point at
  stay put.
- An analyzer that stops answering is cut off after 120s and contributes nothing. A missing binary
  does the same. A broken tool costs its own findings and never the review.
- Auth tables live in the `reviewer` database until pergamon needs them.
- The analyzers only run if their binaries are on PATH: `pmd`, `eslint`, `depcruise`. ESLint also
  needs the project's own config to travel with the change; without one it reports nothing.
- PMD runs `rules/pmd-java.xml`, thirteen rules that each named a defect on a real codebase, not
  PMD's `quickstart.xml`. Quickstart reported 244 findings where the whole ruleset reported 14, and
  82 of them blocked a merge on formatting. No analyzer finding is `critical` any more: blocking is
  the project's policy to decide, not a tool's default priority.
- `depcruise` reads `.ts` and `.tsx` only when `typescript` resolves from its own install
  directory, and it caps out at TypeScript 6 (`>=2.0.0 <7.0.0`). Install both together —
  `npm i -g dependency-cruiser typescript@5` — or every TypeScript module cruises as a file with no
  dependencies and the analyzer reports no cycles on a codebase full of them.
- Cycles are read from the graph that survives compilation, so an import only a type annotation
  used is not one. Reporting a type-only cycle would be the analyzer crying wolf.
