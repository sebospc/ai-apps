"use client";

import { useActionState } from "react";
import { addConvention, type FormState } from "@/app/actions";
import { buttonClass, inputClass } from "@/components/ui";

/**
 * The offer next to a rule the team keeps arguing with: their own words, ready to become the
 * project's conventions. Conventions is the field that stops a rule firing, and on the project
 * this was built for it was empty while every reason to fill it sat in the dismissals.
 */
export function AdoptConvention({ slug, proposal }: { slug: string; proposal: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(addConvention, {});

  return (
    <form action={action} className="mt-2 space-y-2 rounded-md border border-line p-3">
      <input type="hidden" name="slug" value={slug} />
      <p className="text-xs text-muted">
        This keeps firing on something your team calls normal. Add it to Conventions above and
        reviews stop reporting it. Edit the wording first if it is not quite right.
      </p>
      <textarea
        name="convention"
        rows={3}
        defaultValue={proposal}
        className={`${inputClass} font-mono`}
      />
      <div className="flex flex-wrap items-center gap-3">
        <button disabled={pending} className={buttonClass}>
          {pending ? "Adding…" : "Add to conventions"}
        </button>
        {state.error && <p className="text-sm text-block">{state.error}</p>}
        {state.notice && <p className="text-sm text-pass">{state.notice}</p>}
      </div>
    </form>
  );
}
