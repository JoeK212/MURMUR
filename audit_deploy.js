#!/usr/bin/env node
/**
 * FORMFIND — deploy audit
 * Joe.K · axisbim.io
 *
 * Local-only pre-ship check for index.html and CHANGELOG.md. Run before every deploy:
 *   node audit_deploy.js
 *
 * Not a linter — checks project-specific invariants that have broken before or would
 * silently break the app if regressed. Exits 1 on any failure so it can gate a deploy
 * script if desired.
 *
 * Growth pattern: every time a bug is found and fixed, add a check() for it in the same
 * edit that fixes it, under a new sectionHeader() named after the version that fixed it.
 * The section list becomes a second, testable copy of the changelog.
 *
 * Pitfall (recurring on SPIRA): a check written as "X doesn't appear anywhere in src" can
 * false-positive on the changelog's OWN prose describing X, or a comment mentioning the
 * string. Anchor negative checks to the actual code region once changelog/comments are
 * likely to reference the thing being checked for.
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'index.html');
if (!fs.existsSync(FILE)) {
  console.error(`✗ Could not find index.html next to this script at ${FILE}`);
  process.exit(1);
}
const src = fs.readFileSync(FILE, 'utf8');

const CHANGELOG_FILE = path.join(__dirname, 'CHANGELOG.md');
if (!fs.existsSync(CHANGELOG_FILE)) {
  console.error(`✗ Could not find CHANGELOG.md next to this script at ${CHANGELOG_FILE}`);
  process.exit(1);
}
const changelog = fs.readFileSync(CHANGELOG_FILE, 'utf8');

const BRIDGE_FILE = path.join(__dirname, 'hardware-bridge.js');
const bridgeSrc = fs.existsSync(BRIDGE_FILE) ? fs.readFileSync(BRIDGE_FILE, 'utf8') : null;

const RESET = '\x1b[0m', GREEN = '\x1b[32m', RED = '\x1b[31m', DIM = '\x1b[2m', BOLD = '\x1b[1m';

let pass = 0, fail = 0;
const failures = [];

function sectionHeader(name) {
  console.log(`\n${BOLD}${name}${RESET}`);
}

function check(desc, cond) {
  if (cond) {
    pass++;
    console.log(`  ${GREEN}✓${RESET} ${desc}`);
  } else {
    fail++;
    failures.push(desc);
    console.log(`  ${RED}✗${RESET} ${desc}`);
  }
}

/* ===================== Version sync ===================== */
sectionHeader('Version sync');
const versionMatch = src.match(/const APP_VERSION = '([\d.]+)'/);
const changelogTopMatch = changelog.match(/^v([\d.]+) - \d{4}-\d{2}-\d{2}/m);
check('APP_VERSION constant is defined', !!versionMatch);
check('CHANGELOG.md top entry version matches APP_VERSION', !!versionMatch && !!changelogTopMatch && versionMatch[1] === changelogTopMatch[1]);
check('footer renders APP_VERSION via template literal (not a hardcoded string)', /v\$\{APP_VERSION\}/.test(src));
check('index.html header comment has no leftover CHANGELOG block (changelog lives in CHANGELOG.md now)', !/CHANGELOG/.test(src.slice(0, src.indexOf('<html'))));

/* ===================== Debug / leftover artifacts ===================== */
sectionHeader('Debug / leftover artifacts');
check('no console.log left in source', !/console\.log\(/.test(src));
check('no debugger statements', !/\bdebugger\b/.test(src));
check('no lorem ipsum placeholder text', !/lorem ipsum/i.test(src));
check('no leftover alert( calls (toast() is the pattern here)', !/\balert\(/.test(src));
check('no leftover native confirm( calls (confirmDialog() is the pattern here — see below)', !/[^a-zA-Z]confirm\(['"`]/.test(src));

/* ===================== Escaping / XSS hygiene ===================== */
sectionHeader('Escaping / XSS hygiene');
check('escapeHtml() helper defined', /function escapeHtml\(/.test(src));
check('escapeAttr() helper defined', /function escapeAttr\(/.test(src));
check('no eval( in source', !/\beval\(/.test(src));

/* ===================== iOS / mobile baseline ===================== */
sectionHeader('iOS / mobile baseline');
check('viewport meta includes viewport-fit=cover (required for env(safe-area-inset-*) to work)', /viewport-fit=cover/.test(src));
check('body has overscroll-behavior-y:contain (prevents pull-to-refresh from wiping unsaved input)', /overscroll-behavior-y:contain;/.test(src));
check('both apple-mobile-web-app-capable and the modern mobile-web-app-capable meta tags present', /name="apple-mobile-web-app-capable"/.test(src) && /name="mobile-web-app-capable"/.test(src));
check('confirmDialog() function defined (custom modal, not native confirm — iOS standalone mode silently no-ops confirm())', /function confirmDialog\(/.test(src));
check('text/url inputs use 16px font-size if present (prevents iOS auto-zoom-on-focus)',
  (!/input\[type=text\]/.test(src) || /input\[type=text\][^{]*\{[^}]*font-size:16px/.test(src)) &&
  (!/input\[type=url\]/.test(src) || /input\[type=url\][^{]*\{[^}]*font-size:16px/.test(src)));

/* ===================== Toast / status messaging ===================== */
sectionHeader('Toast / status messaging');
check('toast() helper defined', /function toast\(/.test(src));
check('#toast element present in static markup (outside dynamically-rendered main)', /<div class="toast" id="toast">/.test(src));

/* ===================== v1.0.0: TDZ regression guard =====================
   render() runs synchronously inside the boot() IIFE. If `const engine = {...}`
   (or GRID_COLS/SPHERE_COUNT/etc.) is declared later in the same script than
   boot() is invoked, boot() throws "Cannot access 'engine' before initialization"
   and the app never renders — this happened once during the initial build. */
sectionHeader('v1.0.0 — TDZ regression guard');
{
  const engineDeclIdx = src.indexOf("const engine = {");
  const bootCallIdx = src.search(/\(function boot\(\)\{[\s\S]*?\}\)\(\);/);
  check('engine state object is declared', engineDeclIdx !== -1);
  check('boot() IIFE is present', bootCallIdx !== -1);
  check('engine declared before boot() runs (prevents TDZ crash on load)',
    engineDeclIdx !== -1 && bootCallIdx !== -1 && engineDeclIdx < bootCallIdx);
  const gridColsIdx = src.indexOf('const GRID_COLS');
  check('GRID_COLS declared before boot() runs', gridColsIdx !== -1 && gridColsIdx < bootCallIdx);
}

/* ===================== v1.2.1: instanced vertexColors regression guard =====================
   Per-instance vertexColors on InstancedMesh rendered near-black in this three.js build,
   confirmed even with plain white colors and MeshBasicMaterial — not a lighting/color-space
   issue, the instanced-color path itself was broken. Fixed by using one solid-material
   InstancedMesh per color category instead. Guard against reintroducing vertexColors. */
sectionHeader('v1.2.1 — instanced vertexColors regression guard');
check('sphere material does not use vertexColors (renders near-black in this three.js build)', !/vertexColors\s*:\s*true/.test(src));
check('categoryMeshes bucket-mesh pattern is present', /categoryMeshes/.test(src));

/* ===================== v1.4.0 — hardware bridge ===================== */
sectionHeader('v1.4.0 — hardware bridge (WebSerial)');
check('feature-detects navigator.serial before use', /'serial' in navigator/.test(src));
check('servo angles are clamped via mapRange before sending', /mapRange\(avg, HW_HEIGHT_MIN, HW_HEIGHT_MAX, HW_ANGLE_MIN, HW_ANGLE_MAX\)/.test(src));

/* ===================== v1.8.0 — closed-loop sensor input ===================== */
sectionHeader('v1.8.0 — closed-loop sensor input');
check('sensor target dropdown exists with off/turbulence/speed options', /id="hwSensorTarget"/.test(src) && /value="turbulence"/.test(src) && /value="speed"/.test(src));

/* ===================== v1.9.0 — hardware-bridge.js extraction =====================
   The WebSerial connect/disconnect/send-loop/read-loop logic that used to live in
   index.html moved to shared/hardware-bridge.js so other generative-design-tools can
   reuse it (see brise-soleil integration). index.html now only supplies getAngles /
   onSensorReading / onStatusChange callbacks. These checks validate the split itself
   stayed correct — that index.html didn't quietly keep its own duplicate copy of the
   connection logic, and that the shared file (when present alongside this script)
   still does its own job correctly. */
sectionHeader('v1.9.0 — hardware-bridge.js extraction');
check('index.html dynamically imports the shared bridge module (same pattern as three.js)', /await import\('\.\/hardware-bridge\.js'\)/.test(src));
check('index.html does not keep its own duplicate connect/disconnect/read-loop logic', !/async function connectHardware\(/.test(src) && !/async function readHardwareLoop\(/.test(src));
check('serial send interval constant still passed through to the bridge', /sendIntervalMs:\s*HW_SEND_INTERVAL_MS/.test(src));
if(bridgeSrc){
  check('hardware-bridge.js: feature-detects navigator.serial before use', /'serial' in navigator/.test(bridgeSrc));
  check('hardware-bridge.js: reader is cancelled on disconnect (not just writer/port closed)', /state\.reader.*\.cancel\(\)/.test(bridgeSrc));
  check('hardware-bridge.js: sensor lines distinguished by marker prefix', /line\.charAt\(0\) === 'S'/.test(bridgeSrc));
  check('hardware-bridge.js: write failures trigger disconnect rather than throwing uncaught', /Lost connection to Arduino/.test(bridgeSrc) && /await disconnect\(\)/.test(bridgeSrc));
  check('hardware-bridge.js: send loop is interval-based, not tied to a render loop', /setInterval/.test(bridgeSrc));
} else {
  console.log(`  ${DIM}(hardware-bridge.js not found alongside this script — skipping its internal checks; index.html-side checks above still ran)${RESET}`);
}

/* ===================== v1.10.0 — Wokwi circuit embed ===================== */
sectionHeader('v1.10.0 — Wokwi circuit embed');
check('iframe src is built from an extracted numeric ID, never the raw pasted string', /iframe\.src = `https:\/\/wokwi\.com\/projects\/\$\{m\[1\]\}`/.test(src));
check('ID extraction uses a numeric-only regex (rules out javascript:/data: URL injection)', /raw\.match\(\/\(\\d\{6,\}\)\//.test(src));

/* ===================== Summary ===================== */
console.log(`\n${BOLD}${'-'.repeat(40)}${RESET}`);
console.log(`${GREEN}${pass} passed${RESET}, ${fail ? RED : DIM}${fail} failed${RESET}`);
if (fail) {
  console.log(`\n${RED}${BOLD}Failures:${RESET}`);
  failures.forEach(f => console.log(`  ${RED}✗${RESET} ${f}`));
  process.exit(1);
} else {
  console.log(`${GREEN}All checks passed — clear to ship.${RESET}`);
  process.exit(0);
}
