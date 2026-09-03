"use client";

import { useActionState } from "react";
import { saveConfig, type FormState } from "@/app/actions";
import { Card, Field, buttonClass, inputClass } from "@/components/ui";
import type { ConfigResponse, Severity } from "@/lib/types";

const SEVERITIES: Severity[] = ["critical", "warning", "suggestion", "nitpick"];

export function ConfigForm({ slug, data }: { slug: string; data: ConfigResponse }) {
  const [state, action, pending] = useActionState<FormState, FormData>(saveConfig, {});
  const disabled = new Set(data.config.disabled_rules);
  // The stored value is `base` or `base+client`; the form shows the two halves apart.
  const [base, overlay = ""] = data.config.ruleset.split("+");

  return (
    <Card>
      <h2 className="mb-4 text-sm font-semibold">Review setup</h2>
      <form action={action} className="space-y-5">
        <input type="hidden" name="slug" value={slug} />
        {/* The full list, so the action can work out which rules were switched off. */}
        <input type="hidden" name="all_rules" value={data.rules.map((r) => r.id).join(",")} />

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Ruleset" hint="the base">
            <select name="ruleset" defaultValue={base} className={inputClass}>
              {data.rulesets.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </Field>
          <Field label="Client overlay" hint="adds and removes rules on top of the base">
            <select name="overlay" defaultValue={overlay} className={inputClass}>
              <option value="">none</option>
              {data.overlays.map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
          </Field>
          <Field label="Blocks at" hint="and above">
            <select name="block_on" defaultValue={data.config.policy.block_on} className={inputClass}>
              {SEVERITIES.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </Field>
          <Field label="Max agent findings">
            <input
              name="max_agent_findings"
              type="number"
              min={1}
              max={500}
              defaultValue={data.config.policy.max_agent_findings}
              className={inputClass}
            />
          </Field>
        </div>

        <Field label="Conventions" hint="what is normal here — the agent will not flag these">
          <textarea
            name="conventions"
            rows={4}
            defaultValue={data.config.conventions}
            className={`${inputClass} font-mono`}
            placeholder="Using the Model directly inside a facade is intentional in this project."
          />
        </Field>

        <Field
          label="Reviewer prompt"
          hint="what this project wants emphasised — it cannot change what the agent must return"
        >
          <textarea
            name="reviewer_prompt"
            rows={4}
            defaultValue={data.config.reviewer_prompt}
            className={`${inputClass} font-mono`}
            placeholder="Be strict about transaction boundaries. We care more about correctness than style."
          />
        </Field>

        <fieldset>
          <legend className="text-sm font-medium">Rules</legend>
          <p className="mb-2 text-xs text-muted">
            Unchecked rules are not sent to the agent and their findings are dropped.
          </p>
          {/* No height cap: 288px of a 1382px list cut the fifth rule through the middle of its
              text at every width, and on a phone it put a scroll region inside the page scroll. */}
          <div className="space-y-1.5 rounded-md border border-line p-3">
            {data.rules.map((rule) => (
              <label key={rule.id} className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  name="enabled"
                  defaultChecked={!disabled.has(rule.id)}
                  value={rule.id}
                  className="mt-1"
                />
                <span>
                  <span className="font-mono text-xs">{rule.id}</span>
                  <span className="ml-2 text-muted">{rule.text}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="flex items-center gap-3">
          <button disabled={pending} className={buttonClass}>
            {pending ? "Saving…" : "Save"}
          </button>
          {state.error && <p className="text-sm text-block">{state.error}</p>}
          {state.notice && <p className="text-sm text-pass">{state.notice}</p>}
        </div>
      </form>
    </Card>
  );
}
