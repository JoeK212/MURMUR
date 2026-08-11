# MURMUR servo rig — avr8js simulator

Runs `murmur_servo.ino`'s real, compiled firmware inside `avr8js`
(github.com/wokwi/avr8js — the open-source, MIT-licensed AVR simulation
core that powers Wokwi itself). No Wokwi account, no VS Code, no RFC2217,
no virtual COM port, no driver signing.

**As of MURMUR's embedded simulator, you don't need anything in this
folder for the everyday "watch the sim" experience.** Just open
`index.html` and check "Show simulated rig" — the exact same avr8js +
compiled hex setup described below now runs directly inside that page
(loaded from a CDN at runtime), no terminal, no `npm install`, no Node.js.
If it can't load (offline, CDN blocked), it falls back automatically to a
direct angle preview rather than breaking.

This folder's `avr8js_sim_bridge.js` still exists and still works — reach
for it when you specifically want:
- A **separate window/monitor** for the sim, independent of the MURMUR tab
- A **`ws://` endpoint** other tools can connect to (not just MURMUR)
- The **terminal readout** of live servo angles and sim time

Run one or the other for the visual — not both at once if pointing them at
the same MURMUR instance is confusing, though nothing will actually
break; they're independent simulations of the same firmware.

## Setup (external script, optional)

1. `cd murmur_servo && npm install` (installs `avr8js` and `ws`)
2. `node avr8js_sim_bridge.js` — it prints `Listening on ws://localhost:8765`
   and starts streaming live servo angles and sim time to the terminal
3. Open **http://localhost:8766** in a browser tab — a live dashboard with
   popsicle-stick figures, one per servo, each waving an arm in real time
4. In MURMUR's Physical Rig panel, click **"Connect via Simulator Bridge"** —
   the URL field already defaults to `ws://localhost:8765`
5. Switch modes / play audio in MURMUR — both the terminal's servo-angle
   readout and the dashboard's arms move live, decoded from the firmware's
   own real PWM output

Ctrl+C to stop. The simulated firmware keeps running the whole time the
script is up, connected or not — same as a real Arduino would. The
dashboard works even before MURMUR connects (arms just sit at the
firmware's neutral 90° boot position), and reconnects on its own if you
restart the bridge script while the tab stays open.

## The live dashboard (http://localhost:8766)

A self-served page — no separate install, no build step. It shows:

- 8 popsicle-stick figures, each figure's one arm rotating to match the real
  angle measured off that servo's real PWM pulse, updated ~20x/second
- Sim time and the current A0 sensor reading (see below)
- Whether MURMUR is actually connected right now

## What's real vs. simulated here

Applies equally to the embedded version and this external script — same
hex, same CPU/peripheral setup, same PWM decode:

- **The firmware itself: real.** `murmur_servo.hex` (prebuilt in this
  folder, and inlined directly into `index.html` for the embedded version)
  is compiled from the actual `murmur_servo.ino` using the real AVR
  toolchain (avr-gcc/avr-libc) against the real Arduino core and Servo
  library sources — the identical bytes a real Arduino would run. If you
  edit the sketch, rebuild with `build_hex.sh`, then re-embed the new hex
  into `index.html`'s `EMBEDDED_FIRMWARE_HEX` constant if you're using the
  embedded path.
- **The CPU: real (simulated).** `avr8js` executes genuine ATmega328p
  machine code, cycle by cycle — not a reimplementation of what the
  firmware "should" do.
- **Serial: real.** Commanded angles get injected byte by byte at genuine
  115200-baud timing into the simulated USART; the firmware's own
  `Serial.read()` / `handleLine()` do the actual parsing.
- **Servo motion: measured, not assumed.** The firmware's real `Servo`
  library bit-bangs each pin via a Timer1 interrupt exactly as it would on
  hardware. Both the embedded version and this script watch the simulated
  GPIO pins and measure the actual pulse widths, decoding them back into
  0–180° the way a real servo's control circuitry would. A firmware bug in
  angle handling shows up here exactly as it would on a real rig — neither
  path mirrors MURMUR's on-screen state directly, both run the real code.
- **The A0 sensor: a stand-in.** There's no real potentiometer to read, so
  a synthetic value gets fed into the ADC — a slow 0–1023 sweep over ~12
  seconds, purely so `analogRead()` and the "Sensor drives" loop-closing
  feature have something to show. This script's sweep can be overridden
  (`--sensor=750` for a fixed reading, `--sensor=off` for silent); the
  embedded version always uses the default sweep. This is the one part of
  the setup that isn't measuring anything real — everything else is.

The `murmur_servo/` folder's fixed 8-servo firmware (`NUM_SERVOS`/
`SERVO_PINS` in the `.ino`) is what both the embedded preview and this
dashboard always mirror — independent of MURMUR's "servo count" field,
which only controls how many angles go out to real/external hardware.

## If you want to see the physical wiring layout too

Neither simulator renders a board — just abstract stick figures/arms.
MURMUR doesn't have an in-app view of the physical wiring either — if
you want that, build the wiring yourself in a Wokwi project (paste
`murmur_servo.ino` into a new Arduino Uno project at wokwi.com and wire
up 8 servos on pins 2-9) and keep that tab open alongside whichever
simulator you're using.
