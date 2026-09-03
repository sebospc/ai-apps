import { api } from "@/lib/api";
import type { ApiKey, ConfigResponse, Member, RuleHealth } from "@/lib/types";
import { Header, Page } from "@/components/ui";
import { ConfigForm } from "./config-form";
import { RuleHealthPanel } from "./rule-health";
import { DangerPanel, KeysPanel, MembersPanel } from "./team";

export default async function SettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  // Three independent reads; the API enforces lead-only on each one regardless of what the UI shows.
  const [config, members, keys, health] = await Promise.all([
    api<ConfigResponse>(`/projects/${slug}/config`),
    api<{ members: Member[] }>(`/projects/${slug}/members`),
    api<{ keys: ApiKey[] }>(`/projects/${slug}/keys`),
    api<{ rules: RuleHealth[] }>(`/projects/${slug}/rules/health`),
  ]);

  return (
    <Page>
      <Header
        title="Settings"
        sub={`How reviews run for ${slug}, and who can run them.`}
        back={{ href: `/p/${slug}`, label: slug }}
      />

      <div className="space-y-8">
        <ConfigForm slug={slug} data={config} />
        <RuleHealthPanel rules={health.rules} />
        <MembersPanel slug={slug} members={members.members} />
        <KeysPanel slug={slug} keys={keys.keys} members={members.members} />
        <DangerPanel slug={slug} />
      </div>
    </Page>
  );
}
