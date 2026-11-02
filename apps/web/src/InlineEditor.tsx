import { type ReactNode } from "react";
import { EditorDialog } from "./EditorDialog";

/** Kept as an adapter so existing submit handlers and field validation stay intact. */
export function InlineEditor({ title, feedback, busy, cancelLabel, onCancel, children }: { title: string; feedback?: ReactNode; busy: boolean; cancelLabel: string; onCancel: () => void; children: ReactNode }) {
  return <EditorDialog title={title} closeLabel={cancelLabel} feedback={feedback} busy={busy} onCancel={onCancel}>
    <fieldset className="source-editor-fields" disabled={busy} aria-busy={busy}>{children}</fieldset>
    <button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>{cancelLabel}</button>
  </EditorDialog>;
}
