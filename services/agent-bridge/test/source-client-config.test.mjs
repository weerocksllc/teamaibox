import assert from "node:assert/strict";
import test from "node:test";

import {
  generateSourceClientConfig,
  INTERNAL_SOURCE_GATEWAYS,
  sourceClientEnvironment,
} from "../src/source-client-config.mjs";

test("sandbox package clients receive only fixed internal gateway endpoints", () => {
  const config = generateSourceClientConfig(INTERNAL_SOURCE_GATEWAYS);
  const environment = sourceClientEnvironment(INTERNAL_SOURCE_GATEWAYS);
  assert.match(config.pipConf, /index-url = http:\/\/source-gateway:8080\/pip\/simple\//);
  assert.match(config.npmrc, /registry=http:\/\/source-gateway:8080\/npm\/registry\//);
  assert.match(config.aptSources, /http:\/\/source-gateway:8080\/apt bookworm main/);
  assert.match(config.aptSources, /arch=arm64/);
  assert.match(config.aptSources, /signed-by=\/usr\/share\/keyrings\/debian-archive-keyring\.gpg/);
  assert.match(config.aptConf, /Acquire::Retries "2"/);
  assert.match(config.aptConf, /Acquire::http::Timeout "120"/);
  assert.match(config.aptConf, /Acquire::http::Pipeline-Depth "0"/);
  assert.equal(environment.PIP_EXTRA_INDEX_URL, "");
  assert.deepEqual(new Set(Object.values(environment).filter((value) => value.startsWith("http"))), new Set(Object.values(INTERNAL_SOURCE_GATEWAYS)));
});

test("sandbox package client generation rejects upstream endpoints and embedded credentials", () => {
  for (const [kind, value] of [
    ["pip", "https://pypi.org/simple/"],
    ["npm", "http://token@source-gateway:8080/npm/registry/"],
    ["apt", "http://source-gateway:8080/apt/"],
  ]) {
    assert.throws(() => generateSourceClientConfig({ ...INTERNAL_SOURCE_GATEWAYS, [kind]: value }), /internal source gateway/);
  }
});

test("generated package client files contain no credential or alternate-source fields", () => {
  const serialized = JSON.stringify(generateSourceClientConfig(INTERNAL_SOURCE_GATEWAYS));
  assert.doesNotMatch(serialized, /authorization|proxy-authorization|_auth|_password|username|extra-index-url|pypi\.org|registry\.npmjs\.org/i);
});
