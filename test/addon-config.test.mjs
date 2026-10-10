import test from "node:test";
import assert from "node:assert/strict";
import { buildStreamUrl, cleanUrl, decodeConfig } from "../src/addon-config.mjs";

function encodeConfig(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

test("configured manifest URL decodes upstream and result limit", () => {
  const config = { upstream: "https://example.test/manifest.json", max: 8 };
  assert.deepEqual(decodeConfig(encodeConfig(config)), config);
});

test("normalizes a manifest URL without dropping its configured path", () => {
  assert.equal(
    cleanUrl("https://example.test/user/config/manifest.json"),
    "https://example.test/user/config"
  );
});

test("appends stream route before preserving upstream query parameters", () => {
  assert.equal(
    buildStreamUrl("https://example.test/user/config/manifest.json?token=abc", "series", "tt123:1:2"),
    "https://example.test/user/config/stream/series/tt123%3A1%3A2.json?token=abc"
  );
});

test("rejects non-HTTP upstreams", () => {
  assert.equal(cleanUrl("file:///etc/passwd"), "");
  assert.throws(() => buildStreamUrl("file:///etc/passwd", "movie", "tt123"), /HTTP\(S\)/);
});
