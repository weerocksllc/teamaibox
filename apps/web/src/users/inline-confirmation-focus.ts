/** Inline confirmation, not a modal: focus Cancel and restore its opener. */
export function focusInlineConfirmation(panel: HTMLElement) {
  const opener = panel.ownerDocument.activeElement as HTMLElement | null;
  panel.querySelector<HTMLButtonElement>("button")?.focus();
  return () => { if (opener?.isConnected) opener.focus(); };
}
