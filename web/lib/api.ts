import { cookies } from "next/headers";
import { redirect } from "next/navigation";

const BASE = (process.env.SMITH_API_URL ?? "http://localhost:8000").replace(/\/+$/, "");
export const SESSION_COOKIE = "smith_session";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

/**
 * Every read and write goes through here, on the server, with the session cookie forwarded.
 *
 * The API is never exposed to the browser, so there is no token in client JavaScript, no CORS and
 * no client-side cache to keep in sync with the server. Pages re-render; that is the whole state
 * model.
 */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const jar = await cookies();
  const session = jar.get(SESSION_COOKIE);

  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(session ? { cookie: `${SESSION_COOKIE}=${session.value}` } : {}),
      ...init.headers,
    },
    cache: "no-store",
  });

  if (res.status === 401) redirect("/login");
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {
      /* keep statusText */
    }
    throw new ApiError(res.status, detail);
  }
  return (await res.json()) as T;
}

/** Login is the one call that has to move a cookie from the API onto the browser. */
export async function apiLogin(email: string, password: string): Promise<string | null> {
  const res = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
    cache: "no-store",
  });
  if (!res.ok) return null;

  const raw = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  return raw ? raw.split(";")[0].slice(SESSION_COOKIE.length + 1) : null;
}
