import Link from "next/link";
import type { Severity } from "@/lib/types";

/* Five primitives, ~70 lines. A component library would be five dependencies for the same thing. */

export function Page({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto w-full max-w-5xl px-6 py-10">{children}</main>;
}

export function Header({
  title,
  sub,
  back,
  action,
}: {
  title: string;
  sub?: React.ReactNode;
  back?: { href: string; label: string };
  action?: React.ReactNode;
}) {
  return (
    <header className="mb-8">
      {back && (
        <Link href={back.href} className="text-sm text-muted hover:text-ink">
          ← {back.label}
        </Link>
      )}
      <div className="mt-1 flex items-baseline justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {action}
      </div>
      {/* A div, not a p: the sub is sometimes a Meta row, and a div inside a p is not valid HTML. */}
      {sub && <div className="mt-1 text-sm text-muted">{sub}</div>}
    </header>
  );
}

/**
 * A row of facts separated by dots.
 *
 * The dot is drawn before each item instead of standing between them as a box of its own, so a row
 * that wraps takes the separator down with the item that follows it. Free-floating separators leave
 * a dot dangling at the end of the line they wrapped on, which is what a phone showed.
 */
export function Meta({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex flex-wrap items-center gap-x-2 gap-y-0.5 text-muted [&>*+*]:before:mr-2 [&>*+*]:before:content-['·'] ${className}`}
    >
      {children}
    </div>
  );
}

export function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-lg border border-line bg-surface p-5 ${className}`}>{children}</section>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="rounded-lg border border-dashed border-line px-5 py-8 text-center text-sm text-muted">{children}</p>;
}

const SEVERITY_STYLE: Record<Severity, string> = {
  critical: "border-block/40 text-block",
  warning: "border-amber-500/40 text-amber-400",
  suggestion: "border-line text-muted",
  nitpick: "border-line text-muted",
};

export function SeverityTag({ severity, count }: { severity: Severity; count?: number }) {
  return (
    <span className={`rounded border px-1.5 py-0.5 text-xs font-medium ${SEVERITY_STYLE[severity]}`}>
      {count === undefined ? severity : `${count} ${severity}`}
    </span>
  );
}

export function Verdict({ blocking }: { blocking: boolean | null }) {
  // Same weight as BLOCKED and CLEAR: three states of one badge should not read as three controls.
  if (blocking === null) return <span className="text-xs font-semibold text-muted">in progress</span>;
  return (
    <span className={`text-xs font-semibold ${blocking ? "text-block" : "text-pass"}`}>
      {blocking ? "BLOCKED" : "CLEAR"}
    </span>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium">{label}</span>
      {hint && <span className="ml-2 text-xs text-muted">{hint}</span>}
      <div className="mt-1.5">{children}</div>
    </label>
  );
}

export const inputClass =
  "w-full rounded-md border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-ink/40";

export const buttonClass =
  "rounded-md border border-line bg-surface px-3 py-2 text-sm font-medium hover:border-ink/40 disabled:opacity-50";
