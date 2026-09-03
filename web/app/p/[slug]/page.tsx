import Link from "next/link";
import { api } from "@/lib/api";
import type { ReviewSummary, Role, Severity } from "@/lib/types";
import { Card, Empty, Header, Meta, Page, SeverityTag, Verdict } from "@/components/ui";

const ORDER: Severity[] = ["critical", "warning", "suggestion", "nitpick"];

export default async function ProjectReviews({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ author?: string }>;
}) {
  const { slug } = await params;
  const { author } = await searchParams;
  const query = author ? `?author=${encodeURIComponent(author)}` : "";
  // The filter the API actually applied, not the one the URL asked for: a developer's list is
  // always their own, so the header must never name someone else over their reviews.
  const data = await api<{ role: Role; author: string | null; reviews: ReviewSummary[] }>(
    `/projects/${slug}/reviews${query}`
  );

  return (
    <Page>
      <Header
        title={slug}
        sub={
          data.author
            ? `Reviews by ${data.author}.`
            : data.role === "lead"
              ? "Every review in this project."
              : "Your reviews."
        }
        back={
          data.author
            ? { href: `/p/${slug}`, label: "All reviews" }
            : { href: "/", label: "Projects" }
        }
        action={
          data.role === "lead" ? (
            <Link href={`/p/${slug}/settings`} className="text-sm text-muted hover:text-ink">
              Settings
            </Link>
          ) : null
        }
      />

      {data.reviews.length === 0 ? (
        <Empty>
          {data.author
            ? `No reviews from ${data.author} yet.`
            : "No reviews yet. Ask your editor's agent for a Smith review."}
        </Empty>
      ) : (
        <ul className="space-y-2">
          {data.reviews.map((r) => (
            <li key={r.id}>
              <Card className="relative transition-colors hover:border-ink/30">
                <div className="flex items-baseline justify-between gap-4">
                  {/* The link stretches over the whole card, so the author beside it stays a link
                      of its own instead of an anchor nested inside another one. */}
                  <Link
                    href={`/p/${slug}/review/${r.id}`}
                    className="truncate font-medium after:absolute after:inset-0"
                  >
                    {r.title || r.branch || `Review #${r.id}`}
                  </Link>
                  <Verdict blocking={r.blocking} />
                </div>
                <Meta className="mt-2 text-sm">
                  <span>#{r.id}</span>
                  {data.role === "lead" && !data.author ? (
                    <Link
                      href={`/p/${slug}?author=${encodeURIComponent(r.author)}`}
                      className="relative hover:text-ink hover:underline"
                    >
                      {r.author}
                    </Link>
                  ) : (
                    <span>{r.author}</span>
                  )}
                  {r.branch && <span className="font-mono text-xs">{r.branch}</span>}
                  <time dateTime={r.created_at}>{r.created_at.slice(0, 16).replace("T", " ")}</time>
                </Meta>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {ORDER.filter((s) => r.counts[s]).map((s) => (
                    <SeverityTag key={s} severity={s} count={r.counts[s]} />
                  ))}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}
