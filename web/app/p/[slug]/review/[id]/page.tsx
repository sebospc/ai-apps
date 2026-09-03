import { api } from "@/lib/api";
import type { Finding, FindingAnswer, ReviewDetail, Severity } from "@/lib/types";
import { Card, Header, Meta, Page, SeverityTag, Verdict } from "@/components/ui";

const ORDER: Record<Severity, number> = { critical: 0, warning: 1, suggestion: 2, nitpick: 3 };

const STEP_LABEL: Record<string, string> = {
  plan: "Server ran the deterministic rules and sent the plan",
  findings: "Agent submitted its findings",
  responses: "Developer answered the findings",
  verdict: "Server applied the project's policy",
};

// The developer's decision, said the way they would say it out loud. Nothing here names a
// disposition, a fingerprint or an id: those are Smith's words, not theirs.
const ANSWER_VERB: Record<FindingAnswer["disposition"], string> = {
  fixed: "fixed this",
  dismissed: "ruled this out",
  accepted: "accepted this",
  confirmed_fixed: "fixed this, and a later review confirmed it",
};

function answerSentence(answer: FindingAnswer): string {
  const said = `${answer.by} ${ANSWER_VERB[answer.disposition] ?? "answered this"} on ${answer.at}`;
  // "Reason recorded", not a colon and the words. What reaches us is what the developer's agent
  // wrote down for them, which with a short reason is the same sentence and with a careful one is
  // not. Printing it as a quotation puts a colleague's name on wording they may not have chosen.
  return answer.note ? `${said}. Reason recorded: ${answer.note}` : said;
}

export default async function ReviewPage({
  params,
}: {
  params: Promise<{ slug: string; id: string }>;
}) {
  const { slug, id } = await params;
  const review = await api<ReviewDetail>(`/projects/${slug}/reviews/${id}`);

  const active = review.findings
    .filter((f) => !f.suppressed)
    .sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
  const suppressed = review.findings.filter((f) => f.suppressed);

  return (
    <Page>
      <Header
        title={review.title || review.branch || `Review #${review.id}`}
        sub={
          <Meta className="text-sm">
            <span>#{review.id}</span>
            <span>{review.author}</span>
            <time dateTime={review.created_at}>
              {review.created_at.slice(0, 16).replace("T", " ")}
            </time>
          </Meta>
        }
        back={{ href: `/p/${slug}`, label: slug }}
        action={<Verdict blocking={review.blocking} />}
      />

      {review.verdict_reason && (
        <Card className="mb-8">
          <p className={review.blocking ? "text-block" : "text-pass"}>{review.verdict_reason}</p>
        </Card>
      )}

      <h2 className="mb-3 text-sm font-semibold">Findings</h2>
      {active.length === 0 ? (
        <p className="mb-8 text-sm text-muted">Nothing to report on this change.</p>
      ) : (
        <ul className="mb-8 space-y-2">
          {active.map((f, i) => (
            <li key={i}>
              <FindingCard finding={f} />
            </li>
          ))}
        </ul>
      )}

      {suppressed.length > 0 && (
        <details className="mb-8">
          <summary className="cursor-pointer text-sm text-muted">
            {suppressed.length} finding{suppressed.length === 1 ? "" : "s"} recorded but not counted
          </summary>
          <ul className="mt-2 space-y-2">
            {suppressed.map((f, i) => (
              <li key={i}>
                <FindingCard finding={f} />
              </li>
            ))}
          </ul>
        </details>
      )}

      <h2 className="mb-3 text-sm font-semibold">What happened</h2>
      <ol className="space-y-3 border-l border-line pl-5">
        {review.steps.map((s) => (
          <li key={s.seq} className="relative">
            <span className="absolute -left-[23px] top-1.5 size-1.5 rounded-full bg-muted" />
            <p className="text-sm">{STEP_LABEL[s.kind] ?? s.kind}</p>
            {/* One box per fact, so a wrap never splits a key from its value — and the keys are the
                payload's own, with the underscores taken out rather than a label map to keep in
                sync with whatever the server records next. */}
            <Meta className="mt-0.5 text-xs">
              <span>{s.at.slice(0, 19).replace("T", " ")}</span>
              {Object.entries(s.payload).map(([key, value]) => {
                const shown = payloadValue(value);
                return shown === null ? null : (
                  <span key={key}>
                    {key.replace(/_/g, " ")}: {shown}
                  </span>
                );
              })}
            </Meta>
          </li>
        ))}
      </ol>
    </Page>
  );
}

// A payload value with no one-line form is left out: "[object Object]" on a lead's screen is worse
// than saying nothing, and what a developer wrote is shown on the finding they wrote it about.
function payloadValue(value: unknown): string | null {
  if (Array.isArray(value)) {
    return value.some((item) => item !== null && typeof item === "object")
      ? null
      : value.join(", ");
  }
  return value !== null && typeof value === "object" ? null : String(value);
}

function FindingCard({ finding }: { finding: Finding }) {
  return (
    <Card className={finding.suppressed ? "opacity-60" : ""}>
      <div className="flex flex-wrap items-center gap-2">
        <SeverityTag severity={finding.severity} />
        <span className="font-mono text-xs text-muted">{finding.rule_id}</span>
        <span className="text-xs text-muted">via {finding.source}</span>
      </div>
      {/* A real path is `hybris/bin/custom/…/DefaultProductService.java` and has no spaces in it,
          so without break-all it runs off the side of a phone instead of wrapping. */}
      <p className="mt-2 break-all font-mono text-xs text-muted">
        {finding.file}
        {finding.line ? `:${finding.line}` : ""}
      </p>
      <p className="mt-1.5 text-sm">{finding.message}</p>
      {finding.quoted_line && (
        <pre className="mt-2 overflow-x-auto rounded border border-line px-3 py-2 text-xs">
          {finding.quoted_line}
        </pre>
      )}
      {finding.suggestion && <p className="mt-2 text-sm text-muted">{finding.suggestion}</p>}
      {finding.suppressed_reason && (
        <p className="mt-2 text-xs text-muted">Not counted: {finding.suppressed_reason}</p>
      )}
      {/* A muted finding's "Not counted" line is already built from this same answer, so repeating
          it there would say the same sentence twice on one card. */}
      {finding.answer && !finding.suppressed && (
        <p className="mt-2 text-xs text-muted">{answerSentence(finding.answer)}</p>
      )}
    </Card>
  );
}
