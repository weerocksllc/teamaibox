#!/usr/bin/env node
import { writeFile } from "node:fs/promises";

import { need, startChrome, stopChrome } from "./browser_smoke_common.mjs";

function argumentsFrom(values) {
  const options = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index], value = values[index + 1];
    need(key?.startsWith("--") && value, "preview browser arguments are invalid");
    options[key.slice(2)] = value;
  }
  const origin = new URL(options.origin);
  need(["http:", "https:"].includes(origin.protocol) && origin.hostname && !origin.username && !origin.password
    && origin.pathname === "/" && !origin.search && !origin.hash, "preview browser origin is invalid");
  options.origin = origin.href;
  need(typeof options.screenshot === "string" && options.screenshot.startsWith("/"), "preview screenshot path is invalid");
  return options;
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2));
  const runtime = await startChrome();
  try {
    await runtime.cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await runtime.cdp.send("Page.navigate", { url: options.origin });
    const banner = await runtime.cdp.wait(`(() => {const element=document.querySelector(".development-preview-banner");return {ready:Boolean(element&&element.getBoundingClientRect().height>0),text:element?.textContent?.trim()||null,releaseEvidenceEligible:element?.dataset?.releaseEvidenceEligible||null,language:document.documentElement.lang||null,theme:document.documentElement.dataset.theme||null}})()`, "development preview banner", 30_000);
    need(banner.releaseEvidenceEligible === "false", "preview browser release-evidence marker drifted");
    need(/synthetic data only|仅合成数据/i.test(banner.text ?? ""), "preview browser synthetic disclosure is missing");
    const captured = await runtime.cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, fromSurface: true });
    const bytes = Buffer.from(captured.data, "base64");
    need(bytes.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])), "preview screenshot is invalid");
    await writeFile(options.screenshot, bytes, { flag: "wx" });
    console.log(JSON.stringify({
      bannerRendered: true,
      browser: runtime.browser,
      consoleErrorCount: runtime.errors.length,
      language: banner.language,
      releaseEvidenceEligible: false,
      text: banner.text,
      theme: banner.theme,
      viewport: { width: 390, height: 844 },
    }));
  } finally {
    await stopChrome(runtime);
  }
}

main().catch((error) => { process.stderr.write(`preview browser smoke failed: ${error.message}\n`); process.exitCode = 1; });
