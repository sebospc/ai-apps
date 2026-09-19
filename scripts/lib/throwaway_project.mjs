/**
 * The project a script creates for one run, and the sweep that removes the ones a killed run left.
 *
 * Discarding the project in a `finally` covers a run that fails and not a run that is killed, and
 * killed is the normal ending for anything a timer drives: X2 counted 9 abandoned walk projects
 * four days after the database was emptied, Y3 counted 13 of them plus 14 more from the other
 * scripts. So the cleanup cannot depend on the process surviving, and a signal handler would not
 * help — nothing runs on SIGKILL.
 *
 * Instead the name says when the project was made, and the next run removes the ones an earlier run
 * abandoned before it starts its own.
 *
 * Sweeping by hand, against a server that is already up:
 *
 *   node scripts/lib/throwaway_project.mjs --api http://localhost:8092 \
 *     --email rehearsal@smith.test --password rehearsal-password
 */

/**
 * The one thing that makes a project ours to delete. A slug is swept only when it starts with this
 * word *and* ends in a timestamp of the right shape reading a plausible date — `throwaway-notes`
 * and `walk-mtnr8srh` both stay, and so does anybody's real project.
 */
export const THROWAWAY_PREFIX = "throwaway";

/**
 * `Date.now().toString(36)` is 8 characters from 2004 to 2059, so the shape is fixed and a name a
 * person chose has to look remarkably like a millisecond count to be mistaken for one. The middle
 * is what the script calls itself and may hold hyphens: `throwaway-score-first-reading-mu8h1u41`.
 */
const THROWAWAY_SLUG = new RegExp(`^${THROWAWAY_PREFIX}-[a-z0-9]+(?:-[a-z0-9]+)*-([0-9a-z]{8})$`);

/** No project this convention created can predate it, and a clock that is ahead is not a licence. */
const EARLIEST = Date.UTC(2026, 0, 1);

/**
 * Two hours. The longest walk is minutes, so nothing live is ever this old, and an abandoned
 * project is gone by the next night run rather than sitting in the list for four days.
 *
 * `SMITH_THROWAWAY_MAX_AGE_MINUTES=0` sweeps everything that is not the caller's own run, which is
 * how the sweep gets proved against a project that was killed a minute ago.
 */
const DEFAULT_MAX_AGE_MS = 2 * 60 * 60 * 1000;

function configuredMaxAge() {
  const minutes = Number(process.env.SMITH_THROWAWAY_MAX_AGE_MINUTES);
  return Number.isFinite(minutes) && minutes >= 0 ? minutes * 60_000 : DEFAULT_MAX_AGE_MS;
}

const NO_KEEPALIVE = { connection: "close" };

/** The name a run gives the project it is about to throw away. `kind` says which script made it. */
export function throwawaySlug(kind, now = Date.now()) {
  return `${THROWAWAY_PREFIX}-${kind}-${now.toString(36)}`;
}

/** When this slug says it was created, or null when it is not a name a run of ours produced. */
export function createdAt(slug, now = Date.now()) {
  const stamp = THROWAWAY_SLUG.exec(slug)?.[1];
  if (stamp === undefined) return null;
  const created = parseInt(stamp, 36);
  return created >= EARLIEST && created <= now ? created : null;
}

/** The slugs old enough that no run still holds them. Pure, so the predicate can be read alone. */
export function abandoned(slugs, { now = Date.now(), maxAgeMs = configuredMaxAge() } = {}) {
  return slugs.filter((slug) => {
    const created = createdAt(slug, now);
    return created !== null && now - created >= maxAgeMs;
  });
}

/** A lead session, which is what deleting a project needs. */
export async function signIn(api, email, password) {
  const res = await fetch(`${api}/auth/login`, {
    method: "POST",
    headers: { ...NO_KEEPALIVE, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`signing in as ${email} answered ${res.status}`);
  const cookies = res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie") ?? ""];
  return cookies.filter(Boolean).map((cookie) => cookie.split(";")[0]).join("; ");
}

/**
 * Remove the throwaway projects this lead abandoned in an earlier run.
 *
 * Only projects the session leads are even visible here, so the naming is the second condition and
 * not the only one. `keep` is the project the caller is using right now: the age threshold already
 * spares it, and naming it means a run that lowers the threshold to prove the sweep works does not
 * delete the thing it is proving it on.
 */
export async function sweepThrowawayProjects({ api, cookie, keep = [], now = Date.now(), maxAgeMs }) {
  const removed = [];
  const failed = [];
  const res = await fetch(`${api}/auth/me`, { headers: { ...NO_KEEPALIVE, cookie } });
  if (!res.ok) throw new Error(`reading the project list answered ${res.status}`);
  const led = (await res.json()).projects
    .filter((p) => p.role === "lead" && !keep.includes(p.slug))
    .map((p) => p.slug);

  for (const slug of abandoned(led, { now, ...(maxAgeMs === undefined ? {} : { maxAgeMs }) })) {
    const deleted = await fetch(`${api}/projects/${slug}`, {
      method: "DELETE",
      headers: { ...NO_KEEPALIVE, cookie },
    }).catch((err) => ({ ok: false, status: err.message }));
    if (deleted.ok) removed.push(slug);
    else failed.push(`${slug} (${deleted.status})`);
  }
  return { removed, failed };
}

/** One line for a transcript. Says nothing happened out loud, so a sweep that cannot run shows. */
export function sweepLine({ removed, failed }) {
  const swept = removed.length
    ? `swept ${removed.length} project${removed.length === 1 ? "" : "s"} an earlier run left behind: ${removed.join(", ")}`
    : "nothing an earlier run left behind";
  return failed.length ? `${swept} · could not remove ${failed.join(", ")}` : swept;
}

/**
 * Sign in, sweep, and say what happened in one line, for a script that has no session yet.
 *
 * Never throws. A run that could not tidy up is still a run, and the line says what stopped it —
 * on a machine where no earlier run ever signed in, that line is the sign-in being refused.
 */
export async function tidyAfterEarlierRuns({ api, email, password, keep = [] }) {
  try {
    const cookie = await signIn(api, email, password);
    return sweepLine(await sweepThrowawayProjects({ api, cookie, keep }));
  } catch (err) {
    return `could not sweep what earlier runs left behind: ${err.message}`;
  }
}

/** The same sweep, run against a server by hand. Used to clear what the leak already produced. */
async function main(argv) {
  const flag = (name, fallback) => {
    const at = argv.indexOf(`--${name}`);
    return at === -1 ? fallback : argv[at + 1];
  };
  const api = flag("api", process.env.SMITH_API_URL ?? "http://localhost:8000");
  const email = flag("email");
  const password = flag("password");
  if (!email || !password) {
    console.error("usage: throwaway_project.mjs --api URL --email LEAD --password PASSWORD");
    return 2;
  }
  const cookie = await signIn(api, email, password);
  const result = await sweepThrowawayProjects({ api, cookie });
  console.log(sweepLine(result));
  return result.failed.length ? 1 : 0;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`sweep failed: ${err.message}${err.cause ? ` (${err.cause})` : ""}`);
      process.exit(1);
    }
  );
}
