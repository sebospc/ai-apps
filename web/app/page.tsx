import Link from "next/link";
import { api } from "@/lib/api";
import type { Me } from "@/lib/types";
import { Card, Empty, Header, Page } from "@/components/ui";
import { logout } from "@/app/actions";
import { NewProjectForm } from "./new-project-form";

export default async function ProjectsPage() {
  const me = await api<Me>("/auth/me");

  return (
    <Page>
      <Header
        title="Projects"
        sub={me.email}
        action={
          <div className="flex items-center gap-4">
            <Link href="/catalog" className="text-sm text-muted hover:text-ink">
              Catalog
            </Link>
            <form action={logout}>
              <button className="text-sm text-muted hover:text-ink">Sign out</button>
            </form>
          </div>
        }
      />

      {me.projects.length === 0 ? (
        <Empty>You are not on any project yet.</Empty>
      ) : (
        <ul className="space-y-2">
          {me.projects.map((p) => (
            <li key={p.slug}>
              <Link href={`/p/${p.slug}`} className="block">
                <Card className="flex items-center justify-between transition-colors hover:border-ink/30">
                  <div>
                    <p className="font-medium">{p.name}</p>
                    <p className="text-sm text-muted">{p.slug}</p>
                  </div>
                  <span className="text-xs uppercase tracking-wide text-muted">{p.role}</span>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-10">
        <NewProjectForm />
      </div>
    </Page>
  );
}
