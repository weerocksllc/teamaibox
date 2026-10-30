import { useId, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from "react";

export function Button({ variant = "secondary", busy = false, className = "", disabled, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "quiet" | "danger"; busy?: boolean }) {
  return <button type="button" {...props} disabled={disabled || busy} aria-busy={busy || undefined} className={`ui-button ui-button--${variant} ${className}`}>{children}</button>;
}

export function Panel({ className = "", ...props }: HTMLAttributes<HTMLElement>) {
  return <section {...props} className={`ui-panel ${className}`} />;
}

export function Status({ tone = "neutral", className = "", ...props }: HTMLAttributes<HTMLSpanElement> & { tone?: "neutral" | "success" | "warning" | "error" }) {
  return <span {...props} className={`ui-status ui-status--${tone} ${className}`} />;
}

// The caller owns values, validation and submission. No network or domain state here.
export function Field({ label, hint, error, children }: { label: ReactNode; hint?: ReactNode; error?: ReactNode; children: (attributes: { id: string; "aria-describedby"?: string; "aria-invalid"?: true }) => ReactNode }) {
  const id = useId();
  return <div className="ui-field"><label className="ui-field__label" htmlFor={id}>{label}</label>{children({ id, "aria-describedby": error || hint ? `${id}-feedback` : undefined, "aria-invalid": error ? true : undefined })}{(error || hint) && <p id={`${id}-feedback`} className={error ? "ui-field__error" : "ui-field__hint"} role={error ? "alert" : undefined}>{error || hint}</p>}</div>;
}
