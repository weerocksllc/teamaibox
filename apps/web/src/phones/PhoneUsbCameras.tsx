import { productText } from "../../../../packages/ui-system/src/product-localization.mjs";
import { useEffect, useRef, useState } from "react";
import { loadPhoneUsbCameras, savePhoneUsbCamera, loadPhoneQuotas, PhoneAdministrationError,
  type PhoneUsbCamera, type PhoneQuotaPage } from "./phone-administration-client";

export function PhoneUsbCameras({ nodeId, locale }: { nodeId: string; locale: string }) {
  const [open, setOpen] = useState(false), [items, setItems] = useState<PhoneUsbCamera[] | null>(null);
  const [editing, setEditing] = useState<PhoneUsbCamera | null>(null), [page, setPage] = useState<PhoneQuotaPage | null>(null);
  const [search, setSearch] = useState(""), [appliedSearch, setAppliedSearch] = useState("");
  const [notice, setNotice] = useState(""), [busy, setBusy] = useState(false), [reload, setReload] = useState(0);
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => { const controller = new AbortController(); lifetime.current = controller; return () => controller.abort(); }, []);
  const errorText = (error: unknown) => error instanceof PhoneAdministrationError && error.code === "phone_state_conflict"
    ? (productText(locale, "Settings changed. Refresh and retry.", "设置已变化，请刷新后重试。"))
    : error instanceof PhoneAdministrationError && error.code === "phone_camera_usb_device_changed"
      ? (productText(locale, "Camera disconnected. Refresh the device list.", "摄像头已拔出，请刷新设备列表。"))
      : (productText(locale, "Cannot read or save camera settings. Check the device camera service and retry.", "无法读取或保存摄像头设置，请检查本机摄像头服务后重试。"));
  useEffect(() => {
    if (!open) return;
    const request = new AbortController(); setBusy(true); setNotice("");
    loadPhoneUsbCameras(nodeId, request.signal).then(value => { if (!request.signal.aborted) setItems(value.data); })
      .catch(error => { if (!request.signal.aborted) { setItems(null); setNotice(errorText(error)); } })
      .finally(() => { if (!request.signal.aborted) setBusy(false); });
    return () => request.abort();
  }, [open, nodeId, reload]);
  async function users(query: string, after: string | null = null) {
    const controller = lifetime.current; if (!controller || controller.signal.aborted) return;
    setBusy(true); setNotice("");
    try { const value = await loadPhoneQuotas(query, after, controller.signal);
      if (!controller.signal.aborted) { setPage(value); setAppliedSearch(query); }
    } catch (error) { if (!controller.signal.aborted) setNotice(errorText(error)); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  async function save() {
    const controller = lifetime.current;
    if (!editing || busy || !controller || controller.signal.aborted) return;
    setBusy(true); setNotice("");
    try {
      await savePhoneUsbCamera(nodeId, editing, controller.signal);
      if (!controller.signal.aborted) { setEditing(null); setReload(n => n + 1); }
    } catch (error) { if (!controller.signal.aborted) setNotice(errorText(error)); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  return <details className="phone-admin-usb" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{productText(locale, "Box cameras", "盒子摄像头")}</summary>
    <p className="phone-admin-muted">{productText(locale, "Manage USB cameras connected to this appliance. Choose who can use each camera; revoking access also stops their active input.", "管理插在这台盒子上的 USB 摄像头。选择可使用的成员；撤销权限会同时停止正在使用的画面输入。")}</p>
    {notice && <p role="status">{notice}</p>}
    {busy && <p role="status">{productText(locale, "Working…", "正在处理…")}</p>}
    <button type="button" className="secondary-button" disabled={busy} onClick={() => { setEditing(null); setReload(n => n + 1); }}>{productText(locale, "Refresh cameras", "刷新摄像头")}</button>
    {items?.length === 0 && <p>{productText(locale, "No USB camera detected on this box.", "这台盒子尚未检测到可用的 USB 摄像头。")}</p>}
    {items?.map(camera => <div className="phone-admin-usb-device" key={camera.deviceId}>
      <div><strong>{camera.name}</strong><p className="phone-admin-muted">{camera.connected ? (productText(locale, "Connected", "已连接")) : (productText(locale, "Disconnected", "未连接"))} · {camera.enabled ? (productText(locale, "{v0} permitted users", "允许 {v0} 位用户使用", {v0: camera.ownerIds.length})) : (productText(locale, "Access disabled", "未开放使用"))}</p></div>
      <button type="button" className="secondary-button" disabled={busy} onClick={() => { setEditing({ ...camera, ownerIds: [...camera.ownerIds] }); setSearch(""); void users(""); }}>{productText(locale, "Manage access", "设置使用权限")}</button>
    </div>)}
    {editing && <form className="phone-admin-editor" onSubmit={event => { event.preventDefault(); void save(); }}>
      <h4>{editing.name}</h4>
      <label className="phone-admin-check"><input type="checkbox" checked={editing.enabled} disabled={busy || !editing.connected && !editing.enabled} onChange={event => setEditing({ ...editing, enabled: event.target.checked })} />{productText(locale, "Allow selected users", "允许选中的用户使用")}</label>
      <div className="phone-admin-search"><label><span className="sr-only">{productText(locale, "Search users", "搜索用户")}</span><input type="search" value={search} disabled={busy} placeholder={productText(locale, "Search name or account", "搜索用户姓名或账号")} onChange={event => setSearch(event.target.value)} /></label><button type="button" className="secondary-button" disabled={busy} onClick={() => void users(search)}>{productText(locale, "Search", "搜索")}</button></div>
      <p className="phone-admin-muted">{productText(locale, "{v0} selected. Search and pagination preserve selections.", "已选择 {v0} 人；搜索和翻页不会清除其他已选用户。", {v0: editing.ownerIds.length})}</p>
      <div className="phone-admin-user-checks">{page?.data.map(user => <label className="phone-admin-check" key={user.ownerId}><input type="checkbox" disabled={busy || user.status !== "active" && !editing.ownerIds.includes(user.ownerId)} checked={editing.ownerIds.includes(user.ownerId)} onChange={event => setEditing({ ...editing, ownerIds: event.target.checked ? [...editing.ownerIds, user.ownerId] : editing.ownerIds.filter(id => id !== user.ownerId) })} />{user.displayName} (@{user.loginName})</label>)}</div>
      {page?.data.length === 0 && <p>{productText(locale, "No matching users.", "没有匹配用户。")}</p>}
      <div className="phone-admin-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => void users(appliedSearch)}>{productText(locale, "First page", "第一页")}</button>{page?.nextCursor && <button type="button" className="secondary-button" disabled={busy} onClick={() => void users(appliedSearch, page.nextCursor)}>{productText(locale, "Next page", "下一页")}</button>}</div>
      <div className="phone-admin-actions"><button type="submit" className="primary-button" disabled={busy}>{productText(locale, "Save access", "保存权限")}</button><button type="button" className="secondary-button" disabled={busy} onClick={() => setEditing(null)}>{productText(locale, "Cancel", "取消")}</button></div>
    </form>}
  </details>;
}
