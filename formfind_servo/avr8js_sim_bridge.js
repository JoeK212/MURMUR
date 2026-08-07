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
  port (8765) as wokwi_ws_bridge.py, so FORMFIND's existing "Connect via
  Wokwi Bridge" button and ws://localhost:8765 field work with this bridge
  unchanged — it's a drop-in alternative backend, not a new FORMFIND feature.
  Run one bridge script or the other, never both at once (port conflict).

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
  3. In FORMFIND's Physical Rig panel, click "Connect via Wokwi Bridge" —
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

console.log(`FORMFIND avr8js simulator bridge`);
console.log(`  Firmware: ${HEX_PATH}`);
console.log(`  Sensor mode: ${sensorMode}${sensorMode === 'fixed' ? ` (${sensorFixed})` : ''}`);
console.log(`  Listening on ws://localhost:${WS_PORT}`);
console.log(`  In FORMFIND's Physical Rig panel: "Connect via Wokwi Bridge" (URL already defaults to this port).`);
console.log(`  Ctrl+C to stop.`);

setInterval(() => {
  const angleStr = currentAngles.map((a) => String(a).padStart(3, ' ')).join(',');
  process.stdout.write(`\r  servo angles: [${angleStr}]  sim time: ${(cpu.cycles / MHZ).toFixed(1)}s   `);
}, 500);

process.on('SIGINT', () => {
  clearInterval(tickTimer);
  wss.close();
  console.log('\nStopped.');
  process.exit(0);
});
