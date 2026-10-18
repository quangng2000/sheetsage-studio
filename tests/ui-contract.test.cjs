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
  assert.deepEqual(scripts, ["assets/abcjs-basic-min.js", "music-analysis.js", "audio-preview.js", "workspace-view.js", "score-timing.js", "score-elements.js", "score-follow.js", "app.js"]);
  for (const source of scripts) {
    assert.ok(!source.includes("://"), "No remote frontend code");
    assert.ok(fs.statSync(path.join(ui, source)).isFile(), `Missing bundled script: ${source}`);
  }
});

test("notation retains the rendered SVG references used by score following", () => {
  assert.match(app, /ABCJS\.renderAbc\([^;]*oneSvgPerLine\s*:\s*false/);
  assert.match(app, /scoreFollow\?\.attach\(state\.result,\s*tunes\[0\]\)/);
  assert.ok(ids.includes("follow-audio"));
  assert.ok(ids.includes("score-follow-status"));
});

test("responsive ABC engraving is nested inside, not applied to, the bounded score viewport", () => {
  assert.match(app, /const engraving\s*=\s*document\.createElement\("div"\)/);
  assert.match(app, /engraving\.className\s*=\s*"score-engraving"/);
  assert.match(app, /output\.append\(engraving\)/);
  assert.match(app, /ABCJS\.renderAbc\(engraving,\s*state\.result\.abc/);
  assert.doesNotMatch(app, /ABCJS\.renderAbc\(output,/);
  assert.match(app, /ScoreFollow\?\.create\(\{root:\s*\$\("score-output"\)/);
});

test("the original audio clock drives score following and result replacement resets it", () => {
  assert.match(app, /scoreFollow\?\.setPlayback\(audio\.currentTime,\s*!audio\.paused,\s*state\.activeTab\s*===\s*"score"\)/);
  assert.match(app, /function renderResult\(result\)\s*\{[^}]*scoreFollow\?\.reset\(\)/);
  assert.match(app, /scoreFollow\?\.resize\(\)/);
  assert.match(app, /onSeek\s*:\s*seekTo/);
});
