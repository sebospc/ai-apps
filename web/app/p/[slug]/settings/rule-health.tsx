import { Card } from "@/components/ui";
import type { RuleHealth } from "@/lib/types";

/**
 * What the team argues with, most-dismissed first.
 *
 * Smith reports and changes nothing: a tool that quietly switches off its own rules cannot be
 * trusted about the rules it leaves on. Switching one off is in the form above, and it is the
 * lead's decision.
 */
export function RuleHealthPanel({ rules }: { rules: RuleHealth[] }) {
  const fired = rules.filter((r) => r.fired > 0);

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
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
