#!/usr/bin/env bash
# build_hex.sh
# -------------
# Compiles formfind_servo.ino into formfind_servo.hex using the real AVR
# toolchain (avr-gcc/avr-libc), targeting the actual chip on an Arduino Uno
# (ATmega328p @ 16MHz). This is the SAME hex you'd get from Arduino IDE's
# "Verify" button, minus the IDE itself — it's what avr8js_sim_bridge.js and
# a real Arduino both run.
#
# ONE-TIME SETUP (Debian/Ubuntu; adjust for your OS)
#   sudo apt-get install gcc-avr avr-libc binutils-avr
#   git clone --depth 1 https://github.com/arduino/ArduinoCore-avr.git
#   git clone --depth 1 https://github.com/arduino-libraries/Servo.git
# Then point ARDUINO_CORE / SERVO_LIB below at wherever you cloned those two
# (or pass them as env vars: ARDUINO_CORE=/path SERVO_LIB=/path ./build_hex.sh)
#
# Only re-run this if you change formfind_servo.ino itself. The prebuilt
# formfind_servo.hex already checked into this folder is fine to use as-is
# for both avr8js_sim_bridge.js and flashing a real Arduino.
set -e

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARDUINO_CORE="${ARDUINO_CORE:-$HERE/../arduino_core/ArduinoCore-avr-master/cores/arduino}"
VARIANT="${VARIANT:-$HERE/../arduino_core/ArduinoCore-avr-master/variants/standard}"
SERVO_LIB="${SERVO_LIB:-$HERE/../arduino_core/Servo-master/src}"

for d in "$ARDUINO_CORE" "$VARIANT" "$SERVO_LIB"; do
  if [ ! -d "$d" ]; then
    echo "Missing: $d"
    echo "Set ARDUINO_CORE / VARIANT / SERVO_LIB env vars, or clone the repos listed above."
    exit 1
  fi
done

command -v avr-gcc >/dev/null || { echo "avr-gcc not found — sudo apt-get install gcc-avr avr-libc"; exit 1; }

BUILD="$HERE/.build_hex_tmp"
rm -rf "$BUILD" && mkdir -p "$BUILD/obj"
cd "$BUILD"

MCU=atmega328p
FCPU=16000000UL
DEFS="-DF_CPU=$FCPU -DARDUINO=10819 -DARDUINO_AVR_UNO -DARDUINO_ARCH_AVR"
CFLAGS="-c -g -Os -w -std=gnu11 -ffunction-sections -fdata-sections -MMD -flto -fno-fat-lto-objects -mmcu=$MCU $DEFS"
CXXFLAGS="-c -g -Os -w -std=gnu++11 -fpermissive -fno-exceptions -ffunction-sections -fdata-sections -fno-threadsafe-statics -MMD -flto -mmcu=$MCU $DEFS"
INCLUDES="-I$ARDUINO_CORE -I$VARIANT -I$SERVO_LIB"

echo "Compiling Arduino core..."
for f in "$ARDUINO_CORE"/*.c; do
  avr-gcc $CFLAGS $INCLUDES "$f" -o "obj/$(basename "$f").o"
done
for f in "$ARDUINO_CORE"/*.cpp; do
  avr-g++ $CXXFLAGS $INCLUDES "$f" -o "obj/$(basename "$f").o"
done

echo "Compiling Servo library..."
avr-g++ $CXXFLAGS $INCLUDES "$SERVO_LIB/avr/Servo.cpp" -o obj/Servo.cpp.o

echo "Compiling sketch..."
{
  echo '#include <Arduino.h>'
  echo 'void handleLine(const String &line);' # Arduino IDE auto-generates this; we do it by hand
  cat "$HERE/formfind_servo.ino"
} > sketch.cpp
avr-g++ $CXXFLAGS $INCLUDES sketch.cpp -o obj/sketch.cpp.o

echo "Linking..."
avr-gcc -w -Os -g -flto -fuse-linker-plugin -Wl,--gc-sections -mmcu=$MCU -o formfind_servo.elf obj/*.o -lm
avr-objcopy -O ihex -R .eeprom formfind_servo.elf "$HERE/formfind_servo.hex"

avr-size formfind_servo.elf
echo "Wrote $HERE/formfind_servo.hex"
cd "$HERE" && rm -rf "$BUILD"
