"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { ApiError, SESSION_COOKIE, api, apiLogin } from "@/lib/api";

/**
 * Every mutation in the app. They run on the server, forward the session cookie, and revalidate the
 * page that shows the result — so there is no client cache that can disagree with the database.
 */

export type FormState = { error?: string; notice?: string };

function difference(all: string[], keep: string[]): string[] {
  const kept = new Set(keep);
  return all.filter((id) => !kept.has(id));
}

async function run(action: () => Promise<string | void>, path?: string): Promise<FormState> {
  try {
    const notice = await action();
    if (path) revalidatePath(path);
    return notice ? { notice } : {};
  } catch (err) {
    if (err instanceof ApiError) return { error: err.message };
    throw err;
  }
}

export async function login(_prev: FormState, form: FormData): Promise<FormState> {
  const email = String(form.get("email") ?? "");
  const password = String(form.get("password") ?? "");
  const session = await apiLogin(email, password);
  if (!session) return { error: "Invalid credentials." };

  const jar = await cookies();
  jar.set(SESSION_COOKIE, session, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
  });
  redirect("/");
}

export async function logout() {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
  redirect("/login");
}

export async function createProject(_prev: FormState, form: FormData): Promise<FormState> {
  return run(
    () =>
      api("/projects", {
        method: "POST",
        body: JSON.stringify({ slug: form.get("slug"), name: form.get("name") }),
      }),
    "/"
  );
}

export async function addMember(_prev: FormState, form: FormData): Promise<FormState> {
  const slug = String(form.get("slug"));
  return run(
    () =>
      api(`/projects/${slug}/members`, {
        method: "POST",
        body: JSON.stringify({ email: form.get("email"), role: form.get("role") }),
      }),
    `/p/${slug}/settings`
  );
}

export async function removeMember(_prev: FormState, form: FormData): Promise<FormState> {
  const slug = String(form.get("slug"));
  const email = String(form.get("email"));
  return run(
    () => api(`/projects/${slug}/members/${encodeURIComponent(email)}`, { method: "DELETE" }),
    `/p/${slug}/settings`
  );
}

export async function deleteProject(_prev: FormState, form: FormData): Promise<FormState> {
  const slug = String(form.get("slug"));
  // Typed by hand, so the one irreversible control in this product cannot be a misplaced click.
  if (String(form.get("confirm") ?? "").trim() !== slug) {
    return { error: `Type ${slug} to confirm.` };
  }
  const state = await run(() => api(`/projects/${slug}`, { method: "DELETE" }));
  if (state.error) return state;
  // The project page this was reached from no longer exists, so the only place left is the list.
  revalidatePath("/");
  redirect("/");
}

export async function createKey(_prev: FormState, form: FormData): Promise<FormState> {
  const slug = String(form.get("slug"));
  const forEmail = String(form.get("for_email") ?? "").trim();
  return run(async () => {
    const created = await api<{ key: string; for_email: string }>(`/projects/${slug}/keys`, {
      method: "POST",
      body: JSON.stringify({ name: form.get("name"), for_email: forEmail || null }),
    });
    // Shown once, here, and never retrievable again.
    return `Key for ${created.for_email} — copy it now, it will not be shown again:\n${created.key}`;
  }, `/p/${slug}/settings`);
}

export async function revokeKey(_prev: FormState, form: FormData): Promise<FormState> {
  const slug = String(form.get("slug"));
  return run(
    () => api(`/projects/${slug}/keys/${form.get("key_id")}`, { method: "DELETE" }),
    `/p/${slug}/settings`
  );
}

export async function saveConfig(_prev: FormState, form: FormData): Promise<FormState> {
  const slug = String(form.get("slug"));
  const base = String(form.get("ruleset"));
  const overlay = String(form.get("overlay") ?? "");
  return run(async () => {
    await api(`/projects/${slug}/config`, {
      method: "PUT",
      body: JSON.stringify({
        ruleset: overlay ? `${base}+${overlay}` : base,
        policy: {
          block_on: form.get("block_on"),
          max_agent_findings: Number(form.get("max_agent_findings")),
        },
        // A browser omits unchecked boxes entirely, so the form can only report what is ON. The
        // server stores the opposite, hence the difference against the full list the page rendered.
        disabled_rules: difference(
          String(form.get("all_rules") ?? "").split(",").filter(Boolean),
          form.getAll("enabled").map(String)
        ),
        conventions: form.get("conventions"),
        reviewer_prompt: form.get("reviewer_prompt"),
      }),
    });
    return "Saved.";
  }, `/p/${slug}/settings`);
}
