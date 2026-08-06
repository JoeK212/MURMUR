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
page. But there is a genuinely reliable way to wire it up for real, using a
small bridge script:

1. Install **VS Code** + the **"Wokwi for VS Code"** extension, open this
   `arduino/formfind_servo/` folder in it, and start the simulation from the
   Wokwi sidebar (or F1 → "Wokwi: Start Simulator"). Keep the simulator panel
   visible — if it's hidden, the simulation pauses and everything goes quiet.
   `wokwi.toml` here already has `rfc2217ServerPort = 4000` set for this.
2. Install a virtual COM port pair: **com0com** (Windows) — check "Use Ports
   class" during setup so you get real-looking COM ports, e.g. COM10/COM11 —
   or `socat` (Mac).
3. `pip install pyserial`, then run:
   ```
   python wokwi_bridge.py COM10
   ```
   (whichever port of the pair you're *not* giving to FORMFIND)
4. In FORMFIND's Physical Rig panel, click **Connect Arduino** and pick the
   *other* port (e.g. COM11).

Now servo commands from FORMFIND — driven by whatever's actually on screen,
audio mode included — really flow into Wokwi's running simulation, and any
sensor reading you wire up in the simulated circuit flows back the same way,
exactly like real hardware would behave. `wokwi_bridge.py` in this folder is
the middleman; its own header comment has the same steps plus the Mac
variant.

There's also a plain-browser-only path (no VS Code) — Wokwi's own team
describes a "connect to a real serial port" feature on wokwi.com itself, but
by their own admission it's *"unsupported and undocumented,"* and I couldn't
confirm where its control currently lives in the UI. The VS Code + RFC2217
route above uses only documented, stable Wokwi features, which is why I'd
reach for it first.
