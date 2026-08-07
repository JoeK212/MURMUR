# FORMFIND servo rig — avr8js simulator bridge

Runs `formfind_servo.ino`'s real, compiled firmware inside `avr8js`
(github.com/wokwi/avr8js — the open-source, MIT-licensed AVR simulation
core that powers Wokwi itself) and bridges it to FORMFIND over a plain
WebSocket. No Wokwi account, no VS Code, no RFC2217, no virtual COM port,
no driver signing — just Node.js.

This is the only WebSocket bridge backend in the project now — an earlier
version (`wokwi_ws_bridge.py`) relayed to a real Wokwi cloud simulation
instead, but it depended on the Wokwi VS Code extension's RFC2217 support,
which hit three separate infrastructure walls in testing (a virtual-COM-port
driver that wouldn't load, a Secure Boot policy blocking the workaround, and
finally the extension not opening its own relay port at all). It's been
retired; this script replaces it entirely and needs none of that.


## Setup

1. `cd formfind_servo && npm install` (installs `avr8js` and `ws`)
2. `node avr8js_sim_bridge.js` — it prints `Listening on ws://localhost:8765`
   and starts streaming live servo angles and sim time to the terminal
3. Open **http://localhost:8766** in a browser tab — a live dashboard with
   8 rotating servo arms, updating in real time
4. In FORMFIND's Physical Rig panel, click **"Connect via Simulator Bridge"** —
   the URL field already defaults to `ws://localhost:8765`
5. Switch modes / play audio in FORMFIND — both the terminal's servo-angle
   readout and the dashboard's arms move live, decoded from the firmware's
   own real PWM output

Ctrl+C to stop. The simulated firmware keeps running the whole time the
script is up, connected or not — same as a real Arduino would. The
dashboard works even before FORMFIND connects (arms just sit at the
firmware's neutral 90° boot position), and reconnects on its own if you
restart the bridge script while the tab stays open.

## The live dashboard (http://localhost:8766)

A self-served page — no separate install, no build step. It shows:

- 8 servo arms, each rotating to match the real angle measured off that
  servo's real PWM pulse, updated ~20x/second
- Sim time and the current A0 sensor reading (see below)
- Whether FORMFIND is actually connected right now

This is a different thing from FORMFIND's own "Show simulated rig"
checkbox: that one mirrors FORMFIND's *on-screen* state directly, with no
firmware involved. This dashboard only ever shows what the real firmware
actually did with the angles it was sent — if there's a bug in
`formfind_servo.ino`'s handling, this dashboard shows the bug; the
on-screen checkbox never would, because it doesn't run the firmware at
all. Pass `--dashboard-port=9000` to use a different port, or
`--no-dashboard` to skip serving it entirely.

## What's real vs. simulated here

- **The firmware itself: real.** `formfind_servo.hex` (prebuilt in this
  folder) is compiled from the actual `formfind_servo.ino` using the real
  AVR toolchain (avr-gcc/avr-libc) against the real Arduino core and Servo
  library sources — the identical bytes a real Arduino would run. If you
  edit the sketch, rebuild with `build_hex.sh` before restarting the bridge
  (its own header comment has the one-time toolchain setup).
- **The CPU: real (simulated).** `avr8js` executes genuine ATmega328p
  machine code, cycle by cycle — not a reimplementation of what the
  firmware "should" do.
- **Serial: real.** FORMFIND's `A118,45,...\n` lines get injected byte by
  byte at genuine 115200-baud timing into the simulated USART; the
  firmware's own `Serial.read()` / `handleLine()` do the actual parsing.
- **Servo motion: measured, not assumed.** The firmware's real `Servo`
  library bit-bangs each pin via a Timer1 interrupt exactly as it would on
  hardware. The bridge script watches the simulated GPIO pins and measures
  the actual pulse widths, decoding them back into 0–180° the way a real
  servo's control circuitry would. A firmware bug in angle handling shows
  up here exactly as it would on a real rig.
- **The A0 sensor: a stand-in.** There's no real potentiometer to read, so
  the script feeds a synthetic value into the ADC — by default a slow
  0–1023 sweep over ~12 seconds, purely so `analogRead()` and the
  "Sensor drives" loop-closing feature have something to show. Override
  with `node avr8js_sim_bridge.js --sensor=750` for a fixed reading, or
  `--sensor=off` to leave it silent. This is the one part of the setup
  that isn't measuring anything real — everything else in the chain is.

## If you want to see the physical wiring layout too

This script's dashboard shows 8 abstract arms, not a rendered board. For a
visual of the actual wiring (board, servo parts, pin connections), FORMFIND's
Physical Rig panel also has a static Wokwi circuit embed — paste a
wokwi.com project link there. It's not live-linked to anything (deliberately
— see `WOKWI_SETUP.md`), just a wiring reference to look at alongside this
script's live dashboard.
