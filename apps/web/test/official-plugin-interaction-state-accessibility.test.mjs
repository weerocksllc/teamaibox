import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

async function source(plugin, file) {
  return readFile(new URL(`../../${plugin}-plugin/src/public/${file}`, import.meta.url), "utf8");
}

test("queued AI applications announce progress and terminal state", async () => {
  const plugins = [
    ["asr", "job", "present"],
    ["ocr", "job", "presentJob"],
    ["translation", "job", "present"],
    ["drawing", "job-view", "presentJob"],
  ];

  for (const [plugin, id, presenter] of plugins) {
    const [html, script] = await Promise.all([source(plugin, "index.html"), source(plugin, "app.js")]);
    assert.match(
      html,
      new RegExp(`id="${id}"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-busy="true"`),
      `${plugin} does not expose queued work as a busy status`,
    );
    assert.match(script, new RegExp(`function ${presenter}\\(`));
    assert.match(script, new RegExp(`\\$\\("#${id}"\\)\\.ariaBusy\\s*=\\s*String\\(!`), `${plugin} never clears busy state at a terminal status`);
  }
});

test("official application failures are alerts", async () => {
  const requiredAlerts = {
    asr: ["form-error", "live-error", "job-error"],
    drawing: ["form-error", "result-error"],
    ocr: ["form-error", "job-error"],
    translation: ["form-error", "job-error"],
    "team-drive": ["error", "dialog-error", "share-error"],
  };

  for (const [plugin, ids] of Object.entries(requiredAlerts)) {
    const html = await source(plugin, "index.html");
    for (const id of ids) {
      assert.match(html, new RegExp(`id="${id}"[^>]*role="alert"`), `${plugin}#${id} is not announced as an alert`);
    }
  }
});

test("Messaging and Team Drive loading skeletons are localized busy statuses", async () => {
  const messagingHtml = await source("messaging", "index.html");
  const messagingScript = await source("messaging", "app.js");
  for (const [id, key] of [["conversation-loading", "loading"], ["history-loading", "loadingHistory"]]) {
    assert.match(messagingHtml, new RegExp(`id="${id}"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-busy="true"[^>]*data-i18n-aria="${key}"`));
    assert.match(messagingScript, new RegExp(`messages\\["zh-CN"\\]\\.${key}=`));
    assert.match(messagingScript, new RegExp(`messages\\.en\\.${key}=`));
    assert.match(messagingScript, new RegExp(`\\$\\("#${id}"\\)\\.ariaBusy="false"`));
  }

  const driveHtml = await source("team-drive", "index.html");
  const driveScript = await source("team-drive", "app.js");
  assert.match(driveHtml, /id="loading"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-busy="true"[^>]*data-i18n-aria="loading"/);
  assert.match(driveHtml, /id="upload-panel"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-busy="true"/);
  assert.match(driveScript, /\$\("#loading"\)\.ariaBusy="false"/);
  assert.match(driveScript, /\$\("#upload-panel"\)\.ariaBusy=String\(percent<100\)/);
});

test("symbol-only hidden controls retain localized accessible names", async () => {
  const controls = {
    asr: [["clear", "clear"], ["refresh", "refresh"]],
    ocr: [["clear-file", "clear"], ["refresh-drive", "refresh"]],
    translation: [["clear", "clear"], ["refresh", "refresh"], ["swap", "swap"]],
    "team-drive": [["close-nav", "close"], ["open-nav", "menu"], ["close-details", "close"], ["close-preview", "close"]],
  };

  for (const [plugin, values] of Object.entries(controls)) {
    const [html, script] = await Promise.all([source(plugin, "index.html"), source(plugin, "app.js")]);
    assert.match(script, /querySelectorAll\("\[data-i18n-aria\]"\)/, `${plugin} does not apply localized accessible names`);
    for (const [id, key] of values) {
      assert.match(html, new RegExp(`id="${id}"[^>]*data-i18n-aria="${key}"[^>]*aria-label="[^"]+"`), `${plugin}#${id} has no localized accessible name`);
      assert.match(script, new RegExp(`(?:messages|catalog)\\["zh-CN"\\]\\.${key}=`), `${plugin} has no Chinese ${key} label`);
      assert.match(script, new RegExp(`(?:messages|catalog)\\.en\\.${key}=`), `${plugin} has no English ${key} label`);
    }
  }
});

test("file upload activators are keyboard operable", async () => {
  const expectedTriggers = { asr: 1, ocr: 1, translation: 1, messaging: 1, "team-drive": 2 };
  for (const [plugin, count] of Object.entries(expectedTriggers)) {
    const [html, script] = await Promise.all([source(plugin, "index.html"), source(plugin, "app.js")]);
    const triggers = html.match(/role="button" tabindex="0" data-keyboard-file-trigger/g) ?? [];
    assert.equal(triggers.length, count, `${plugin} keyboard upload trigger count drifted`);
    assert.match(script, /querySelectorAll\("\[data-keyboard-file-trigger\]"\)/);
    assert.match(script, /event\.key==="Enter"\|\|event\.key===" "/);
    assert.match(script, /input\[type="file"\]/);
  }
});

test("every official application loads a high-visibility keyboard focus ring", async () => {
  for (const plugin of ["asr", "drawing", "ocr", "translation", "messaging", "team-drive"]) {
    const [script, css] = await Promise.all([source(plugin, "app.js"), source(plugin, "focus.css")]);
    assert.match(script, /focusStylesheet\.href\s*=\s*new URL\("\.\/focus\.css", import\.meta\.url\)\.href/);
    assert.match(css, /:focus-visible/);
    assert.match(css, /outline:3px solid var\(--teamaibox-focus,var\(--accent\)\)!important/);
    assert.match(css, /outline-offset:2px!important/);
  }
});

test("official application dialogs expose stable localized names", async () => {
  const messaging = await source("messaging", "index.html");
  assert.match(messaging, /id="new-dialog"[^>]*aria-labelledby="new-dialog-title"/);
  assert.match(messaging, /id="new-dialog-title"[^>]*data-i18n="newTitle"/);
  assert.match(messaging, /id="notification-dialog"[^>]*aria-labelledby="notification-dialog-title"/);
  assert.match(messaging, /id="notification-dialog-title"[^>]*data-i18n="notificationTitle"/);

  const driveScript = await source("team-drive", "app.js");
  assert.match(driveScript, /document\.querySelector\("#text-dialog"\)\?\.setAttribute\("aria-labelledby","dialog-title"\)/);
  assert.match(driveScript, /document\.querySelector\("#share-dialog h2"\)\?\.setAttribute\("id","share-dialog-title"\)/);
  assert.match(driveScript, /document\.querySelector\("#share-dialog"\)\?\.setAttribute\("aria-labelledby","share-dialog-title"\)/);
  assert.match(driveScript, /document\.querySelector\("#preview-dialog"\)\?\.setAttribute\("aria-labelledby","preview-title"\)/);
});

test("official application warning and dynamic-note semantics are explicit", async () => {
  const ocr = await source("ocr", "index.html");
  assert.match(ocr, /id="geometry-note"[^>]*role="status"[^>]*aria-live="polite"/);
});

test("mode and filter button groups expose their selected state", async () => {
  const expectations = {
    drawing: [
      ["intentGroup", /class="intent-grid"[^>]*role="radiogroup"[^>]*data-i18n-aria="intentGroup"/],
      ["aspectGroup", /class="preset-grid"[^>]*role="group"[^>]*data-i18n-aria="aspectGroup"/],
    ],
    ocr: [
      ["inputSource", /role="group"[^>]*data-i18n-aria="inputSource"/],
      ["resultView", /role="group"[^>]*data-i18n-aria="resultView"/],
    ],
    asr: [["inputSource", /role="group"[^>]*data-i18n-aria="inputSource"/]],
    translation: [["inputSource", /role="group"[^>]*data-i18n-aria="inputSource"/]],
    messaging: [
      ["conversationFilter", /role="group"[^>]*data-i18n-aria="conversationFilter"/],
      ["conversationKind", /role="group"[^>]*data-i18n-aria="conversationKind"/],
    ],
    "team-drive": [["layout", /class="view-controls"[^>]*role="group"[^>]*data-i18n-aria="layout"/]],
  };
  for (const [plugin, groupExpectations] of Object.entries(expectations)) {
    const [html, script] = await Promise.all([source(plugin, "index.html"), source(plugin, "app.js")]);
    assert.doesNotMatch(html, /role="tablist"/, `${plugin} declares a tablist without a complete tab keyboard model`);
    for (const [key, containerPattern] of groupExpectations) {
      assert.match(html, containerPattern, `${plugin} ${key} has no localized accessible name`);
      if (plugin === "drawing") {
        const zh = script.match(/"zh-CN":\s*\{([\s\S]*?)\n\s*\},\n\s*en:\s*\{/);
        const en = script.match(/\n\s*en:\s*\{([\s\S]*?)\n\s*\},\n\};/);
        assert.match(zh?.[1] ?? "", new RegExp(`\\b${key}\\s*:`));
        assert.match(en?.[1] ?? "", new RegExp(`\\b${key}\\s*:`));
      } else {
        assert.match(script, new RegExp(`(?:messages|catalog)\\["zh-CN"\\]\\.${key}\\s*=\\s*`));
        assert.match(script, new RegExp(`(?:messages|catalog)\\.en\\.${key}\\s*=\\s*`));
      }
    }
    assert.match(html, /aria-pressed="true"/);
    assert.match(html, /aria-pressed="false"/);
    assert.match(script, /setAttribute\("aria-pressed",\s*String\(active\)\)/, `${plugin} does not update the pressed state`);
  }
});

test("Team Drive navigation exposes the current location", async () => {
  const script = await source("team-drive", "app.js");
  assert.match(script, /setAttribute\("aria-current","page"\)/);
  assert.match(script, /removeAttribute\("aria-current"\)/);
});

test("phone, OCR and speech form controls have labels independent of placeholders", async () => {
  for (const plugin of ["virtual-phones", "ocr", "asr"]) {
    const html = await source(plugin, "index.html");
    const labels = [...html.matchAll(/<label\b[^>]*>[\s\S]*?<\/label>/g)].map(match => match[0]);
    const controls = [...html.matchAll(/<(?:input|textarea|select)\b[^>]*>/g)].map(match => match[0]);
    assert.ok(controls.length > 0);
    for (const control of controls) {
      const id = control.match(/\bid="([^"]+)"/)?.[1];
      const hasAria = /\baria-(?:label|labelledby)="[^"]+"/.test(control);
      const hasLabel = labels.some(label => label.includes(control)
        || id && new RegExp(`<label\\b[^>]*\\bfor="${id}"`).test(label));
      assert.ok(hasAria || hasLabel, `${plugin} ${id ?? control} relies on an unnamed control`);
    }
  }
});

test("Assistant composer has a localized accessible name independent of its placeholder", async () => {
  const source = await readFile(new URL("../src/assistant/AssistantWorkspace.tsx", import.meta.url), "utf8");
  assert.match(source, /<textarea aria-label=\{t\("assistant\.workspace\.composer_label"\)\}/);
  const translations = await readFile(new URL("../src/i18n.ts", import.meta.url), "utf8");
  assert.equal((translations.match(/"assistant\.workspace\.composer_label":/g) ?? []).length, 2);
});
