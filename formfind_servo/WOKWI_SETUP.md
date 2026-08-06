# FORMFIND servo rig — Wokwi example circuit

An Arduino Uno + 8 servos (pins 2-9), pre-wired to match `formfind_servo.ino`'s
defaults exactly. Paste these two files into a new Wokwi project to get a
working simulated version of the rig in about a minute, no hardware needed.

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

## Making it live (music/servos actually tied together, not just a visual reference)

The embed panel in FORMFIND itself is deliberately a *static* reference —
Wokwi doesn't have a stable, documented way to receive live data from another
page. There are two ways to make it genuinely live, though:

### Recommended: WebSocket bridge (no drivers, works in any browser)

This is the one to use. No virtual COM ports, no driver signing, no risk of
hitting a Secure Boot wall like the WebSerial route below can.

1. Install **VS Code** + the **"Wokwi for VS Code"** extension, open this
   `arduino/formfind_servo/` folder in it, and start the simulation from the
   Wokwi sidebar (or F1 → "Wokwi: Start Simulator"). Keep the simulator panel
   visible — if it's hidden, the simulation pauses and everything goes quiet.
   `wokwi.toml` here already has `rfc2217ServerPort = 4000` set for this.
2. `pip install websockets pyserial`, then run:
   ```
   python wokwi_ws_bridge.py
   ```
   It listens on `ws://localhost:8765` by default.
3. In FORMFIND's Physical Rig panel, use **"Connect via Wokwi Bridge"** (the
   second connection option, below "Connect Arduino") — the URL field already
   defaults to `ws://localhost:8765`, so just click it.

Now servo commands from FORMFIND — driven by whatever's actually on screen,
audio mode included — flow into Wokwi's running simulation over a plain
WebSocket, and any sensor reading you wire into the simulated circuit flows
back the same way. Watch the servos move in the Wokwi simulator panel in VS
Code while FORMFIND plays. `wokwi_ws_bridge.py`'s own header comment has the
same steps.

### Alternative: WebSerial + virtual COM port (more setup, can hit OS walls)

`wokwi_bridge.py` (the other script in this folder) does the same thing over
WebSerial instead, using FORMFIND's "Connect Arduino" button — which means it
needs a virtual COM port pair (com0com on Windows, socat on Mac) sitting in
between. This is the original approach and it does work, but com0com's
driver isn't always signed in a way modern Windows will load without
enabling Test Signing Mode — and on some systems, Secure Boot blocks that
entirely, which would mean disabling Secure Boot in BIOS to proceed (not
something to do casually — it can trigger a BitLocker recovery prompt on
some machines). If you hit that wall, use the WebSocket bridge above
instead — it doesn't touch any of this.

There's also a plain-browser-only path (no VS Code) — Wokwi's own team
describes a "connect to a real serial port" feature on wokwi.com itself, but
by their own admission it's *"unsupported and undocumented,"* and I couldn't
confirm where its control currently lives in the UI. The VS Code + RFC2217
route above uses only documented, stable Wokwi features, which is why I'd
reach for it first.
