#!/usr/bin/env python3
"""
wokwi_ws_bridge.py
--------------------
Relays FORMFIND <-> a running Wokwi simulation over a plain WebSocket,
instead of WebSerial + a virtual COM port. No com0com, no driver signing,
no Secure Boot changes — the earlier approach (wokwi_bridge.py, using
WebSerial and a com0com virtual port pair) hit a wall where Windows refused
to load com0com's unsigned driver at all. This sidesteps that entirely:
FORMFIND talks WebSocket (needs zero OS-level support, works in any
browser), this script is the only thing that talks to Wokwi's RFC2217
server, and RFC2217 was never the problem in the first place.

SETUP
------
1. pip install websockets pyserial
2. Start the Wokwi simulation in VS Code (Wokwi for VS Code extension),
   same as before — wokwi.toml's rfc2217ServerPort = 4000 is what this
   script connects to. Keep the simulator panel visible in VS Code, or the
   simulation pauses and this bridge goes quiet.
3. Run this script:
       python wokwi_ws_bridge.py
   It listens on ws://localhost:8765 by default.
4. In FORMFIND's Physical Rig panel, use the "Connect via Wokwi Bridge"
   option (not "Connect Arduino" — that one's still WebSerial, for real
   hardware or the com0com route if you ever get that working). It should
   already default to ws://localhost:8765; only change it if you ran this
   script with --port to use a different one.

Now: FORMFIND --WebSocket--> this script --RFC2217--> Wokwi's simulated
Arduino, running the real firmware. Watch the servos move in the Wokwi
simulator panel in VS Code while FORMFIND plays audio / switches modes.
Sensor readings (if you wired a potentiometer into the Wokwi circuit) flow
back the same way.

Ctrl+C to stop.
"""
import argparse
import asyncio
import sys

try:
    import serial
except ImportError:
    print("Missing dependency. Run: pip install pyserial")
    sys.exit(1)

try:
    import websockets
except ImportError:
    print("Missing dependency. Run: pip install websockets")
    sys.exit(1)


async def handle_client(ws_conn, rfc2217_url, baud):
    """One browser tab connected -> open one RFC2217 connection to Wokwi for its lifetime."""
    print(f"Browser connected. Opening {rfc2217_url} ...")
    try:
        remote = serial.serial_for_url(rfc2217_url, baudrate=baud, timeout=0.05)
    except Exception as e:
        print(f"Could not reach {rfc2217_url}: {e}")
        print("Is the Wokwi simulation running in VS Code, with wokwi.toml's rfc2217ServerPort set?")
        await ws_conn.close()
        return

    print("Connected to Wokwi. Bridging.")
    stop = asyncio.Event()

    async def ws_to_serial():
        try:
            async for message in ws_conn:
                data = message.encode() if isinstance(message, str) else message
                remote.write(data)
        except websockets.exceptions.ConnectionClosed:
            pass
        finally:
            stop.set()

    async def serial_to_ws():
        loop = asyncio.get_event_loop()
        try:
            while not stop.is_set():
                n = remote.in_waiting
                data = await loop.run_in_executor(None, remote.read, n if n else 1)
                if data:
                    await ws_conn.send(data.decode(errors="replace"))
                else:
                    await asyncio.sleep(0.02)
        except (websockets.exceptions.ConnectionClosed, serial.SerialException):
            pass
        finally:
            stop.set()

    await asyncio.gather(ws_to_serial(), serial_to_ws())
    remote.close()
    print("Browser disconnected. Closed Wokwi connection.")


async def main():
    parser = argparse.ArgumentParser(description="WebSocket <-> Wokwi RFC2217 bridge for FORMFIND")
    parser.add_argument("--port", type=int, default=8765, help="Local WebSocket port (default 8765)")
    parser.add_argument("--rfc2217-port", type=int, default=4000, help="Wokwi's RFC2217 port (default 4000, matches wokwi.toml)")
    parser.add_argument("--baud", type=int, default=115200)
    args = parser.parse_args()

    rfc2217_url = f"rfc2217://localhost:{args.rfc2217_port}"

    async def handler(ws_conn):
        await handle_client(ws_conn, rfc2217_url, args.baud)

    print(f"Listening on ws://localhost:{args.port} — will connect to {rfc2217_url} per browser connection.")
    print("Leave this running. Ctrl+C to stop.")
    async with websockets.serve(handler, "localhost", args.port):
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nStopped.")
