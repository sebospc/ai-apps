"use client";

import { useActionState } from "react";
import { createProject, type FormState } from "@/app/actions";
import { Card, buttonClass, inputClass } from "@/components/ui";

export function NewProjectForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(createProject, {});

  return (
    <Card>
      <h2 className="mb-3 text-sm font-semibold">New project</h2>
      <form action={action} className="flex flex-wrap items-start gap-2">
        <input name="slug" required placeholder="slug" className={`${inputClass} w-40`} />
        <input name="name" placeholder="Display name" className={`${inputClass} flex-1`} />
        <button disabled={pending} className={buttonClass}>
          {pending ? "Creating…" : "Create"}
        </button>
      </form>
      {state.error && <p className="mt-2 text-sm text-block">{state.error}</p>}
      <p className="mt-2 text-xs text-muted">You become the lead of any project you create.</p>
    </Card>
  );
}
