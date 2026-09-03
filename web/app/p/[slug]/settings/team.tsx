"use client";

import { useActionState } from "react";
import {
  addMember,
  createKey,
  deleteProject,
  removeMember,
  revokeKey,
  type FormState,
} from "@/app/actions";
import { Card, buttonClass, inputClass } from "@/components/ui";
import type { ApiKey, Member } from "@/lib/types";

export function MembersPanel({ slug, members }: { slug: string; members: Member[] }) {
  const [addState, add, adding] = useActionState<FormState, FormData>(addMember, {});
  const [removeState, remove] = useActionState<FormState, FormData>(removeMember, {});

  return (
    <Card>
      <h2 className="mb-1 text-sm font-semibold">Members</h2>
      <p className="mb-4 text-xs text-muted">
        Adding a developer creates their account. They never sign in here — they use the plugin.
      </p>

      <ul className="mb-4 divide-y divide-line">
        {members.map((m) => (
          <li key={m.email} className="flex items-center justify-between py-2 text-sm">
            <span>{m.email}</span>
            <span className="flex items-center gap-3">
              <span className="text-xs uppercase tracking-wide text-muted">{m.role}</span>
              <form action={remove}>
                <input type="hidden" name="slug" value={slug} />
                <input type="hidden" name="email" value={m.email} />
                <button className="text-xs text-muted hover:text-block">Remove</button>
              </form>
            </span>
          </li>
        ))}
      </ul>

      <form action={add} className="flex flex-wrap items-start gap-2">
        <input type="hidden" name="slug" value={slug} />
        {/* min-w keeps an email address readable while typing: without a floor the row still fits on
            a phone, at 114px, which is narrower than the address going into it. */}
        <input
          name="email"
          type="email"
          required
          placeholder="dev@company.com"
          className={`${inputClass} min-w-48 flex-1`}
        />
        {/* basis, not width: inputClass carries w-full, and in a flex row a basis beats it. With
            w-28 the select rendered full width and pushed the button onto its own line. */}
        <select name="role" defaultValue="dev" className={`${inputClass} basis-28`}>
          <option value="dev">dev</option>
          <option value="lead">lead</option>
        </select>
        <button disabled={adding} className={buttonClass}>
          Add
        </button>
      </form>
      <Notices states={[addState, removeState]} />
    </Card>
  );
}

export function KeysPanel({
  slug,
  keys,
  members,
}: {
  slug: string;
  keys: ApiKey[];
  members: Member[];
}) {
  const [createState, create, creating] = useActionState<FormState, FormData>(createKey, {});
  const [revokeState, revoke] = useActionState<FormState, FormData>(revokeKey, {});

  return (
    <Card>
      <h2 className="mb-1 text-sm font-semibold">Plugin keys</h2>
      <p className="mb-4 text-xs text-muted">
        A key belongs to one person: their reviews show up under their name.
      </p>

      <ul className="mb-4 divide-y divide-line">
        {keys.map((k) => (
          <li key={k.id} className="flex items-center justify-between py-2 text-sm">
            <span>
              <span className="font-mono text-xs text-muted">{k.prefix}…</span>
              <span className="ml-2">{k.user_email}</span>
              {k.name && <span className="ml-2 text-muted">({k.name})</span>}
            </span>
            <span className="flex items-center gap-3 text-xs text-muted">
              <span>{k.last_used_at ? `used ${k.last_used_at.slice(0, 10)}` : "never used"}</span>
              {k.revoked ? (
                <span>revoked</span>
              ) : (
                <form action={revoke}>
                  <input type="hidden" name="slug" value={slug} />
                  <input type="hidden" name="key_id" value={k.id} />
                  <button className="hover:text-block">Revoke</button>
                </form>
              )}
            </span>
          </li>
        ))}
      </ul>

      <form action={create} className="flex flex-wrap items-start gap-2">
        <input type="hidden" name="slug" value={slug} />
        <select name="for_email" defaultValue="" className={`${inputClass} min-w-48 flex-1`}>
          <option value="">— me —</option>
          {members.map((m) => (
            <option key={m.email} value={m.email}>
              {m.email}
            </option>
          ))}
        </select>
        <input name="name" placeholder="label, e.g. laptop" className={`${inputClass} basis-48`} />
        <button disabled={creating} className={buttonClass}>
          Create key
        </button>
      </form>

      {createState.notice && (
        <pre className="mt-3 overflow-x-auto rounded border border-pass/40 p-3 text-xs whitespace-pre-wrap">
          {createState.notice}
        </pre>
      )}
      <Notices states={[{ error: createState.error }, revokeState]} />
    </Card>
  );
}

export function DangerPanel({ slug }: { slug: string }) {
  const [state, remove, removing] = useActionState<FormState, FormData>(deleteProject, {});

  return (
    <Card>
      <h2 className="mb-1 text-sm font-semibold text-block">Delete this project</h2>
      <p className="mb-3 text-sm text-muted">
        Removes {slug} and every review, finding and key recorded under it. This cannot be undone.
      </p>
      <form action={remove} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="slug" value={slug} />
        <input
          name="confirm"
          placeholder={`type ${slug} to confirm`}
          aria-label={`Type ${slug} to confirm deletion`}
          className={`${inputClass} basis-64`}
        />
        <button disabled={removing} className={buttonClass}>
          Delete project
        </button>
      </form>
      <Notices states={[state]} />
    </Card>
  );
}

function Notices({ states }: { states: FormState[] }) {
  const errors = states.map((s) => s.error).filter(Boolean);
  if (errors.length === 0) return null;
  return (
    <div className="mt-2 space-y-1">
      {errors.map((e, i) => (
        <p key={i} className="text-sm text-block">
          {e}
        </p>
      ))}
    </div>
  );
}
