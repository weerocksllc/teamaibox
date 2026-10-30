/** Inline editors do not trap Tab, but must start at their first field. */
export function focusSourceForm(panel: HTMLElement) {
  const document = panel.ownerDocument;
  const opener = document.activeElement as HTMLElement | null;
  panel.querySelector<HTMLElement>("input:not(:disabled), select:not(:disabled)")?.focus();
  return () => {
    if (opener?.isConnected && (panel.contains(document.activeElement)
      || document.activeElement === document.body)) opener.focus();
  };
}
