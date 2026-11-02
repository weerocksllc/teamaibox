import { localizedCatalogs, productText } from "../../../../packages/ui-system/src/product-localization.mjs";
import { useEffect, useRef, useState } from "react";
import { RefreshCw, Search, Server, ShieldCheck } from "lucide-react";
import { loadPhoneAdministration, loadPhoneStorage, loadPhoneQuotas, setPhoneFeature, savePhoneQuota, PhoneAdministrationError,
  type PhoneAdministration, type PhoneQuota, type PhoneQuotaPage } from "./phone-administration-client";
import { phoneStoragePools, storageGiB } from "./phone-storage-summary.mjs";
import "./phone-administration.css";
import { EditorDialog } from "../EditorDialog";
import { PhoneUsbCameras } from "./PhoneUsbCameras";
import { PhoneNetworkCameras } from "./PhoneNetworkCameras";

const messages = localizedCatalogs({
  zh: {
    title: "虚拟手机管理", refresh: "刷新", loading: "正在读取手机服务状态…", failed: "暂时无法读取，请刷新重试。",
    access: "没有管理权限或登录已失效，请重新登录。", conflict: "设置已被修改，请刷新后重试。",
    deployment: "虚拟手机服务尚未就绪，暂时不能开放使用。", enabled: "允许新建和启动", disabled: "已暂停新建和启动",
    enable: "开启功能", disable: "暂停功能", saved: "设置已保存。", saving: "正在保存…", save: "保存额度",
    scope: "暂停功能或调低额度不会删除手机，也不会强制关机；已有手机仍可停止和删除。",
    privacy: "此处只管理资源和额度，不提供用户手机画面、文件或调试连接。",
    spec: "每部手机独立运行，应用与数据互相隔离",
    rom: "成员可用系统", romName: "Android 17 · AOSP", romHint: "标准 Android 不含 Google Play。各系统当前能否新建，请查看下方状态。",
    romReady: "可供新建", romDisabled: "尚未开放新建", romMissing: "此设备尚未安装该系统", experimental: "实验版", play: "含 Google Play", noPlay: "不含 Google Play",
    resources: "每部 6 GiB 内存 · 16 GiB 存储", details: "服务说明", updated: "读取于", notRead: "尚未读取",
    starting: "启动 / 处理中", unknown: "未知", node: "本机设备", nodeDetails: "设备详情", addressUnknown: "尚无已确认 IP",
    pool: "手机专用存储", poolTotal: "可用总容量", poolFree: "尚未使用", poolReserve: "系统余量", poolObserved: "容量记录时间",
    poolHint: "每部手机拥有独立磁盘，按实际写入使用物理空间；关机不会删除数据。",
    poolFailed: "暂时无法读取存储容量；这不代表硬盘已满。", storageManage: "查看存储", quotaManage: "调整用户额度",
    nodes: "本机容量", noNodes: "本机手机服务尚未配置完成，请先准备运行环境和存储。",
    nodeReady: "服务已配置，可用资源充足时可以开机", nodeUnavailable: "本机手机服务尚未就绪", storageUnavailable: "加密手机存储未就绪",
    nodeOther: "本机手机服务暂不可用", running: "运行中", limit: "同时运行容量", quota: "用户额度", search: "搜索用户姓名或账号", find: "搜索",
    user: "用户", stored: "已保存", currentRunning: "运行中", storedLimit: "可保存数量", runningLimit: "可同时运行", empty: "没有匹配的用户。",
    next: "下一页", first: "返回第一页", inactive: "已停用", edit: "调整额度", close: "取消", owner: "正在调整", resourceQuota: "按可用资源", maximum: "留空表示不设数量上限，0 表示不允许新增；实际开机数量由盒子的可用内存和存储决定。",
  },
  en: {
    title: "Virtual phone administration", refresh: "Refresh", loading: "Loading phone service…", failed: "Unable to load. Refresh to retry.",
    access: "Management permission or sign-in is no longer valid. Please sign in again.", conflict: "Settings changed. Refresh before retrying.",
    deployment: "The virtual phone service is not ready. Member access cannot be enabled yet.", enabled: "Creation and startup enabled", disabled: "Creation and startup paused",
    enable: "Enable feature", disable: "Pause feature", saved: "Settings saved.", saving: "Saving…", save: "Save quota",
    scope: "Pausing or reducing quotas does not delete or shut down phones. Existing phones can still be stopped and deleted.",
    privacy: "Resource management does not grant access to users’ screens, files, or debug connections.",
    spec: "Independent phones with separate apps and data",
    rom: "Member system", romName: "Android 17 · AOSP", romHint: "Standard Android does not include Google Play. Availability for new phones is shown below for each system.",
    romReady: "Available to create", romDisabled: "Creation not enabled", romMissing: "This system is not installed on the appliance", experimental: "Experimental", play: "Google Play included", noPlay: "No Google Play",
    resources: "6 GiB RAM · 16 GiB storage per phone", details: "Service details", updated: "Read at", notRead: "Not loaded",
    starting: "Starting / in progress", unknown: "Unknown", node: "This device", nodeDetails: "Device details", addressUnknown: "No confirmed IP",
    pool: "Phone storage pool", poolTotal: "Usable capacity", poolFree: "Unused", poolReserve: "System margin", poolObserved: "Capacity observed at",
    poolHint: "Independent phones with separate apps and data",
    poolFailed: "Storage capacity could not be read. This does not mean the disk is full.", storageManage: "View storage", quotaManage: "Edit user quotas",
    nodes: "Device capacity", noNodes: "Prepare the phone runtime and storage on this appliance.",
    nodeReady: "Configured; phones can start when resources are available", nodeUnavailable: "Local phone service is not ready", storageUnavailable: "Encrypted phone storage unavailable",
    nodeOther: "Local phone service unavailable", running: "Running", limit: "Concurrent capacity", quota: "User quotas", search: "Search name or login", find: "Search",
    user: "User", stored: "Saved", currentRunning: "Running", storedLimit: "Saved phone limit", runningLimit: "Running phone limit", empty: "No matching users.",
    next: "Next page", first: "First page", inactive: "Inactive", edit: "Edit quota", close: "Cancel", owner: "Editing", resourceQuota: "Available resources", maximum: "Leave blank for no count limit; zero prevents new allocations. Starting phones requires available memory and storage.",
  },
});
export function PhoneAdministrationPanel({ locale, canManage, canViewStorage = false }: { locale: string; canManage: boolean; canViewStorage?: boolean }) {
  const text = messages[locale];
  const [data, setData] = useState<PhoneAdministration | null>(null), [page, setPage] = useState<PhoneQuotaPage | null>(null);
  const [search, setSearch] = useState(""), [appliedSearch, setAppliedSearch] = useState(""), [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [notice, setNotice] = useState<string | null>(null);
  const [edit, setEdit] = useState<PhoneQuota | null>(null), [quotaError, setQuotaError] = useState(false);
  const [readAt, setReadAt] = useState<Date | null>(null);
  const [pools, setPools] = useState<unknown[] | null>(null);
  const lifetime = useRef<AbortController | null>(null), sequence = useRef(0);
  const failure = (error: unknown) => error instanceof PhoneAdministrationError && [401, 403].includes(error.status) ? text.access
    : error instanceof PhoneAdministrationError && error.code === "phone_state_conflict" ? text.conflict : text.failed;
  async function refresh(nextSearch = appliedSearch, after = cursor, clearNotice = true) {
    const signal = lifetime.current?.signal; if (!signal || signal.aborted) return;
    const current = ++sequence.current; setLoading(true); if (clearNotice) setNotice(null);
    try {
      const [administration, quotas, storage] = await Promise.all([loadPhoneAdministration(signal), loadPhoneQuotas(nextSearch, after, signal),
        canViewStorage ? loadPhoneStorage(signal).catch(() => null) : Promise.resolve(null)]);
      if (signal.aborted || current !== sequence.current) return;
      setData(administration); setPage(quotas); setAppliedSearch(nextSearch); setCursor(after); setEdit(null); setReadAt(new Date());
      setPools(storage?.pools ?? null);
      return true;
    } catch (error) { if (!signal.aborted && current === sequence.current) { setNotice(failure(error)); setData(null); setPage(null); } }
    finally { if (!signal.aborted && current === sequence.current) setLoading(false); }
  }
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    if (canManage) void refresh("", null); else { setData(null); setPage(null); setPools(null); setEdit(null); setLoading(false); setNotice(text.access); }
    return () => { controller.abort(); sequence.current++; };
  }, [canManage, canViewStorage]);
  async function mutate(kind: "feature" | "quota") {
    const signal = lifetime.current?.signal;
    if (!data || !signal || signal.aborted || !canManage || busy) return;
    setBusy(true); setNotice(null);
    try {
      if (kind === "feature") await setPhoneFeature(!data.policy.enabled, data.policy.revision, signal);
      else if (edit) await savePhoneQuota(edit, signal);
      if (!signal.aborted && await refresh(appliedSearch, cursor, false)) setNotice(text.saved);
    } catch (error) { if (!signal.aborted) setNotice(failure(error)); }
    finally { if (!signal.aborted) setBusy(false); }
  }
  const reason = (code: string | null) => code === null ? text.nodeReady : code === "phone_storage_unavailable" ? text.storageUnavailable
    : code === "phone_node_unavailable" ? text.nodeUnavailable : text.nodeOther;
  const device = data?.nodes.length === 1 ? data.nodes[0] : null;
  const count = (value: number | null | undefined) => Number.isSafeInteger(value) && Number(value) >= 0 ? value : "—";
  return <section className="phone-admin" aria-label={text.title}>
    <header className="phone-admin-header phone-admin-toolbar"><span className="phone-admin-muted">{text.updated} {readAt ? readAt.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : text.notRead}</span>
      <button type="button" className="secondary-button" disabled={!canManage || loading || busy} onClick={() => void refresh()}><RefreshCw size={15} aria-hidden="true" />{text.refresh}</button></header>
    {notice && <p role="status" className="phone-admin-notice">{notice}</p>}
    {loading && <p role="status" aria-busy="true">{text.loading}</p>}
    {data && canManage && <>
      <section className="phone-admin-card phone-admin-overview"><div className="phone-admin-header"><h2 className="phone-admin-state"><i className={data.policy.enabled && data.deploymentReady ? "is-ready" : ""} />{data.policy.enabled ? text.enabled : text.disabled}</h2>
        <button type="button" className="secondary-button" disabled={busy || loading || !canManage || (!data.policy.enabled && !data.deploymentReady)} onClick={() => void mutate("feature")}>{busy ? text.saving : data.policy.enabled ? text.disable : text.enable}</button></div>
        {!data.deploymentReady && <p className="phone-admin-notice">{text.deployment}</p>}
        <p className="phone-admin-muted">{text.scope}</p></section>
      <div className="phone-admin-grid">
      <section className="phone-admin-card"><h2>{text.nodes}</h2>{!device ? <p>{text.noNodes}</p> : <ul className="phone-admin-nodes">{[device].map(node => <li key={node.nodeId}>
        <div className="phone-admin-node-name"><Server size={20} aria-hidden="true" /><div><strong>{node.nodeName && !/^managed-[0-9a-f-]{36}$/i.test(node.nodeName) ? node.nodeName : text.node}</strong><small>{node.address || text.addressUnknown}</small></div></div>
        <p className="phone-admin-muted">{reason(node.reasonCode)}</p>
        <dl className="phone-admin-metrics"><div><dt>{text.running}</dt><dd>{count(node.runningCount)}</dd></div><div><dt>{text.starting}</dt><dd>{count(node.startingCount)}</dd></div></dl>
        {canViewStorage && (pools === null ? <p className="phone-admin-muted">{text.poolFailed}</p> : phoneStoragePools(pools, node.nodeId).map(pool => <section className="phone-admin-storage" key={pool.poolId} aria-label={text.pool}>
          <h3>{text.pool}</h3><dl className="phone-admin-storage-metrics"><div><dt>{text.poolTotal}</dt><dd>{storageGiB(pool.totalBytes, locale)}</dd></div><div><dt>{text.poolFree}</dt><dd>{storageGiB(pool.availableBytes, locale)}</dd></div></dl>
          <p className="phone-admin-muted">{text.poolHint}</p><small>{text.poolObserved} {pool.observedAt ? new Date(pool.observedAt).toLocaleString(locale) : text.unknown}</small>
          <div className="phone-admin-actions"><a href="/admin/storage">{text.storageManage}</a><a href="#phone-user-quotas">{text.quotaManage}</a></div>
        </section>))}
        <PhoneUsbCameras nodeId={node.nodeId} locale={locale} />
        <PhoneNetworkCameras nodeId={node.nodeId} locale={locale} />
        <details className="phone-admin-details"><summary>{text.nodeDetails}</summary><code>{node.nodeId}</code><p>{text.updated} {node.observedAt && Number.isFinite(Date.parse(node.observedAt)) ? new Date(node.observedAt).toLocaleString(locale) : text.unknown}</p></details>
      </li>)}</ul>}</section>
      <section className="phone-admin-card phone-admin-rom"><h2>{text.rom}</h2>{[false, true].map(googlePlay => {
        const releases = data.roms?.filter(rom => rom.googlePlay === googlePlay) ?? [];
        const enabled = releases.filter(rom => rom.createEnabled);
        const ready = enabled.some(rom => !rom.reasonCode);
        return <article key={String(googlePlay)} className="phone-admin-rom-entry">
          <h3>{googlePlay ? "Android + Google Play" : productText(locale, "Standard Android", "标准 Android")}</h3>
          <p className="phone-admin-muted">{googlePlay ? text.play : text.noPlay}</p>
          <p>{!data.roms ? text.unknown : !enabled.length ? text.romDisabled : ready ? text.romReady : text.romMissing}</p>
          {enabled.some(rom => rom.experimental) && <span className="phone-admin-tag">{text.experimental}</span>}
        </article>;
      })}<p className="phone-admin-muted">{text.spec}</p></section>
      </div>
      <section className="phone-admin-card" id="phone-user-quotas"><h2>{text.quota}</h2><p className="phone-admin-privacy"><ShieldCheck size={16} aria-hidden="true" />{text.privacy}</p>
        <form className="phone-admin-search" onSubmit={event => { event.preventDefault(); void refresh(search, null); }}><label><span className="sr-only">{text.search}</span><input type="search" placeholder={text.search} value={search} disabled={busy || loading} onChange={event => setSearch(event.target.value)} /></label>
          <button type="submit" className="secondary-button" disabled={busy || loading}><Search size={15} aria-hidden="true" />{text.find}</button></form>
        {edit && <EditorDialog closeLabel={text.close} title={text.edit} description={`${text.owner} ${edit.displayName} (@${edit.loginName})`} busy={busy} onCancel={() => setEdit(null)} feedback={notice}><form className="phone-admin-editor" onSubmit={event => { event.preventDefault(); if (!quotaError) void mutate("quota"); }}><p className="precision-editor__hint">{productText(locale, "Changes take effect only after saving.", "修改仅在保存后生效。")}</p>
          <div className="phone-admin-fields">{(["storedPerUser", "runningPerUser"] as const).map(key => <label key={key}><span>{key === "storedPerUser" ? text.storedLimit : text.runningLimit}</span><input type="number" min={0} max={key === "storedPerUser" ? 2 ** 31 - 1 : edit.storedPerUser ?? 2 ** 31 - 1} step={1} disabled={busy} placeholder={text.resourceQuota}
            value={edit[key] === null || Number.isNaN(edit[key]) ? "" : edit[key]} onChange={event => { const next = { ...edit, [key]: event.target.value === "" ? null : event.target.valueAsNumber }; setEdit(next); setQuotaError([next.storedPerUser, next.runningPerUser].some(value => value !== null && (!Number.isInteger(value) || value < 0 || value > 2 ** 31 - 1)) || next.storedPerUser !== null && next.runningPerUser !== null && next.runningPerUser > next.storedPerUser); }} /></label>)}</div>
          <p>{text.maximum}</p><div className="phone-admin-actions"><button className="primary-button" type="submit" disabled={busy || quotaError}>{busy ? text.saving : text.save}</button><button type="button" className="secondary-button" disabled={busy} onClick={() => setEdit(null)}>{text.close}</button></div></form></EditorDialog>}
        {page && <><div className="phone-admin-table"><table><thead><tr><th>{text.user}</th><th>{text.stored}</th><th>{text.currentRunning}</th><th>{text.edit}</th></tr></thead><tbody>{page.data.map(user => <tr key={user.ownerId}>
          <td><strong>{user.displayName}</strong><small>@{user.loginName}{user.status !== "active" ? ` · ${text.inactive}` : ""}</small></td><td>{user.stored} / {user.storedPerUser ?? text.resourceQuota}</td><td>{user.running} / {user.runningPerUser ?? text.resourceQuota}</td>
          <td><button type="button" className="secondary-button" disabled={busy || loading} onClick={() => { setEdit({ ...user }); setQuotaError(false); }}>{text.edit}<span className="sr-only"> {user.displayName}</span></button></td></tr>)}</tbody></table></div>
          {page.data.length === 0 && <p>{text.empty}</p>}<div className="phone-admin-actions">{cursor && <button type="button" className="secondary-button" disabled={busy || loading} onClick={() => void refresh(appliedSearch, null)}>{text.first}</button>}
          {page.nextCursor && <button type="button" className="secondary-button" disabled={busy || loading} onClick={() => void refresh(appliedSearch, page.nextCursor)}>{text.next}</button>}</div></>}
      </section>
    </>}
  </section>;
}
