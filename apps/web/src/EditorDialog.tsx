import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

/** Presentation only: existing forms own validation, submission and persistence. */
export function EditorDialog({ title, description, busy, onCancel, children, feedback }: {
  title: string; description?: string; busy: boolean; onCancel: () => void;
  children: ReactNode; feedback?: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const [opener] = useState(() => document.activeElement as HTMLElement | null);
  useLayoutEffect(() => {
    const node = dialog.current!;
    node.showModal();
    return () => { node.close(); if (opener?.isConnected) opener.focus(); };
  }, [opener]);
  return <dialog ref={dialog} className="precision-editor" aria-labelledby={titleId}
    aria-describedby={description ? descriptionId : undefined} aria-busy={busy}
    onKeyDown={event => { if (event.key === "Escape") event.stopPropagation(); }}
    onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }}>
    <header className="precision-editor__heading"><h2 id={titleId}>{title}</h2>
      {description && <p id={descriptionId}>{description}</p>}
    </header>
    {feedback && <div className="precision-editor__feedback" role="status">{feedback}</div>}
    {children}
  </dialog>;
}
