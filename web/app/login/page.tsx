"use client";

import { useActionState } from "react";
import { login, type FormState } from "@/app/actions";
import { Card, Field, buttonClass, inputClass } from "@/components/ui";

export default function LoginPage() {
  const [state, action, pending] = useActionState<FormState, FormData>(login, {});

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center px-6">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">Smith</h1>
      <p className="mb-6 text-sm text-muted">Sign in to see your projects and reviews.</p>

      <Card>
        <form action={action} className="space-y-4">
          <Field label="Email">
            <input name="email" type="email" required autoFocus className={inputClass} />
          </Field>
          <Field label="Password">
            <input name="password" type="password" required className={inputClass} />
          </Field>
          {state.error && <p className="text-sm text-block">{state.error}</p>}
          <button type="submit" disabled={pending} className={`${buttonClass} w-full`}>
            {pending ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </Card>

      <p className="mt-6 text-xs text-muted">
        Developers do not need an account here — they use the editor plugin with a key from their
        lead.
      </p>
    </main>
  );
}
