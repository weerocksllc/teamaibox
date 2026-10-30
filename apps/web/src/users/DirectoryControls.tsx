import { useState } from "react";

export type DirectoryPage = Readonly<{ offset: number; limit: number; total: number; hasMore: boolean }>;
type Translate = (key: string, values?: Record<string, string | number>) => string;

/** One bounded page is not an account limit: every matching account is reachable. */
export function DirectoryControls({ page, busy, onLoad, t }: {
  page: DirectoryPage | undefined; busy: boolean;
  onLoad: (offset: number, query: string) => Promise<void>; t: Translate;
}) {
  const [draft, setDraft] = useState(""), [query, setQuery] = useState("");
  return <div>
    <form className="identity-admin__search" role="search" aria-label={t("admin.users.search")} onSubmit={(event) => {
      event.preventDefault(); setQuery(draft.trim()); void onLoad(0, draft.trim());
    }}>
      <label>{t("admin.users.search")}<input type="search" value={draft} onChange={(event) => setDraft(event.target.value)} /></label>
      <button type="submit" disabled={busy}>{t("admin.users.search_action")}</button>
      {query && <button type="button" disabled={busy} onClick={() => {
        setDraft(""); setQuery(""); void onLoad(0, "");
      }}>{t("admin.users.clear_search")}</button>}
    </form>
    {page && <nav className="identity-admin__pagination" aria-label={t("admin.users.pages")}>
      <span role="status" aria-live="polite">{t("admin.users.range", {
        start: page.total ? page.offset + 1 : 0, end: Math.min(page.offset + page.limit, page.total), total: page.total,
      })}</span>
      <button type="button" disabled={busy || page.offset === 0} onClick={() => void onLoad(Math.max(0, page.offset - page.limit), query)}>{t("admin.users.previous")}</button>
      <button type="button" disabled={busy || !page.hasMore} onClick={() => void onLoad(page.offset + page.limit, query)}>{t("admin.users.next")}</button>
    </nav>}
    {page?.total === 0 && <p role="status">{t("admin.users.no_matches")}</p>}
  </div>;
}
