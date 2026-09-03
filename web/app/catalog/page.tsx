import Link from "next/link";
import { api } from "@/lib/api";
import type { CatalogSummary } from "@/lib/types";
import { Card, Empty, Header, Page } from "@/components/ui";

export default async function CatalogPage() {
  const { entries } = await api<{ entries: CatalogSummary[] }>("/catalog");

  return (
    <Page>
      <Header
        title="Catalog"
        sub="Features Smith knows how to build. Reading only — to apply one, ask for it in your editor."
        back={{ href: "/", label: "Projects" }}
      />

      {entries.length === 0 ? (
        <Empty>The catalog is empty.</Empty>
      ) : (
        <ul className="space-y-2">
          {entries.map((entry) => (
            <li key={entry.id}>
              <Link href={`/catalog/${entry.id}`} className="block">
                <Card className="transition-colors hover:border-ink/30">
                  <p className="font-medium">{entry.title}</p>
                  <p className="mt-1 text-sm text-muted">{entry.about}</p>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}
