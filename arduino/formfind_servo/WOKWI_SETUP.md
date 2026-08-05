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

Note: this Wokwi simulation is a standalone reference — it isn't live-linked
to FORMFIND itself (see the embed panel's own note on that). Useful for
sanity-checking the firmware and servo wiring before you build anything, or
as the richer visual sitting next to the abstract 3D preview.
