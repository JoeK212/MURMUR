# FORMFIND servo rig — Wokwi example circuit

An Arduino Uno + 8 servos (pins 2-9), pre-wired to match `formfind_servo.ino`'s
defaults exactly. Paste these two files into a new Wokwi project to get a
working simulated version of the rig in about a minute, no hardware needed —
useful purely as a **visual reference** for how the real wiring looks.

## Setup

1. Go to https://wokwi.com/projects/new/arduino-uno (free account needed to save a project)
2. In the code editor tab (`sketch.ino`), delete the default contents and paste
   in `formfind_servo.ino` from this same folder
3. Click the **diagram.json** tab, delete the default contents, and paste in
   `diagram.json` from this folder
4. Click the green **▶ Start simulation** button — the servos should center to
   90° on boot and print `FORMFIND-SERVO-READY` in the console
5. Click **Share** (or just copy the URL) and paste that link into FORMFIND's
   Physical Rig panel → "Or embed a Wokwi circuit" field, to see it inline

## What it wires up

- `uno:5V` → each servo's `V+`
- `uno:GND.1` → each servo's `GND`
- `uno:2` through `uno:9` → each servo's `PWM`, matching `SERVO_PINS[]` in
  `formfind_servo.ino` 1:1 (servo1→pin2, servo2→pin3, ... servo8→pin9)

If you change `NUM_SERVOS`/`SERVO_PINS[]` in the sketch to match a different
real build later, add/remove `wokwi-servo` parts and connections in
`diagram.json` to match — the pattern for each servo is three connections
(PWM, V+, GND) following the same three lines used for the others.

## This embed is a static reference only

The embed panel in FORMFIND itself is deliberately *static* — paste a link,
see the board as wired, nothing more. It's not live-linked to what's playing
in FORMFIND, and there's no plan to make it so: Wokwi doesn't have a stable,
documented way to receive live data from another page (their own
"connect to a real serial port" browser feature is explicitly marked
*"unsupported and undocumented"* by the Wokwi team).

**For servos actually moving with what's on screen, use `avr8js_sim_bridge.js`
instead** (see `AVR8JS_SETUP.md`) — it runs FORMFIND's real firmware locally
over a plain WebSocket and opens its own live browser dashboard, with no
Wokwi account, no VS Code, and no virtual COM port anywhere in the chain.
An earlier version of this project relayed through a real Wokwi cloud
simulation for the live link instead; that approach hit three separate
infrastructure walls in testing (a virtual-COM-port driver that wouldn't
load, a Secure Boot policy that blocked the workaround, and finally the
Wokwi VS Code extension not opening its own relay port at all) and was
retired once avr8js_sim_bridge.js made all of that unnecessary.
