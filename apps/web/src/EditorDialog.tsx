import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "@teamaibox/ui-system/components";

/** Presentation only: existing forms own validation, submission and persistence. */
export function EditorDialog({ title, description, closeLabel, busy, onCancel, children, feedback }: {
  title: string; description?: string; closeLabel: string; busy: boolean; onCancel: () => void;
  children: ReactNode; feedback?: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const [opener] = useState(() => document.activeElement as HTMLElement | null);
  useLayoutEffect(() => {
    const node = dialog.current!;
    node.showModal();
    // The persistent close control must not steal the form's entry focus.
    const body = node.querySelector(".precision-editor__body");
    const firstField = body?.querySelector<HTMLElement>("input:not(:disabled):not([type=hidden]), select:not(:disabled), textarea:not(:disabled)");
    (firstField ?? body?.querySelector<HTMLElement>("button:not(:disabled)"))?.focus();
    return () => { node.close(); if (opener?.isConnected) opener.focus(); };
  }, [opener]);
  return <dialog ref={dialog} className="precision-editor" aria-labelledby={titleId}
    aria-describedby={description ? descriptionId : undefined} aria-busy={busy}
    onKeyDown={event => { if (event.key === "Escape") event.stopPropagation(); }}
    onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }}>
    <header className="precision-editor__heading"><div><h2 id={titleId}>{title}</h2>
      {description && <p id={descriptionId}>{description}</p>}</div>
      <Button variant="quiet" className="precision-editor__close" aria-label={closeLabel} disabled={busy} onClick={onCancel}><X size={20} aria-hidden="true" /></Button>
    </header>
    <div className="precision-editor__body">
      {feedback && <div className="precision-editor__feedback" role="status">{feedback}</div>}
      {children}
    </div>
  </dialog>;
}
