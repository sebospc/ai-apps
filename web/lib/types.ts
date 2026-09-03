export type Role = "lead" | "dev";
export type Severity = "critical" | "warning" | "suggestion" | "nitpick";

export type Me = {
  id: number;
  email: string;
  projects: { slug: string; name: string; role: Role }[];
};

export type ReviewSummary = {
  id: number;
  author: string;
  branch: string;
  title: string;
  status: string;
  blocking: boolean | null;
  created_at: string;
  counts: Partial<Record<Severity, number>>;
};

// What the developer decided about a finding, and what they said about it. Absent when nobody
// has answered it yet.
export type FindingAnswer = {
  disposition: "fixed" | "dismissed" | "accepted" | "confirmed_fixed";
  note: string;
  by: string;
  at: string;
};

export type Finding = {
  file: string;
  line: number | null;
  severity: Severity;
  rule_id: string;
  issue_type: string;
  message: string;
  suggestion: string | null;
  quoted_line: string | null;
  source: "rules" | "pmd" | "agent";
  suppressed: boolean;
  suppressed_reason: string | null;
  answer: FindingAnswer | null;
};

export type Step = {
  seq: number;
  kind: string;
  payload: Record<string, unknown>;
  at: string;
};

export type ReviewDetail = ReviewSummary & {
  verdict_reason: string;
  findings: Finding[];
  steps: Step[];
};

export type ProjectConfig = {
  ruleset: string;
  policy: { block_on: Severity; max_agent_findings: number };
  disabled_rules: string[];
  conventions: string;
  reviewer_prompt: string;
};

export type RuleHealth = {
  rule_id: string;
  fired: number;
  dismissed: number;
  dismissal_rate: number;
  flagged: boolean;
  reasons: string[];
};

export type ConfigResponse = {
  config: ProjectConfig;
  rulesets: string[];
  overlays: string[];
  role: Role;
  rules: { id: string; text: string; severity: Severity }[];
};

export type Member = { email: string; role: Role };
export type ApiKey = {
  id: number;
  name: string;
  user_email: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked: boolean;
};
