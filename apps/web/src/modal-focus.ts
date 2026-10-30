/** Move into a non-modal popover, restoring focus only if it did not move elsewhere. */
export function focusPopover(panel: HTMLElement) {
  const document = panel.ownerDocument;
  const opener = document.activeElement as HTMLElement | null;
  (panel.querySelector<HTMLElement>('button:not(:disabled)') ?? panel).focus();
  return () => {
    if (opener?.isConnected && (document.activeElement === document.body
      || panel.contains(document.activeElement))) opener.focus();
  };
}

/** Keep keyboard focus inside a mounted modal and restore its opener on close. */
export function containModalFocus(panel: HTMLElement) {
  const document = panel.ownerDocument;
  const opener = document.activeElement as HTMLElement | null;
  const items = () => Array.from(panel.querySelectorAll<HTMLElement>(
    'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
  )).filter((element) => element.tabIndex >= 0 && element.getClientRects().length > 0);
  const focusFirst = () => (items()[0] ?? panel).focus();
  const onFocus = (event: FocusEvent) => {
    if (!panel.contains(event.target as Node)) focusFirst();
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== 'Tab') return;
    const focusable = items();
    const first = focusable[0], last = focusable.at(-1);
    if (!first || !panel.contains(document.activeElement)) {
      event.preventDefault(); focusFirst();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault(); last!.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault(); first.focus();
    }
  };
  document.addEventListener('keydown', onKey);
  document.addEventListener('focusin', onFocus);
  focusFirst();
  return () => {
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('focusin', onFocus);
    if (opener?.isConnected) opener.focus();
  };
}
