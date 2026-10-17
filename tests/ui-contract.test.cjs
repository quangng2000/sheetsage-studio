"use strict";

// Source contracts supplement, but do not replace, native webview inspection.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ui = path.resolve(__dirname, "../desktop/ui");
const html = fs.readFileSync(path.join(ui, "index.html"), "utf8");
const app = fs.readFileSync(path.join(ui, "app.js"), "utf8");
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);

test("native host integration IDs exist exactly once", () => {
  assert.equal(new Set(ids).size, ids.length, "HTML must not contain duplicate IDs");
  for (const match of app.matchAll(/\$\("([^"]+)"\)/g)) {
    assert.ok(ids.includes(match[1]), `Missing host integration element: ${match[1]}`);
  }
});

test("all four musical views have accessible tab/panel wiring", () => {
  for (const tab of ["arrangement", "roll", "score", "events"]) {
    assert.ok(ids.includes(`tab-${tab}`));
    assert.ok(ids.includes(`panel-${tab}`));
    assert.match(html, new RegExp(`aria-controls="panel-${tab}"`));
    assert.match(html, new RegExp(`aria-labelledby="tab-${tab}"`));
  }
  assert.ok(ids.includes("arrangement-root"));
  assert.ok(ids.includes("artifact-select"));
  assert.ok(ids.includes("export-artifact"));
});

test("all scripts are packaged locally in dependency order", () => {
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(scripts, ["assets/abcjs-basic-min.js", "music-analysis.js", "audio-preview.js", "workspace-view.js", "app.js"]);
  for (const source of scripts) {
    assert.ok(!source.includes("://"), "No remote frontend code");
    assert.ok(fs.statSync(path.join(ui, source)).isFile(), `Missing bundled script: ${source}`);
  }
});
