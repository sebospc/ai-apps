import { Card } from "@/components/ui";
import type { RuleHealth } from "@/lib/types";
import { AdoptConvention } from "./adopt-convention";

/**
 * The sentence offered to the lead when a rule is flagged. It is built from what is already on the
 * screen — what the rule asks for, and the last reason a developer gave for ruling it out — because
 * a rule dismissed again and again on one project is a convention nobody wrote down.
 *
 * The reason is the developer's agent's wording, so it is reported rather than quoted.
 */
export function proposedConvention(
  ruleId: string,
  ruleText: string | undefined,
  reasons: string[]
): string {
  // First sentence only: a guideline's second sentence is how to fix it ("Return DTOs/Data
  // objects"), which turns into an instruction to do the thing the convention just allowed.
  const what = (ruleText ?? ruleId).trim().split(/(?<=\.)\s+/)[0].replace(/\.$/, "");
  const reason = reasons[0]?.trim();
  if (!reason) return `Not a finding in this project: ${what}.`;
  const ends = /[.!?]$/.test(reason) ? "" : ".";
  return `Not a finding in this project: ${what}. The team ruled it out, reason recorded: ${reason}${ends}`;
}

/**
 * What the team argues with, most-dismissed first.
 *
 * Smith reports and changes nothing on its own: a tool that quietly switches off its own rules
 * cannot be trusted about the rules it leaves on. Switching one off is in the form above, and so is
 * the convention offered here — both are the lead's decision and both are theirs to undo.
 */
export function RuleHealthPanel({
  slug,
  rules,
  guidelines,
}: {
  slug: string;
  rules: RuleHealth[];
  guidelines: { id: string; text: string }[];
}) {
  const fired = rules.filter((r) => r.fired > 0);
  // Deterministic checks are not in the guideline list, so their id is the only name there is.
  const textFor = new Map(guidelines.map((g) => [g.id, g.text]));

  return (
    <Card>
      <h2 className="mb-1 text-sm font-semibold">Rule health</h2>
      <p className="mb-4 text-xs text-muted">
        How often each rule fired here, and how often a developer argued it away.
      </p>

      {fired.length === 0 ? (
        <p className="text-sm text-muted">No rule has fired in this project yet.</p>
      ) : (
        <ul className="space-y-3">
          {fired.map((rule) => (
            <li key={rule.rule_id} className="border-b border-line pb-3 last:border-0 last:pb-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs">{rule.rule_id}</span>
                {rule.flagged && (
                  <span className="rounded border border-block px-1.5 py-0.5 text-xs text-block">
                    dismissed {Math.round(rule.dismissal_rate * 100)}% of the time
                  </span>
                )}
              </div>
              <p className="mt-1 text-xs text-muted">
                fired {rule.fired}×, dismissed {rule.dismissed}×
              </p>
              {rule.reasons.length > 0 && (
                <ul className="mt-1.5 space-y-0.5">
                  {rule.reasons.map((reason, i) => (
                    <li key={i} className="text-xs text-muted">
                      “{reason}”
                    </li>
                  ))}
                </ul>
              )}
              {rule.flagged && (
                <AdoptConvention
                  slug={slug}
                  proposal={proposedConvention(
                    rule.rule_id,
                    textFor.get(rule.rule_id),
                    rule.reasons
                  )}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
