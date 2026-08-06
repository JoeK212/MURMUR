#!/usr/bin/env python3
"""
wokwi_bridge.py
----------------
Relays bytes between a local (virtual) serial port and Wokwi for VS Code's
RFC2217 serial server, so FORMFIND (or any WebSerial page) can talk to a
REAL, RUNNING simulation of formfind_servo.ino inside Wokwi — genuinely
live-linked, not a static reference view.

Why this exists: FORMFIND connects over WebSerial, which can only see real
or virtual COM ports on your machine. Wokwi's simulation (whether in the
browser or VS Code) isn't a COM port your OS knows about. Wokwi for VS Code
*does* expose the simulated serial port over RFC2217 (a TCP protocol) — this
script is the middleman that makes that TCP endpoint look like a normal COM
port FORMFIND can actually pick.

SETUP (Windows)
----------------
1. Install com0com: https://com0com.sourceforge.net/
   During install, check "Use Ports class" so the virtual pair shows up as
   real COM ports (e.g. COM10, COM11) in Device Manager, not CNCA0/CNCB0.
2. pip install pyserial
3. Install VS Code + the "Wokwi for VS Code" extension, open this project
   folder in it, and start the simulation (Wokwi sidebar, or F1 > "Wokwi:
   Start Simulator"). wokwi.toml in this same folder already has
   rfc2217ServerPort = 4000 set — that's what this script connects to.
   Keep the Wokwi simulator tab/panel visible in VS Code, or the simulation
   pauses and the bridge goes quiet.
4. Run this script, pointing it at ONE port of your com0com pair:
       python wokwi_bridge.py COM10
5. In FORMFIND, click "Connect Arduino" and pick the OTHER port of the pair
   (e.g. COM11) — not the one you gave this script.

Now the chain is:
  FORMFIND --WebSerial--> COM11 --(com0com)--> COM10 --(this script)-->
  RFC2217 --> Wokwi's simulated Arduino, running the real firmware.
Servo commands and sensor readings both flow through it, same protocol as
real hardware. Ctrl+C to stop the bridge.

SETUP (Mac): use `socat PTY,link=/tmp/wokwi-a,raw PTY,link=/tmp/wokwi-b,raw`
instead of com0com to get a virtual port pair, then run this script pointed
at /tmp/wokwi-a and connect FORMFIND to /tmp/wokwi-b (WebSerial on Mac lists
these as available ports once socat has them open).
"""
import sys
import threading
import time

try:
    import serial
except ImportError:
    print("Missing dependency. Run: pip install pyserial")
    sys.exit(1)

RFC2217_URL = "rfc2217://localhost:4000"
BAUD = 115200


def relay(src, dst, label):
    """Copy bytes from src to dst until either side closes or errors out."""
    while True:
        try:
            n = src.in_waiting
            data = src.read(n if n else 1)
            if data:
                dst.write(data)
        except (serial.SerialException, OSError) as e:
            print(f"[{label}] stopped: {e}")
            break


def main():
    if len(sys.argv) < 2:
        print("Usage: python wokwi_bridge.py <local COM port, e.g. COM10>")
        sys.exit(1)
    local_port = sys.argv[1]

    print(f"Connecting to local port {local_port} ...")
    try:
        local = serial.Serial(local_port, BAUD, timeout=0.05)
    except serial.SerialException as e:
        print(f"Could not open {local_port}: {e}")
        print("Check the port name (Device Manager on Windows) and that nothing else has it open.")
        sys.exit(1)

    print(f"Connecting to Wokwi RFC2217 server at {RFC2217_URL} ...")
    try:
        remote = serial.serial_for_url(RFC2217_URL, baudrate=BAUD, timeout=0.05)
    except Exception as e:
        print(f"Could not reach {RFC2217_URL}: {e}")
        print("Is the Wokwi simulation running in VS Code, with wokwi.toml's rfc2217ServerPort set?")
        local.close()
        sys.exit(1)

    print("Bridging — leave this running. Ctrl+C to stop.")
    t1 = threading.Thread(target=relay, args=(local, remote, "FORMFIND->Wokwi"), daemon=True)
    t2 = threading.Thread(target=relay, args=(remote, local, "Wokwi->FORMFIND"), daemon=True)
    t1.start()
    t2.start()

    try:
        while t1.is_alive() and t2.is_alive():
            time.sleep(0.5)
    except KeyboardInterrupt:
        pass
    finally:
        print("Closing.")
        local.close()
        remote.close()


if __name__ == "__main__":
    main()
