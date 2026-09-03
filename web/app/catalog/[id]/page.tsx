import { notFound } from "next/navigation";
import { ApiError, api } from "@/lib/api";
import type { CatalogEntry } from "@/lib/types";
import { Card, Header, Page } from "@/components/ui";

export default async function CatalogEntryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let entry: CatalogEntry;
  try {
    entry = await api<CatalogEntry>(`/catalog/${encodeURIComponent(id)}`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }

  const { ask, build, good, integration } = entry.detail;
  const versions = integration?.written_against;

  return (
    <Page>
      <Header title={entry.title} sub={entry.about} back={{ href: "/catalog", label: "Catalog" }} />

      <div className="space-y-8">
        <Section title="What the agent asks you" items={ask} />
        <Section title="How it is built" items={build} />
        <Section title="What good looks like" items={good} />

        {integration && (
          <section>
            <h2 className="mb-3 text-sm font-semibold">
              Integration
            </h2>
            <Card className="space-y-4">
              <Facts label="Extensions this adds" items={integration.extensions} />
              <Facts label="Goes in localextensions.xml" items={integration.localextensions} />
              <Facts label="Platform extensions required" items={integration.platform_extensions} />
              <Facts label="Item types" items={integration.item_types} />
              {versions && (
                <p className="text-sm text-muted">
                  Written against SAP Commerce {versions.sap_commerce ?? "—"}
                  {versions.spartacus && `, Spartacus ${versions.spartacus}`}.
                </p>
              )}
            </Card>
          </section>
        )}

        <p className="text-sm text-muted">
          Nothing on this page builds anything. Ask for this feature in your editor and the plugin
          applies it to the project you have open.
        </p>
      </div>
    </Page>
  );
}

function Section({ title, items }: { title: string; items?: string[] }) {
  if (!items?.length) return null;
  return (
    <section>
      <h2 className="mb-3 text-sm font-semibold">{title}</h2>
      <Card>
        <ul className="space-y-2 text-sm [&>li]:before:mr-2 [&>li]:before:text-muted [&>li]:before:content-['—']">
          {items.map((item) => (
            <li key={item} className="break-words">
              {item}
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}

/**
 * An empty list is an answer, not a gap: "this feature adds no extension" is exactly what a lead
 * reading `cost-center` needs to know. Printing nothing would read as a half-written entry.
 */
function Facts({ label, items }: { label: string; items?: string[] }) {
  if (!items) return null;
  return (
    <div className="text-sm">
      <p className="font-medium">{label}</p>
      <p className="mt-0.5 break-words text-muted">{items.length ? items.join(", ") : "None"}</p>
    </div>
  );
}
