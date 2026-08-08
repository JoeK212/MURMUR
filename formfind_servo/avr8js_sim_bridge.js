#!/usr/bin/env node
/*
  avr8js_sim_bridge.js
  ---------------------
  Runs the REAL formfind_servo.ino firmware — compiled with the actual AVR
  toolchain, not reimplemented — inside avr8js (github.com/wokwi/avr8js, MIT,
  the same simulation core that powers Wokwi itself). No Wokwi account, no
  VS Code extension, no RFC2217, no virtual COM port, no driver signing.
  Just Node.js running the genuine ATmega328p machine code.

  Speaks the exact same line protocol over the exact same default WebSocket
  port (8765) as the retired wokwi_ws_bridge.py, so FORMFIND's "Connect via
  Simulator Bridge" button and ws://localhost:8765 field work unchanged.

  WHAT'S ACTUALLY SIMULATED
  --------------------------
  - CPU: real ATmega328p core (avr8js), executing the real compiled firmware
  - Serial (USART0): FORMFIND's "A118,45,...\n" lines are fed in byte-by-byte
    at genuine 115200-baud timing; the firmware's own Serial.read()/println()
    do the real work — nothing about the protocol parsing is faked
  - Servos: NOT simulated as a physical servo model. The firmware's Servo
    library bit-bangs each pin via a Timer1 ISR exactly as it would on real
    hardware; this script listens to PORTB/PORTD pin transitions and measures
    the actual pulse widths in simulated CPU cycles, then decodes them back
    to 0-180 degree angles the same way a real servo's control circuitry
    would interpret them. If firmware logic writes a wrong angle, glitches,
    or fails to attach a servo, that shows up here exactly as it would on
    real hardware — because it IS the real hardware's logic running.
  - Sensor input (A0): no real potentiometer exists, so this script feeds a
    synthetic value into the ADC channel so the sketch's own analogRead()
    executes for real and the loop-closing "Sensor drives" feature has
    something to show. Default: a slow sweep 0-1023. Override with
    --sensor=<0-1023> for a fixed value, or --sensor=off for a silent A0.

  SETUP
  -----
  1. cd formfind_servo && npm install        (installs avr8js + ws)
  2. node avr8js_sim_bridge.js               (listens on ws://localhost:8765)
  3. In FORMFIND's Physical Rig panel, click "Connect via Simulator Bridge" —
     the default URL (ws://localhost:8765) already matches. No Wokwi account
     needed, no VS Code, no simulation panel to keep open.

  If formfind_servo.ino changes, rebuild formfind_servo.hex with
  build_hex.sh (needs gcc-avr + avr-libc; see that script's header comment)
  before restarting this bridge — it loads the .hex fresh on every launch,
  never the .ino source directly.

  Ctrl+C to stop.
*/
'use strict';

const fs = require('fs');
const path = require('path');
const {
  CPU,
  avrInstruction,
  AVRIOPort,
  AVRTimer,
  AVRUSART,
  AVRADC,
  portBConfig,
  portCConfig,
  portDConfig,
  timer0Config,
  timer1Config,
  timer2Config,
  usart0Config,
  adcConfig,
} = require('avr8js');
const WebSocket = require('ws');

// ---------- CLI args ----------
const args = process.argv.slice(2);
function argValue(name, fallback) {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
}
const WS_PORT = parseInt(argValue('port', '8765'), 10);
const HEX_PATH = argValue('hex', path.join(__dirname, 'formfind_servo.hex'));
const SENSOR_ARG = argValue('sensor', 'sweep'); // 'sweep' | 'off' | a number 0-1023
const DASHBOARD_PORT = parseInt(argValue('dashboard-port', '8766'), 10);
const DASHBOARD_ENABLED = !args.includes('--no-dashboard');

// ---------- Intel HEX loader (same minimal parser avr8js's own demo uses) ----------
function loadHex(source, target) {
  for (const line of source.split('\n')) {
    if (line[0] === ':' && line.substr(7, 2) === '00') {
      const bytes = parseInt(line.substr(1, 2), 16);
      const addr = parseInt(line.substr(3, 4), 16);
      for (let i = 0; i < bytes; i++) {
        target[addr + i] = parseInt(line.substr(9 + i * 2, 2), 16);
      }
    }
  }
}

if (!fs.existsSync(HEX_PATH)) {
  console.error(`Could not find ${HEX_PATH}`);
  console.error('Run build_hex.sh first, or pass --hex=/path/to/formfind_servo.hex');
  process.exit(1);
}

// ---------- CPU + peripherals (mirrors avr8js's own demo/src/execute.ts setup) ----------
const FLASH_WORDS = 0x8000; // 32K words = 64KB, matches ATmega328p program space
const MHZ = 16e6;

const program = new Uint16Array(FLASH_WORDS);
loadHex(fs.readFileSync(HEX_PATH, 'utf8'), new Uint8Array(program.buffer));

const cpu = new CPU(program);
new AVRTimer(cpu, timer0Config);
new AVRTimer(cpu, timer1Config); // the one Servo.h actually uses for pulse timing
new AVRTimer(cpu, timer2Config);
const portB = new AVRIOPort(cpu, portBConfig); // digital pins 8-13
new AVRIOPort(cpu, portCConfig); // A0-A5 (not used for GPIO decode here)
const portD = new AVRIOPort(cpu, portDConfig); // digital pins 0-7
const usart = new AVRUSART(cpu, usart0Config, MHZ);
const adc = new AVRADC(cpu, adcConfig);
adc.avcc = 5;

// ---------- Servo pin decode: SERVO_PINS = {2,3,4,5,6,7,8,9} in formfind_servo.ino ----------
// pins 2-7 -> PORTD bits 2-7, pins 8-9 -> PORTB bits 0-1 (standard Uno pin mapping)
const SERVO_PIN_MAP = [
  { port: 'D', bit: 2 }, { port: 'D', bit: 3 }, { port: 'D', bit: 4 }, { port: 'D', bit: 5 },
  { port: 'D', bit: 6 }, { port: 'D', bit: 7 }, { port: 'B', bit: 0 }, { port: 'B', bit: 1 },
];
const MIN_PULSE_US = 544;   // Servo.h MIN_PULSE_WIDTH
const MAX_PULSE_US = 2400;  // Servo.h MAX_PULSE_WIDTH

const riseCycle = { D: new Array(8).fill(null), B: new Array(8).fill(null) };
const currentAngles = new Array(SERVO_PIN_MAP.length).fill(90);

function handlePortEdges(port, value, oldValue) {
  const changed = value ^ oldValue;
  for (let bit = 0; bit < 8; bit++) {
    if (!((changed >> bit) & 1)) continue;
    const isHigh = !!((value >> bit) & 1);
    if (isHigh) {
      riseCycle[port][bit] = cpu.cycles;
    } else if (riseCycle[port][bit] !== null) {
      const pulseUs = (cpu.cycles - riseCycle[port][bit]) / (MHZ / 1e6);
      riseCycle[port][bit] = null;
      const idx = SERVO_PIN_MAP.findIndex((m) => m.port === port && m.bit === bit);
      if (idx !== -1 && pulseUs > 300 && pulseUs < 3000) { // sanity window; ignores non-servo glitches
        const angle = Math.round(
          Math.max(0, Math.min(180, ((pulseUs - MIN_PULSE_US) / (MAX_PULSE_US - MIN_PULSE_US)) * 180))
        );
        currentAngles[idx] = angle;
      }
    }
  }
}
portD.addListener((value, oldValue) => handlePortEdges('D', value, oldValue));
portB.addListener((value, oldValue) => handlePortEdges('B', value, oldValue));

// ---------- Sensor (A0) ----------
let sensorMode = 'sweep';
let sensorFixed = 512;
if (SENSOR_ARG === 'off') sensorMode = 'off';
else if (/^\d+$/.test(SENSOR_ARG)) { sensorMode = 'fixed'; sensorFixed = Math.max(0, Math.min(1023, parseInt(SENSOR_ARG, 10))); }

function sensorValueNow() {
  if (sensorMode === 'off') return 0;
  if (sensorMode === 'fixed') return sensorFixed;
  // slow ~12s sweep, 0-1023, so "Sensor drives" has something visibly alive to show
  const t = (cpu.cycles / MHZ) % 12;
  const phase = t < 6 ? t / 6 : (12 - t) / 6;
  return Math.round(phase * 1023);
}

// ---------- Real-time-paced execution loop ----------
// avr8js's own demo runs flat-out and just reports a speed percentage; that's fine for
// an interactive tab but wrong here — FORMFIND's sensor stream and servo timing need to
// track wall-clock at roughly 1x, or the ~20Hz "S<value>" cadence floods or crawls
// relative to what the browser expects. So this paces cycle execution to real time
// instead, in small substeps so queued serial bytes get injected at genuine baud timing.
const SUBSTEP_CYCLES = 200; // << one 115200-baud byte period (~1389 cycles) for fine injection timing
const MAX_CATCHUP_SEC = 0.25; // cap catch-up after a GC pause / slow tick, don't time-warp the firmware

let rxQueue = [];
function queueLine(text) {
  for (const ch of text) rxQueue.push(ch.charCodeAt(0) & 0xff);
}

let lastSensorUpdateCycles = 0;
const startWall = process.hrtime.bigint();

function tick() {
  const elapsedSec = Number(process.hrtime.bigint() - startWall) / 1e9;
  let targetCycles = Math.floor(elapsedSec * MHZ);
  if (targetCycles - cpu.cycles > MAX_CATCHUP_SEC * MHZ) {
    targetCycles = cpu.cycles + MAX_CATCHUP_SEC * MHZ;
  }
  while (cpu.cycles < targetCycles) {
    const stepTarget = Math.min(targetCycles, cpu.cycles + SUBSTEP_CYCLES);
    while (cpu.cycles < stepTarget) {
      avrInstruction(cpu);
      cpu.tick();
    }
    if (rxQueue.length && !usart.rxBusy) {
      usart.writeByte(rxQueue.shift());
    }
  }
  // Refresh the ADC channel a few times a second — analogRead() samples whatever is
  // in channelValues[0] at the moment of conversion, no need to update every cycle.
  if (cpu.cycles - lastSensorUpdateCycles > MHZ / 20) {
    adc.channelValues[0] = (sensorValueNow() / 1023) * 5; // 0-1023 -> 0-5V, matches AVCC reference
    lastSensorUpdateCycles = cpu.cycles;
  }
}
const tickTimer = setInterval(tick, 4);

// ---------- WebSocket server: same line protocol as wokwi_ws_bridge.py ----------
let sockets = new Set();
usart.onLineTransmit = (line) => {
  const msg = line + '\n';
  for (const ws of sockets) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
};

const wss = new WebSocket.Server({ port: WS_PORT });
wss.on('connection', (ws) => {
  sockets.add(ws);
  console.log(`Browser connected (${sockets.size} active). Firmware keeps running regardless of connections, same as real hardware.`);
  ws.on('message', (data) => {
    queueLine(data.toString());
  });
  ws.on('close', () => {
    sockets.delete(ws);
    console.log(`Browser disconnected (${sockets.size} active).`);
  });
  ws.on('error', () => {});
});

// ---------- Live browser dashboard: watch the real firmware's servo output move ----------
// This is a second, independent thing from the FORMFIND<->firmware WS link above — a small
// self-served page showing the SAME currentAngles this script already measures from real PWM,
// animated. Nothing here feeds back into the firmware or FORMFIND; it's read-only, purely so
// there's somewhere to *watch* what avr8js_sim_bridge.js proved was happening in the terminal
// numbers. Unlike FORMFIND's own "Show simulated rig" checkbox (which mirrors FORMFIND's
// on-screen state), every angle drawn here came from measuring the real firmware's real PWM
// pulses — if the firmware misbehaves, this dashboard is wrong in the same way, which is the
// point.
let httpServer = null;
let dashboardWss = null;
const dashboardSockets = new Set();

if (DASHBOARD_ENABLED) {
  const http = require('http');
  const DASHBOARD_HTML = buildDashboardHtml(SERVO_PIN_MAP.length);

  httpServer = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(DASHBOARD_HTML);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
  });

  dashboardWss = new WebSocket.Server({ server: httpServer });
  dashboardWss.on('connection', (ws) => {
    dashboardSockets.add(ws);
    ws.on('close', () => dashboardSockets.delete(ws));
    ws.on('error', () => {});
  });

  httpServer.listen(DASHBOARD_PORT);

  setInterval(() => {
    if (!dashboardSockets.size) return;
    const msg = JSON.stringify({
      angles: currentAngles,
      simTime: cpu.cycles / MHZ,
      sensor: Math.round(sensorValueNow()),
      formfindConnected: sockets.size > 0,
    });
    for (const ws of dashboardSockets) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  }, 50); // ~20Hz, matches the firmware's own sensor-send cadence
}

function buildDashboardHtml(numServos) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FORMFIND — avr8js live rig</title>
<style>
  :root{
    --paper:#0B0C0E; --paper-deep:#060708; --card:#131519;
    --ink:#E8E9EB; --ink-soft:#8A8F98; --line:#23262C;
    --accent:#7DD3FC; --accent-deep:#38BDF8;
  }
  *{box-sizing:border-box;}
  html,body{ height:100%; }
  body{
    margin:0; background:var(--paper-deep); color:var(--ink);
    font-family:-apple-system,'Space Grotesk','Inter',sans-serif;
    overflow:hidden;
  }
  #c{ position:fixed; inset:0; display:block; z-index:0; }
  .overlay{ position:relative; z-index:1; display:flex; flex-direction:column; align-items:center;
    padding:22px 16px 0; pointer-events:none; }
  h1{font-size:15px; font-weight:600; letter-spacing:0.02em; margin:0 0 4px; color:var(--ink); text-shadow:0 1px 8px rgba(0,0,0,0.6);}
  .sub{font-size:12px; color:var(--ink-soft); margin:0 0 18px; text-align:center; max-width:560px; line-height:1.5; text-shadow:0 1px 8px rgba(0,0,0,0.6);}
  .statusRow{display:flex; gap:18px; align-items:center; margin-bottom:10px; flex-wrap:wrap; justify-content:center; pointer-events:auto;}
  .stat{background:rgba(19,21,25,0.72); backdrop-filter:blur(6px); border:1px solid var(--line); border-radius:8px; padding:8px 14px; font-size:12px; color:var(--ink-soft); display:flex; align-items:center; gap:7px;}
  .stat b{color:var(--ink); font-weight:600;}
  .dot{width:7px; height:7px; border-radius:50%; background:#555; flex:none;}
  .dot.live{background:var(--accent); box-shadow:0 0 8px var(--accent-deep);}
  .disconnectedNote{margin-top:16px; font-size:12px; color:var(--ink-soft); text-align:center; max-width:420px; line-height:1.5; pointer-events:auto;
    background:rgba(19,21,25,0.72); backdrop-filter:blur(6px); border:1px solid var(--line); border-radius:8px; padding:10px 14px;}
</style>
</head>
<body>
  <canvas id="c"></canvas>
  <div class="overlay">
    <h1>FORMFIND — avr8js live rig</h1>
    <p class="sub">Each glowing emitter is one servo channel; particles burst from it in real time, driven by the real formfind_servo.ino firmware's real PWM output measured off the simulated pins — not FORMFIND's on-screen state, not a mock. Burst size/speed = how far and how fast that channel's real angle is moving right now. The core pulses with the real A0 sensor reading, and the whole field dims and slows the moment the bridge loses FORMFIND — the three real-data signals here are per-emitter motion, core pulse, and dim/wake.</p>
    <div class="statusRow">
      <div class="stat"><span class="dot" id="dashDot"></span> dashboard <b id="dashState">connecting…</b></div>
      <div class="stat"><span class="dot" id="ffDot"></span> FORMFIND <b id="ffState">not connected</b></div>
      <div class="stat">sim time <b id="simTime">0.0s</b></div>
      <div class="stat">A0 sensor <b id="sensorVal">—</b></div>
    </div>
    <p class="disconnectedNote" id="disconnectedNote" style="display:none;">Lost the connection to avr8js_sim_bridge.js — make sure that terminal is still running, then reload this page.</p>
  </div>

<script type="importmap">
{
  "imports": {
    "three": "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js",
    "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"
  }
}
</script>
<script type="module">
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

var NUM = ${numServos};

// ---------- renderer / scene / camera ----------
var canvas = document.getElementById('c');
var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.outputColorSpace = THREE.SRGBColorSpace;

var scene = new THREE.Scene();
scene.background = new THREE.Color(0x060708);
scene.fog = new THREE.FogExp2(0x060708, 0.028);

var camera = new THREE.PerspectiveCamera(52, window.innerWidth / window.innerHeight, 0.1, 300);
camera.position.set(0, 7, 25);
camera.lookAt(0, 0, 0);

var rig = new THREE.Group();
scene.add(rig);

var composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
var bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 1.3, 0.65, 0.12);
composer.addPass(bloomPass);

// ---------- background starfield (depth only, not data-driven) ----------
(function(){
  var STAR_COUNT = 500;
  var starPos = new Float32Array(STAR_COUNT * 3);
  for (var s = 0; s < STAR_COUNT; s++) {
    var r = 40 + Math.random() * 60;
    var theta = Math.random() * Math.PI * 2;
    var phi = Math.acos((Math.random() * 2) - 1);
    starPos[s * 3] = r * Math.sin(phi) * Math.cos(theta);
    starPos[s * 3 + 1] = r * Math.cos(phi) * 0.5;
    starPos[s * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
  }
  var starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  var starMat = new THREE.PointsMaterial({ color: 0x23262C, size: 0.35, sizeAttenuation: true, transparent: true, opacity: 0.6 });
  scene.add(new THREE.Points(starGeo, starMat));
})();

// ---------- core: pulses with the real A0 sensor reading ----------
var coreGeo = new THREE.IcosahedronGeometry(2, 3);
var coreMat = new THREE.MeshBasicMaterial({ color: 0x7DD3FC, wireframe: true, transparent: true, opacity: 0.55 });
var core = new THREE.Mesh(coreGeo, coreMat);
rig.add(core);
var coreLight = new THREE.PointLight(0x38BDF8, 3, 45, 2);
rig.add(coreLight);

// ---------- per-servo emitters, arranged on a ring ----------
var RING_RADIUS = 9.5;
var emitterPositions = [];
for (var i = 0; i < NUM; i++) {
  var theta2 = (i / NUM) * Math.PI * 2;
  emitterPositions.push(new THREE.Vector3(Math.cos(theta2) * RING_RADIUS, 0, Math.sin(theta2) * RING_RADIUS));
}

function hueForEmitter(i) { return 0.52 + (i / NUM) * 0.32; } // cyan -> violet band

// small glow marker per emitter, brightens with that channel's real energy
var emitterMarkers = [];
for (var m = 0; m < NUM; m++) {
  var markerColor = new THREE.Color().setHSL(hueForEmitter(m), 0.8, 0.62);
  var markerGeo = new THREE.SphereGeometry(0.22, 12, 12);
  var markerMat = new THREE.MeshBasicMaterial({ color: markerColor, transparent: true, opacity: 0.85 });
  var marker = new THREE.Mesh(markerGeo, markerMat);
  marker.position.copy(emitterPositions[m]);
  rig.add(marker);
  emitterMarkers.push(marker);
}

// ---------- particle burst system, additive sprites, custom shader for per-particle size ----------
var PER_EMITTER = 46;
var TOTAL = NUM * PER_EMITTER;
var positions = new Float32Array(TOTAL * 3);
var colorsAttr = new Float32Array(TOTAL * 3);
var sizesAttr = new Float32Array(TOTAL);

var pVel = [];
var pAge = new Float32Array(TOTAL);
var pLife = new Float32Array(TOTAL);
var pEmitter = new Uint16Array(TOTAL);
var pBaseColor = [];

function spriteTexture() {
  var cvs = document.createElement('canvas');
  cvs.width = cvs.height = 64;
  var ctx = cvs.getContext('2d');
  var g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(cvs);
}
var spriteTex = spriteTexture();

function respawnParticle(p, energy) {
  var e = pEmitter[p];
  var origin = emitterPositions[e];
  positions[p * 3] = origin.x;
  positions[p * 3 + 1] = origin.y;
  positions[p * 3 + 2] = origin.z;
  var dir = new THREE.Vector3((Math.random() - 0.5), (Math.random() - 0.25) * 1.6, (Math.random() - 0.5)).normalize();
  var speed = 2.6 + energy * 9.5 + Math.random() * 1.2; // higher baseline + wider energy range so bursts read clearly, not just shimmer
  pVel[p] = dir.multiplyScalar(speed);
  pAge[p] = 0;
  pLife[p] = 0.45 + Math.random() * 0.75; // shorter life so fast-moving particles read as a burst arc, not a slow drift
  sizesAttr[p] = 0;
}

for (var p = 0; p < TOTAL; p++) {
  pEmitter[p] = Math.floor(p / PER_EMITTER);
  var c = new THREE.Color().setHSL(hueForEmitter(pEmitter[p]), 0.85, 0.62);
  pBaseColor.push(c);
  colorsAttr[p * 3] = c.r; colorsAttr[p * 3 + 1] = c.g; colorsAttr[p * 3 + 2] = c.b;
  respawnParticle(p, 0);
  pAge[p] = Math.random() * pLife[p]; // desync initial bursts so they don't all fire in unison
}

var geo = new THREE.BufferGeometry();
geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
geo.setAttribute('color', new THREE.BufferAttribute(colorsAttr, 3));
geo.setAttribute('size', new THREE.BufferAttribute(sizesAttr, 1));

var particleMat = new THREE.ShaderMaterial({
  uniforms: { map: { value: spriteTex } },
  vertexShader: [
    'attribute float size;',
    'attribute vec3 color;',
    'varying vec3 vColor;',
    'void main(){',
    '  vColor = color;',
    '  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);',
    '  gl_PointSize = size * (420.0 / -mvPosition.z);',
    '  gl_Position = projectionMatrix * mvPosition;',
    '}'
  ].join(' '),
  fragmentShader: [
    'precision mediump float;',
    'uniform sampler2D map;',
    'varying vec3 vColor;',
    'void main(){',
    '  vec4 tex = texture2D(map, gl_PointCoord);',
    '  gl_FragColor = vec4(vColor, 1.0) * tex;',
    '}'
  ].join(' '),
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending
});
var points = new THREE.Points(geo, particleMat);
rig.add(points);

// ---------- live data state ----------
var angleEnergy = new Float32Array(NUM);   // smoothed 0..1 "how alive" each channel is right now
var lastAngle = new Float32Array(NUM).fill(90);
var haveAngle = new Uint8Array(NUM);
var latestSensor = 0;      // 0..1023
var sensorSmooth = 0;      // 0..1
var connected = false;
var connectedSmooth = 0;   // eases the wake/sleep transition instead of snapping

var dashDot = document.getElementById('dashDot');
var dashState = document.getElementById('dashState');
var ffDot = document.getElementById('ffDot');
var ffState = document.getElementById('ffState');
var simTimeEl = document.getElementById('simTime');
var sensorEl = document.getElementById('sensorVal');
var note = document.getElementById('disconnectedNote');

function connectSocket() {
  var ws = new WebSocket('ws://' + location.host);
  ws.onopen = function () {
    dashDot.classList.add('live'); dashState.textContent = 'live'; note.style.display = 'none';
  };
  ws.onmessage = function (evt) {
    var data;
    try { data = JSON.parse(evt.data); } catch (e) { return; }
    if (Array.isArray(data.angles)) {
      for (var i = 0; i < data.angles.length && i < NUM; i++) {
        var a = data.angles[i];
        var deviation = Math.abs(a - 90) / 90;               // 0..1, how far from neutral
        var delta = haveAngle[i] ? Math.abs(a - lastAngle[i]) / 90 : 0; // 0..~1+, how fast it just moved
        var instant = Math.min(1, deviation * 0.5 + delta * 2.2);
        angleEnergy[i] = angleEnergy[i] * 0.75 + instant * 0.25; // smoothed, but responsive within a few frames
        lastAngle[i] = a; haveAngle[i] = 1;
      }
    }
    if (typeof data.simTime === 'number') simTimeEl.textContent = data.simTime.toFixed(1) + 's';
    if (typeof data.sensor === 'number') { latestSensor = data.sensor; sensorEl.textContent = data.sensor + ' / 1023'; }
    connected = !!data.formfindConnected;
    ffDot.classList.toggle('live', connected);
    ffState.textContent = connected ? 'connected' : 'not connected';
  };
  ws.onclose = function () {
    dashDot.classList.remove('live'); dashState.textContent = 'disconnected'; note.style.display = 'block';
    connected = false;
    setTimeout(connectSocket, 1500);
  };
  ws.onerror = function () { ws.close(); };
}
connectSocket();

// ---------- animate ----------
var clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  var dt = Math.min(clock.getDelta(), 0.05);
  var t = clock.elapsedTime;

  connectedSmooth += ((connected ? 1 : 0.3) - connectedSmooth) * Math.min(1, dt * 1.5);
  sensorSmooth += ((latestSensor / 1023) - sensorSmooth) * Math.min(1, dt * 3);

  var avgEnergy = 0;
  for (var i = 0; i < NUM; i++) avgEnergy += angleEnergy[i];
  avgEnergy = NUM ? (avgEnergy / NUM) : 0;

  // emitter markers brighten with their own channel's real energy
  for (var m = 0; m < NUM; m++) {
    var em = angleEnergy[m] * connectedSmooth;
    var scale = 1 + em * 1.8;
    emitterMarkers[m].scale.setScalar(scale);
    emitterMarkers[m].material.opacity = (0.35 + em * 0.65) * (0.4 + connectedSmooth * 0.6);
  }

  // particles: continuous respawn scaled by that channel's energy — always some drift even idle,
  // never fully dead, same "no dead zone on the slider" principle as the main app's turbulence fix
  var posAttr = geo.attributes.position;
  var sizeAttr = geo.attributes.size;
  for (var p = 0; p < TOTAL; p++) {
    pAge[p] += dt;
    if (pAge[p] >= pLife[p]) {
      respawnParticle(p, angleEnergy[pEmitter[p]] * connectedSmooth);
    }
    var lifeT = pAge[p] / pLife[p]; // 0..1
    positions[p * 3] += pVel[p].x * dt;
    positions[p * 3 + 1] += pVel[p].y * dt;
    positions[p * 3 + 2] += pVel[p].z * dt;
    var fade = Math.sin(Math.min(1, lifeT) * Math.PI); // ramps up then back down over its life
    var energyHere = angleEnergy[pEmitter[p]] * connectedSmooth;
    sizesAttr[p] = (2.2 + energyHere * 6.5) * fade;
  }
  posAttr.needsUpdate = true;
  sizeAttr.needsUpdate = true;

  // core pulses with the real A0 sensor reading + overall energy
  var pulse = 1 + sensorSmooth * 0.5 + avgEnergy * 0.35;
  core.scale.setScalar(pulse * connectedSmooth + (1 - connectedSmooth) * 0.7);
  core.rotation.y += dt * (0.15 + avgEnergy * 0.6);
  core.rotation.x += dt * 0.05;
  coreLight.intensity = (1.5 + sensorSmooth * 4 + avgEnergy * 3) * connectedSmooth;

  // slow cinematic orbit, speeds up a little with overall energy — never stops
  rig.rotation.y += dt * (0.045 + avgEnergy * 0.09) * (0.4 + connectedSmooth * 0.6);

  bloomPass.strength = (0.9 + avgEnergy * 1.6 + sensorSmooth * 0.6) * (0.35 + connectedSmooth * 0.65);

  composer.render();
}
animate();

window.addEventListener('resize', function () {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});
</script>
</body>
</html>`;
}

console.log(`FORMFIND avr8js simulator bridge`);
console.log(`  Firmware: ${HEX_PATH}`);
console.log(`  Sensor mode: ${sensorMode}${sensorMode === 'fixed' ? ` (${sensorFixed})` : ''}`);
console.log(`  Listening on ws://localhost:${WS_PORT}`);
console.log(`  In FORMFIND's Physical Rig panel: "Connect via Simulator Bridge" (URL already defaults to this port).`);
if (DASHBOARD_ENABLED) {
  console.log(`  Live visual dashboard: http://localhost:${DASHBOARD_PORT} (open this in a browser tab to watch the arms move)`);
} else {
  console.log(`  Dashboard disabled (--no-dashboard).`);
}
console.log(`  Ctrl+C to stop.`);

setInterval(() => {
  const angleStr = currentAngles.map((a) => String(a).padStart(3, ' ')).join(',');
  process.stdout.write(`\r  servo angles: [${angleStr}]  sim time: ${(cpu.cycles / MHZ).toFixed(1)}s   `);
}, 500);

process.on('SIGINT', () => {
  clearInterval(tickTimer);
  wss.close();
  if (httpServer) httpServer.close();
  if (dashboardWss) dashboardWss.close();
  console.log('\nStopped.');
  process.exit(0);
});
