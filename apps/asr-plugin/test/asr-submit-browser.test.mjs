import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { createAsrPluginServer } from "../src/server.mjs";

// Isolated UI fixtures: no real media, user files, microphone or model execution.
test("ASR submit layout and busy state in upload, Drive and microphone modes", {
  skip: !process.env.TEAMAIBOX_PHONE_UI_PLAYWRIGHT, timeout: 60000,
}, async t => {
  const { chromium } = await import(pathToFileURL(process.env.TEAMAIBOX_PHONE_UI_PLAYWRIGHT));
  const server = createAsrPluginServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const local = `http://127.0.0.1:${server.address().port}`, origin = "https://asr-ui.test";
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [], writes = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => Object.defineProperty(document, "cookie", { get: () => "__Host-teamaibox-csrf=synthetic" }));
  let releaseUpload, heldUpload;
  await page.route(origin + "/**", async route => {
    const req = route.request(), url = new URL(req.url());
    const reply = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (!url.pathname.startsWith("/api/")) return route.fulfill({ response: await route.fetch({ url: local + url.pathname + url.search }) });
    if (req.method() === "POST") writes.push({ path: url.pathname, body: url.pathname.includes("uploads") ? null : req.postDataJSON() });
    if (url.pathname === "/api/v1/applications") return reply({ applications: [] });
    if (url.pathname === "/api/v1/objects") return reply({ data: [{ objectId: "00000000-0000-4000-8000-000000000001", objectKey: "ai-inputs/sample.wav", contentType: "audio/wav", size: 48 }] });
    if (url.pathname.includes("uploads")) { if (heldUpload) await heldUpload; return reply({ reference_id: "00000000-0000-4000-8000-000000000002" }); }
    if (url.pathname.endsWith("/references")) return reply({ reference_id: "00000000-0000-4000-8000-000000000002" });
    if (url.pathname === "/api/v1/ai/transcriptions") return reply({ error: { code: "capability_unavailable" } }, 409);
    return reply({ error: { code: "not_found" } }, 404);
  });
  for (const theme of ["light", "dark"]) {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${origin}/plugins/official.asr/?theme=${theme}`);
      const submit = page.getByRole("button", { name: "≋ 开始转写", exact: true });
      await submit.waitFor(); assert.ok(await submit.isDisabled());
      const geometry = await page.evaluate(() => {
        const button = document.querySelector("#submit"), note = document.querySelector("#batch-controls .queue-note"), controls = document.querySelector(".controls");
        const a = button.getBoundingClientRect(), b = note.getBoundingClientRect(), c = controls.getBoundingClientRect(), css = getComputedStyle(button);
        return { height: a.height, font: parseFloat(css.fontSize), gap: b.top - a.bottom, contained: a.left >= c.left && a.right <= c.right,
          gradient: css.backgroundImage, overflow: document.documentElement.scrollWidth > innerWidth };
      });
      assert.ok(geometry.height >= 44 && geometry.height < 80); assert.equal(geometry.font, 14);
      assert.ok(geometry.gap >= 10, JSON.stringify({theme,width,...geometry})); assert.ok(geometry.contained); assert.equal(geometry.gradient, "none"); assert.equal(geometry.overflow, false);
      await page.locator("#file").setInputFiles({ name: "synthetic.wav", mimeType: "audio/wav", buffer: Buffer.alloc(48) });
      assert.ok(await submit.isEnabled());
      heldUpload = new Promise(resolve => { releaseUpload = resolve; });
      await submit.click();
      await page.getByText("正在校验并加密上传…", { exact: true }).waitFor();
      assert.ok(await page.locator("#submit").isDisabled());
      assert.equal(await page.locator("#submit").getAttribute("aria-busy"), "true");
      assert.ok(await page.getByRole("button", { name: "网盘选择", exact: true }).isDisabled());
      releaseUpload(); heldUpload = null;
      await page.locator("#form-error").filter({ hasText: "没有已认证" }).waitFor();
      await submit.waitFor(); assert.ok(await submit.isEnabled());
      await page.locator("#clear").click(); assert.ok(await submit.isDisabled());
      await page.getByRole("button", { name: "网盘选择", exact: true }).click();
      await page.getByRole("button", { name: /sample.wav/ }).click(); assert.ok(await submit.isEnabled());
      await submit.click(); await page.locator("#form-error").filter({ hasText: "没有已认证" }).waitFor();
      await page.getByRole("button", { name: "实时麦克风", exact: true }).click();
      assert.ok(await page.locator("#batch-controls").isHidden());
      assert.ok(await page.getByRole("button", { name: /开始实时转写/ }).isVisible());
      assert.ok(await page.locator("#live-control-status").isVisible());
      assert.equal(await page.locator("#live-control-status").textContent(), "麦克风尚未启用");
    }
  }
  assert.equal(writes.filter(x => x.path === "/api/v1/ai/transcriptions").length, 8);
  for (const write of writes.filter(x => x.path === "/api/v1/ai/transcriptions")) {
    assert.equal(write.body.model, "local/asr-default"); assert.deepEqual(write.body.timestamp_granularities, ["segment"]);
  }
  assert.ok(!writes.some(x => x.path.includes("realtime")), "No implicit microphone activation");
  assert.deepEqual(errors, []);
});
