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
  body{
    margin:0; background:var(--paper); color:var(--ink);
    font-family:-apple-system,'Space Grotesk','Inter',sans-serif;
    min-height:100vh; display:flex; flex-direction:column; align-items:center;
    padding:28px 16px 40px;
  }
  h1{font-size:15px; font-weight:600; letter-spacing:0.02em; margin:0 0 4px; color:var(--ink);}
  .sub{font-size:12px; color:var(--ink-soft); margin:0 0 22px; text-align:center; max-width:560px; line-height:1.5;}
  .statusRow{display:flex; gap:18px; align-items:center; margin-bottom:26px; flex-wrap:wrap; justify-content:center;}
  .stat{background:var(--card); border:1px solid var(--line); border-radius:8px; padding:8px 14px; font-size:12px; color:var(--ink-soft); display:flex; align-items:center; gap:7px;}
  .stat b{color:var(--ink); font-weight:600;}
  .dot{width:7px; height:7px; border-radius:50%; background:#555; flex:none;}
  .dot.live{background:var(--accent); box-shadow:0 0 8px var(--accent-deep);}
  .rig{
    display:flex; gap:14px; flex-wrap:wrap; justify-content:center;
    background:var(--paper-deep); border:1px solid var(--line); border-radius:14px;
    padding:32px 20px 20px;
  }
  .servo{display:flex; flex-direction:column; align-items:center; gap:8px; width:70px;}
  .servo .angle{font-size:12px; color:var(--accent); font-variant-numeric:tabular-nums; min-height:16px;}
  .servo .idx{font-size:10px; color:var(--ink-soft); letter-spacing:0.05em;}
  svg{overflow:visible;}
  .arm{transition:transform 60ms linear;}
  .disconnectedNote{margin-top:22px; font-size:12px; color:var(--ink-soft); text-align:center; max-width:420px; line-height:1.5;}
  /* Idle secondary motion — decorative only, driven by elapsed time (CSS animation-delay gives
     each figure a phase offset for a wave effect), not by any servo data. The .arm group's
     transform (set from JS in setAngle) is the only piece of this tied to real angle data. */
  @keyframes idleBob { 0%,100%{ transform:translateY(0); } 50%{ transform:translateY(-4px); } }
  @keyframes legSwingL { 0%,100%{ transform:rotate(0deg); } 50%{ transform:rotate(6deg); } }
  @keyframes legSwingR { 0%,100%{ transform:rotate(0deg); } 50%{ transform:rotate(-6deg); } }
  @keyframes restArmSway { 0%,100%{ transform:rotate(0deg); } 50%{ transform:rotate(10deg); } }
  .figureSvg{ animation: idleBob 1.8s ease-in-out infinite; }
  .legL{ animation: legSwingL 1.8s ease-in-out infinite; }
  .legR{ animation: legSwingR 1.8s ease-in-out infinite; }
  .restArm{ animation: restArmSway 2.6s ease-in-out infinite; }
</style>
</head>
<body>
  <h1>FORMFIND — avr8js live rig</h1>
  <p class="sub">Every figure below is a popsicle-stick person whose arm is driven by the real formfind_servo.ino firmware's real PWM output, measured off the simulated pins — not FORMFIND's on-screen state, not a mock. (The idle bob/leg-sway is just decoration to keep them from looking frozen — only the one swinging arm per figure is actual data.)</p>
  <div class="statusRow">
    <div class="stat"><span class="dot" id="dashDot"></span> dashboard <b id="dashState">connecting…</b></div>
    <div class="stat"><span class="dot" id="ffDot"></span> FORMFIND <b id="ffState">not connected</b></div>
    <div class="stat">sim time <b id="simTime">0.0s</b></div>
    <div class="stat">A0 sensor <b id="sensorVal">—</b></div>
  </div>
  <div class="rig" id="rig"></div>
  <p class="disconnectedNote" id="disconnectedNote" style="display:none;">Lost the connection to avr8js_sim_bridge.js — make sure that terminal is still running, then reload this page.</p>

<script>
(function(){
  const NUM = ${numServos};
  const rig = document.getElementById('rig');
  const arms = [];
  const labels = [];
  const STICK = '#E3B77A'; // popsicle-wood tone, matches the Three.js preview's stickMat

  for (let i = 0; i < NUM; i++) {
    const wrap = document.createElement('div');
    wrap.className = 'servo';
    const svgns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgns, 'svg');
    svg.setAttribute('width', '64'); svg.setAttribute('height', '104'); svg.setAttribute('viewBox', '0 0 70 116');
    svg.setAttribute('class', 'figureSvg');
    const delay = (i * 0.12).toFixed(2) + 's';
    svg.style.animationDelay = delay;

    // legs — hip at (35,66) down to feet at y=100, idle-swaying (decorative, phase-offset per figure)
    const legL = document.createElementNS(svgns, 'line');
    legL.setAttribute('x1', '35'); legL.setAttribute('y1', '66'); legL.setAttribute('x2', '25'); legL.setAttribute('y2', '100');
    legL.setAttribute('stroke', STICK); legL.setAttribute('stroke-width', '4'); legL.setAttribute('stroke-linecap', 'round');
    legL.setAttribute('class', 'legL'); legL.style.transformOrigin = '35px 66px'; legL.style.animationDelay = delay;
    svg.appendChild(legL);
    const legR = document.createElementNS(svgns, 'line');
    legR.setAttribute('x1', '35'); legR.setAttribute('y1', '66'); legR.setAttribute('x2', '45'); legR.setAttribute('y2', '100');
    legR.setAttribute('stroke', STICK); legR.setAttribute('stroke-width', '4'); legR.setAttribute('stroke-linecap', 'round');
    legR.setAttribute('class', 'legR'); legR.style.transformOrigin = '35px 66px'; legR.style.animationDelay = delay;
    svg.appendChild(legR);

    // torso (static) — hip (35,66) up to shoulder (35,34)
    const torso = document.createElementNS(svgns, 'line');
    torso.setAttribute('x1', '35'); torso.setAttribute('y1', '66'); torso.setAttribute('x2', '35'); torso.setAttribute('y2', '34');
    torso.setAttribute('stroke', STICK); torso.setAttribute('stroke-width', '5'); torso.setAttribute('stroke-linecap', 'round');
    svg.appendChild(torso);

    // head (static)
    const head = document.createElementNS(svgns, 'circle');
    head.setAttribute('cx', '35'); head.setAttribute('cy', '18'); head.setAttribute('r', '10');
    head.setAttribute('fill', 'var(--accent)');
    svg.appendChild(head);

    // resting arm — idle-swaying (decorative), a second arm so it reads as a figure, not just one stick with an arm
    const restArm = document.createElementNS(svgns, 'line');
    restArm.setAttribute('x1', '35'); restArm.setAttribute('y1', '34'); restArm.setAttribute('x2', '43'); restArm.setAttribute('y2', '60');
    restArm.setAttribute('stroke', STICK); restArm.setAttribute('stroke-width', '4'); restArm.setAttribute('stroke-linecap', 'round');
    restArm.setAttribute('class', 'restArm'); restArm.style.transformOrigin = '35px 34px'; restArm.style.animationDelay = (i * 0.18).toFixed(2) + 's';
    svg.appendChild(restArm);

    // driven arm — pivots at the shoulder (35,34); hangs straight down by default (0-180 servo -> ±90° swing)
    const armGroup = document.createElementNS(svgns, 'g');
    armGroup.setAttribute('class', 'arm');
    armGroup.style.transformOrigin = '35px 34px';
    const armLine = document.createElementNS(svgns, 'line');
    armLine.setAttribute('x1', '35'); armLine.setAttribute('y1', '34');
    armLine.setAttribute('x2', '35'); armLine.setAttribute('y2', '63');
    armLine.setAttribute('stroke', STICK); armLine.setAttribute('stroke-width', '4'); armLine.setAttribute('stroke-linecap', 'round');
    armGroup.appendChild(armLine);
    const hand = document.createElementNS(svgns, 'circle');
    hand.setAttribute('cx', '35'); hand.setAttribute('cy', '63'); hand.setAttribute('r', '4.2');
    hand.setAttribute('fill', 'var(--accent-deep)');
    armGroup.appendChild(hand);
    svg.appendChild(armGroup);

    wrap.appendChild(svg);
    const angleLabel = document.createElement('div');
    angleLabel.className = 'angle'; angleLabel.textContent = '—';
    wrap.appendChild(angleLabel);
    const idxLabel = document.createElement('div');
    idxLabel.className = 'idx'; idxLabel.textContent = 'pin ' + (i + 2);
    wrap.appendChild(idxLabel);

    rig.appendChild(wrap);
    arms.push(armGroup);
    labels.push(angleLabel);
  }

  function setAngle(i, deg) {
    // 0-180 servo angle -> arm rotation, 90deg = hanging straight down (neutral boot position)
    const rotation = deg - 90;
    arms[i].style.transform = 'rotate(' + rotation + 'deg)';
    labels[i].textContent = deg + '°';
  }

  const dashDot = document.getElementById('dashDot');
  const dashState = document.getElementById('dashState');
  const ffDot = document.getElementById('ffDot');
  const ffState = document.getElementById('ffState');
  const simTimeEl = document.getElementById('simTime');
  const sensorEl = document.getElementById('sensorVal');
  const note = document.getElementById('disconnectedNote');

  function connect() {
    const ws = new WebSocket('ws://' + location.host);
    ws.onopen = () => {
      dashDot.classList.add('live'); dashState.textContent = 'live'; note.style.display = 'none';
    };
    ws.onmessage = (evt) => {
      let data;
      try { data = JSON.parse(evt.data); } catch (e) { return; }
      if (Array.isArray(data.angles)) data.angles.forEach((a, i) => { if (arms[i]) setAngle(i, a); });
      simTimeEl.textContent = data.simTime.toFixed(1) + 's';
      sensorEl.textContent = data.sensor + ' / 1023';
      ffDot.classList.toggle('live', !!data.formfindConnected);
      ffState.textContent = data.formfindConnected ? 'connected' : 'not connected';
    };
    ws.onclose = () => {
      dashDot.classList.remove('live'); dashState.textContent = 'disconnected'; note.style.display = 'block';
      setTimeout(connect, 1500);
    };
    ws.onerror = () => ws.close();
  }
  connect();
})();
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
