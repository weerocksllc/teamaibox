import { productText } from "../../../../packages/ui-system/src/product-localization.mjs";
import { useEffect, useRef, useState } from "react";
import { loadPhoneNetworkCameras, savePhoneNetworkCamera, loadPhoneQuotas, PhoneAdministrationError,
  type PhoneNetworkCamera, type PhoneQuotaPage } from "./phone-administration-client";

export function PhoneNetworkCameras({ nodeId, locale }: { nodeId: string; locale: string }) {
  const [open, setOpen] = useState(false), [items, setItems] = useState<PhoneNetworkCamera[] | null>(null);
  const [addresses, setAddresses] = useState<string[]>([]), [editing, setEditing] = useState<PhoneNetworkCamera | null>(null);
  const [page, setPage] = useState<PhoneQuotaPage | null>(null), [search, setSearch] = useState(""), [applied, setApplied] = useState("");
  const [sources, setSources] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(false), [reload, setReload] = useState(0);
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => { const controller = new AbortController(); lifetime.current = controller; return () => controller.abort(); }, [nodeId]);
  const errorText = (error: unknown) => {
    const code = error instanceof PhoneAdministrationError ? error.code : "";
    if (code === "phone_state_conflict") return productText(locale, "Settings changed. Refresh and retry.", "设置已变化，请刷新后重试。");
    if (code === "phone_input_invalid") return productText(locale, "Check name, port and source IP/CIDR, e.g. 192.168.10.8/32.", "请检查名称、端口和来源地址；每个来源须填写 IP/掩码，例如 192.168.10.8/32。");
    if (code === "phone_camera_udp_busy") return productText(locale, "This port is already configured. Edit its input or choose another port.", "此端口已有配置，请编辑原入口或选择另一个端口。");
    return productText(locale, "Cannot read or save stream settings. Check the node and retry.", "无法读取或保存推流设置，请检查盒子连接后重试。");
  };
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController(); setBusy(true); setNotice(""); setEditing(null);
    loadPhoneNetworkCameras(nodeId, controller.signal).then(value => {
      if (!controller.signal.aborted) { setItems(value.data); setAddresses(value.addresses); }
    }).catch(error => { if (!controller.signal.aborted) { setItems(null); setNotice(errorText(error)); } })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [open, nodeId, reload]);
  async function users(query: string, after: string | null = null) {
    const controller = lifetime.current; if (!controller || controller.signal.aborted) return;
    setBusy(true);
    try { const value = await loadPhoneQuotas(query, after, controller.signal); if (!controller.signal.aborted) { setPage(value); setApplied(query); } }
    catch (error) { if (!controller.signal.aborted) setNotice(errorText(error)); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  function edit(camera: PhoneNetworkCamera) {
    setEditing({ ...camera, ownerIds: [...camera.ownerIds] }); setSources(camera.allowedSources.join("\n")); setSearch(""); setPage(null); void users("");
  }
  async function save() {
    const controller = lifetime.current; if (!editing || busy || !controller || controller.signal.aborted) return;
    setBusy(true); setNotice("");
    try {
      await savePhoneNetworkCamera(nodeId, { ...editing, allowedSources: sources.split(/[\s,]+/).filter(Boolean) }, controller.signal);
      if (!controller.signal.aborted) { setEditing(null); setReload(n => n + 1); }
    } catch (error) { if (!controller.signal.aborted) setNotice(errorText(error)); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  return <details className="phone-admin-usb phone-admin-network" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{productText(locale, "Network camera inputs", "网络摄像头入口")}</summary>
    <p className="phone-admin-muted">{productText(locale, "Configure UDP ports and permitted senders for phones on this box. External streams are unencrypted; video only. Each input serves one phone at a time.", "为这台盒子上的手机配置 UDP 推流端口和允许的来源。外部推流不加密；仅传画面，不接收麦克风。每个入口同时供一部手机使用。")}</p>
    {notice && <p role="status">{notice}</p>}{busy && <p role="status">{productText(locale, "Working…", "正在处理…")}</p>}
    <div className="phone-admin-actions">
      <button type="button" className="secondary-button" disabled={busy} onClick={() => setReload(n => n + 1)}>{productText(locale, "Refresh", "刷新")}</button>
      <button type="button" className="secondary-button" disabled={busy || !items || !addresses.length} onClick={() => edit({ id: crypto.randomUUID(), name: "", enabled: true, revision: 0, ownerIds: [], listenAddress: addresses[0], listenPort: 24100, allowedSources: [], externalInputEncrypted: false })}>{productText(locale, "Add stream input", "添加推流入口")}</button>
    </div>
    {items?.length === 0 && <p>{productText(locale, "No stream inputs configured. Permitted users can select them in phone camera settings.", "尚未配置推流入口。配置后，获准用户可在手机的摄像头设置中选择。")}</p>}
    {items?.map(camera => <div className="phone-admin-usb-device" key={camera.id}>
      <div><strong>{camera.name}</strong><p className="phone-admin-muted">{camera.listenAddress}:{camera.listenPort} · {camera.enabled ? (productText(locale, "Enabled", "已启用")) : (productText(locale, "Disabled", "已停用"))}</p></div>
      <button type="button" className="secondary-button" disabled={busy} onClick={() => edit(camera)}>{productText(locale, "Settings", "设置")}</button>
    </div>)}
    {editing && <form className="phone-admin-editor" onSubmit={event => { event.preventDefault(); void save(); }}>
      <label>{productText(locale, "Input name", "入口名称")}<input required value={editing.name} disabled={busy} onChange={e => setEditing({ ...editing, name: e.target.value })} /></label>
      <label>{productText(locale, "Box address", "盒子地址")}<select value={editing.listenAddress} disabled={busy} onChange={e => setEditing({ ...editing, listenAddress: e.target.value })}>{[...new Set([...addresses, editing.listenAddress])].filter(Boolean).map(a => <option key={a}>{a}</option>)}</select></label>
      <label>{productText(locale, "UDP port", "UDP 端口")}<input required type="number" min={1024} max={65535} step={1} value={editing.listenPort} disabled={busy} onChange={e => setEditing({ ...editing, listenPort: Number(e.target.value) })} /></label>
      <label>{productText(locale, "Allowed sender IP/CIDR (one per line)", "允许推流的 IP/网段（每行一个）")}<textarea required value={sources} disabled={busy} placeholder="192.168.10.8/32" onChange={e => setSources(e.target.value)} /></label>
      <label className="phone-admin-check"><input type="checkbox" checked={editing.enabled} disabled={busy} onChange={e => setEditing({ ...editing, enabled: e.target.checked })} />{productText(locale, "Enable input; disabling or changing settings stops active input", "启用入口；关闭或修改配置会停止当前输入")}</label>
      <div className="phone-admin-search"><label><span className="sr-only">{productText(locale, "Search users", "搜索用户")}</span><input type="search" value={search} disabled={busy} placeholder={productText(locale, "Search users", "搜索用户姓名或账号")} onChange={e => setSearch(e.target.value)} /></label><button type="button" className="secondary-button" disabled={busy} onClick={() => void users(search)}>{productText(locale, "Search", "搜索")}</button></div>
      <p className="phone-admin-muted">{productText(locale, "{v0} selected; search and pagination preserve selections.", "已选择 {v0} 人；搜索和翻页不会清除选择。", {v0: editing.ownerIds.length})}</p>
      <div className="phone-admin-user-checks">{page?.data.map(user => <label className="phone-admin-check" key={user.ownerId}><input type="checkbox" disabled={busy || user.status !== "active" && !editing.ownerIds.includes(user.ownerId)} checked={editing.ownerIds.includes(user.ownerId)} onChange={e => setEditing({ ...editing, ownerIds: e.target.checked ? [...editing.ownerIds, user.ownerId] : editing.ownerIds.filter(id => id !== user.ownerId) })} />{user.displayName} (@{user.loginName})</label>)}</div>
      <div className="phone-admin-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => void users(applied)}>{productText(locale, "First page", "第一页")}</button>{page?.nextCursor && <button type="button" className="secondary-button" disabled={busy} onClick={() => void users(applied, page.nextCursor)}>{productText(locale, "Next page", "下一页")}</button>}</div>
      <div className="phone-admin-actions"><button type="submit" className="primary-button" disabled={busy}>{productText(locale, "Save", "保存")}</button><button type="button" className="secondary-button" disabled={busy} onClick={() => setEditing(null)}>{productText(locale, "Cancel", "取消")}</button></div>
    </form>}
  </details>;
}
