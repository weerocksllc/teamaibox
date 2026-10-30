import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL, fileURLToPath } from "node:url";
import { resolve, sep } from "node:path";
import { administratorNavigation, visibleNavigation } from "../src/authorization/view-policy.mjs";

test("phone administration has one permission-scoped navigation entry, separate from phone use", () => {
  assert.equal(visibleNavigation(administratorNavigation, { permissions: ["phone:manage"] }).filter(x => x.id === "phones").length, 1);
  assert.equal(visibleNavigation(administratorNavigation, { permissions: ["phone:use"] }).some(x => x.id === "phones"), false);
});

// Real production React bundle in Chromium, explicit synthetic API fixtures.
// This proves UI behavior, not a deployed runtime or real phone acceptance.
test("phone administrator can pause, inspect node reasons and edit quotas without opening member content", {
  skip: !process.env.TEAMAIBOX_PHONE_UI_PLAYWRIGHT, timeout: 60000,
}, async t => {
  const { chromium } = await import(pathToFileURL(process.env.TEAMAIBOX_PHONE_UI_PLAYWRIGHT));
  const root = fileURLToPath(new URL("../dist", import.meta.url));
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const path = resolve(root, pathname === "/admin/phones" ? "index.html" : `.${pathname}`);
    if (!path.startsWith(root + sep)) { response.writeHead(404).end(); return; }
    try { response.setHeader("Content-Type", path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : "text/html"); response.end(await readFile(path)); }
    catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const local = `http://127.0.0.1:${server.address().port}`, origin = "https://phone-administration.test";
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [], requests = [], writes = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    window.__TEAM_AI_BOX_AUTHORIZATION__ = { identityKind: "local_user", permissions: ["phone:manage"] };
    window.__TEAM_AI_BOX_ACCOUNT_PREFERENCES__ = { preferredLocale: "zh-CN", preferredTheme: "light", displayName: "SYNTHETIC ADMIN", roles: ["system_admin"] };
    window.__TEAM_AI_BOX_RUNTIME__ = { transport: "https", classification: "isolated-development-synthetic-only" };
    Object.defineProperty(document, "cookie", { get: () => "__Host-teamaibox-csrf=synthetic-csrf" });
  });
  let ready = true, enabled = true, revision = 1, conflict = false, forceUnavailable = false;
  const user = { ownerId: "00000000-0000-4000-8000-000000000101", displayName: "测试成员", loginName: "member", status: "active",
    storedPerUser: 2, runningPerUser: 2, revision: 1, stored: 2, running: 1 };
  let usb = { deviceId: '00000000-0000-4000-8000-000000000201', name: 'USB 摄像头', connected: true, enabled: false, revision: 0, ownerIds: [] };
  let network = null;
  await page.route(origin + "/**", async route => {
    const request = route.request(), url = new URL(request.url());
    if (!url.pathname.startsWith("/api/")) return route.fulfill({ response: await route.fetch({ url: local + url.pathname }) });
    requests.push(url.pathname);
    const reply = (value, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
    if (url.pathname === "/api/v1/applications") return reply({ schemaVersion: 1, applications: [] });
    if (!url.pathname.startsWith("/api/v1/admin/virtual-phones")) return reply({ error: { code: "not_found" } }, 404);
    if (forceUnavailable) return reply({ error: { code: "service_unavailable" } }, 503);
    if (url.pathname.includes('/network-cameras')) {
      if (request.method() === 'PUT') {
        assert.equal(request.headers()['x-csrf-token'], 'synthetic-csrf');
        const body=request.postDataJSON();assert.equal(body.expectedRevision,network?.revision??0);
        network={...body,id:url.pathname.split('/').at(-1),revision:(network?.revision??0)+1};return reply(network);
      }
      return reply({nodeId:'00000000-0000-4000-8000-000000000019',addresses:['192.0.2.19'],data:network?[network]:[]});
    }
    if (url.pathname.includes('/usb-cameras')) {
      if (request.method() === 'PUT') {
        assert.equal(request.headers()['x-csrf-token'], 'synthetic-csrf');
        const body = request.postDataJSON(); assert.equal(body.expectedRevision, usb.revision);
        usb = {...usb, enabled: body.enabled, ownerIds: body.ownerIds, revision: usb.revision + 1}; return reply(usb);
      }
      return reply({nodeId:'00000000-0000-4000-8000-000000000019',data:[usb]});
    }
    if (request.method() === "PUT") {
      assert.equal(request.headers()["x-csrf-token"], "synthetic-csrf");
      const body = request.postDataJSON(); writes.push({ path: url.pathname, body });
      if (conflict) return reply({ error: { code: "phone_state_conflict" } }, 409);
      if (url.pathname.endsWith("/feature")) { assert.equal(body.expectedRevision, revision); enabled = body.enabled; revision++; }
      else { assert.equal(body.expectedRevision, user.revision); Object.assign(user, { storedPerUser: body.storedPerUser, runningPerUser: body.runningPerUser, revision: user.revision + 1 }); }
    }
    if (url.pathname.endsWith("/quotas")) return reply({ data: url.searchParams.get("search") === "missing" ? [] : [user], nextCursor: null });
    return reply({ policy: { enabled, revision, storedPerUser: 2, runningPerUser: 2 }, deploymentReady: ready, contentAccessGranted: false,
      roms:[{id:'retired-camera-v3',familyId:'aosp',name:'Android AOSP · 摄像头',version:'Camera v3',googlePlay:false,experimental:false,cameraCapability:'available',createEnabled:false,reasonCode:null},
        {id:'aosp-17-16102939-v1',familyId:'aosp',name:'Android AOSP',version:'Android 17 · v1',googlePlay:false,experimental:false,cameraCapability:'unavailable',createEnabled:true,reasonCode:null},
        {id:'google-experimental-17-16102939-v1',familyId:'google-experimental',name:'Android + Google Play',version:'Android 17 · v1',googlePlay:true,experimental:true,cameraCapability:'unavailable',createEnabled:false,reasonCode:'phone_rom_unavailable'}],
      nodes: [{ nodeId: "00000000-0000-4000-8000-000000000019", nodeName: "Office node", address: "192.0.2.19", configuredLimit: 2,
        running: 2, runningCount: 1, reservedCount: 1, observedAt: "2026-09-13T09:00:00Z", reasonCode: "phone_storage_unavailable" }] });
  });
  await page.goto(origin + "/admin/phones");
  const panel = page.locator(".phone-admin");
  await panel.getByText("允许新建和启动", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "虚拟手机", exact: true }).count(), 1);
  assert.equal(await panel.getByRole("heading", { name: "虚拟手机管理", exact: true }).count(), 0);
  assert.ok(await panel.getByText("192.0.2.19", { exact: true }).isVisible());
  assert.ok(await panel.getByText("Office node", { exact: true }).isVisible());
  assert.ok(await panel.getByText("预留 / 处理中", { exact: true }).isVisible());
  assert.equal(await panel.locator(".phone-admin-metrics dd").allTextContents().then(x=>x.join(",")), "1,1,2");
  assert.ok(await panel.getByText("成员可用系统", { exact: true }).isVisible());
  assert.equal(await panel.locator('.phone-admin-rom-entry').count(),2);
  assert.deepEqual(await panel.locator('.phone-admin-rom-entry h3').allTextContents(),['标准 Android','Android + Google Play']);
  // Check a populated table: the old empty-search check missed hidden user
  // labels escaping the table's horizontal scroll container on narrow screens.
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'populated quota table stays inside mobile viewport');
  await page.setViewportSize({ width: 1280, height: 900 });
  assert.doesNotMatch(await panel.locator('.phone-admin-rom').innerText(),/v1|v3|Cuttlefish|ARM64|KVM|retired-camera/);
  assert.ok(await panel.getByText('尚未开放新建',{exact:true}).isVisible());
  assert.equal(await panel.getByLabel("搜索用户姓名或账号").evaluate(el=>getComputedStyle(el).borderTopWidth), "1px");
  await panel.getByRole("button", { name: "暂停功能", exact: true }).click();
  await panel.getByText("已暂停新建和启动", { exact: true }).waitFor();
  await panel.getByText("设置已保存。", { exact: true }).waitFor();
  assert.equal(writes.length, 1);
  assert.ok(await panel.getByText("加密手机存储未就绪", { exact: true }).isVisible());
  await panel.getByRole("button", { name: "调整额度 测试成员" }).click();
  await panel.getByLabel("可保存数量", { exact: true }).fill("3");
  await panel.getByLabel("可同时运行", { exact: true }).fill("1");
  await panel.getByRole("button", { name: "保存额度", exact: true }).click();
  await panel.locator("td").filter({ hasText: /^2 \/ 3$/ }).waitFor();
  assert.equal(user.runningPerUser, 1); assert.equal(user.running, 1, "lowering quotas does not stop phones");
  conflict = true;
  await panel.getByRole("button", { name: "开启功能", exact: true }).click();
  await panel.getByText("设置已被修改，请刷新后重试。", { exact: true }).waitFor();
  assert.equal(enabled, false);
  conflict = false; ready = false;
  await panel.getByRole("button", { name: "刷新", exact: true }).first().click();
  await panel.getByText("尚未完成运行服务部署，不能开启成员入口。", { exact: true }).waitFor();
  assert.ok(await panel.getByRole("button", { name: "开启功能", exact: true }).isDisabled());
  await panel.getByLabel("搜索用户姓名或账号").fill("missing");
  await panel.getByRole("button", { name: "搜索", exact: true }).click();
  await panel.getByText("没有匹配的用户。", { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.equal(requests.filter(path => path.includes('/usb-cameras')).length,0,'camera inventory loads only when opened');
  await panel.locator('.phone-admin-usb:not(.phone-admin-network) summary').click();
  await panel.getByText('USB 摄像头',{exact:true}).waitFor();
  await panel.getByRole('button',{name:'设置使用权限',exact:true}).click();
  await panel.getByLabel('测试成员 (@member)',{exact:true}).check();
  await panel.getByLabel('允许选中的用户使用',{exact:true}).check();
  await panel.getByLabel('搜索用户',{exact:true}).fill('missing');
  await panel.locator('.phone-admin-usb:not(.phone-admin-network)').getByRole('button',{name:'搜索',exact:true}).click();
  await panel.getByText('没有匹配用户。',{exact:true}).waitFor();
  await panel.getByRole('button',{name:'保存权限',exact:true}).click();
  await panel.getByText('已连接 · 允许 1 位用户使用',{exact:true}).waitFor();
  assert.deepEqual(usb.ownerIds,[user.ownerId]);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.equal(requests.filter(path=>path.includes('/network-cameras')).length,0);
  const net=panel.locator('.phone-admin-network');await net.locator('summary').click();
  await net.getByRole('button',{name:'添加推流入口',exact:true}).click();
  await net.getByLabel('入口名称',{exact:true}).fill('会议室视频');
  await net.getByLabel('允许推流的 IP/网段（每行一个）',{exact:true}).fill('192.0.2.8/32');
  await net.getByLabel('测试成员 (@member)',{exact:true}).check();
  await net.getByRole('button',{name:'保存',exact:true}).click();
  await net.getByText('会议室视频',{exact:true}).waitFor();
  assert.equal(network.listenAddress,'192.0.2.19');assert.deepEqual(network.allowedSources,['192.0.2.8/32']);
  assert.deepEqual(network.ownerIds,[user.ownerId]);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  forceUnavailable = true;
  await panel.getByRole("button", { name: "刷新", exact: true }).first().click();
  await panel.getByText("暂时无法读取，请刷新重试。", { exact: true }).waitFor();
  assert.equal(await panel.getByRole("button", { name: "开启功能", exact: true }).count(), 0);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole("navigation", { name: "工作台", exact: true }).getByRole("button", { name: "全部应用", exact: true }).click();
  await page.locator("#applications").waitFor({ state: "visible" });
  assert.equal(new URL(page.url()).pathname, "/");
  assert.equal(await panel.count(), 0, "application navigation leaves administration");
  assert.ok(!requests.some(path => path.startsWith("/api/v1/virtual-phones")), "management never requests a user's phone data");
  assert.deepEqual(errors, []);
});
