# FORMFIND servo rig — avr8js simulator bridge

Runs `formfind_servo.ino`'s real, compiled firmware inside `avr8js`
(github.com/wokwi/avr8js — the open-source, MIT-licensed AVR simulation
core that powers Wokwi itself) and bridges it to FORMFIND over the exact
same WebSocket protocol `wokwi_ws_bridge.py` uses. No Wokwi account, no
VS Code, no RFC2217, no virtual COM port, no driver signing — just
Node.js.

Use this instead of `wokwi_ws_bridge.py` when you want a live, moving
simulation without any of Wokwi's own infrastructure in the loop. Both
scripts speak the same protocol on the same default port (`8765`), so
FORMFIND's "Connect via Wokwi Bridge" button and its `ws://localhost:8765`
default work with either one unchanged — run whichever script, not both
at once (they'd fight over the port).

## Setup

1. `cd formfind_servo && npm install` (installs `avr8js` and `ws`)
2. `node avr8js_sim_bridge.js` — it prints `Listening on ws://localhost:8765`
   and starts streaming live servo angles and sim time to the terminal
3. In FORMFIND's Physical Rig panel, click **"Connect via Wokwi Bridge"** —
   the URL field already defaults to `ws://localhost:8765`
4. Switch modes / play audio in FORMFIND — the terminal's servo-angle
   readout moves live, decoded from the firmware's own real PWM output

Ctrl+C to stop. The simulated firmware keeps running the whole time the
script is up, connected or not — same as a real Arduino would.

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

## When to use this vs. `wokwi_ws_bridge.py`

Reach for this one first — it has no external dependency to fail. Use the
Wokwi relay instead only if you specifically want the visual Wokwi
simulator panel itself (seeing the board and servos rendered in a browser
tab), which this script doesn't provide — it's terminal-only, no visual
board.
