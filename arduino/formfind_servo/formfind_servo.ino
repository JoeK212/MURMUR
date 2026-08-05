/*
  FORMFIND servo bridge
  ----------------------
  Bidirectional bridge between FORMFIND (formfind.html) running in Chrome/Edge
  and a row of hobby servos, over WebSerial.

  BROWSER -> ARDUINO (servo positions)
    FORMFIND samples the live sphere field (whatever mode is active — ambient,
    manual, or audio) into NUM_SERVOS column bands and sends one line per frame:

        A<angle0>,<angle1>,...,<angleN-1>\n

    e.g. "A118,45,90,73,150,30,88,102\n" for 8 servos.

  ARDUINO -> BROWSER (sensor feedback, closes the loop)
    Every SENSOR_SEND_INTERVAL_MS, this sketch reads SENSOR_PIN and sends:

        S<analogRead value, 0-1023>\n

    e.g. "S612\n". In FORMFIND, set "Sensor drives" (in the Physical rig panel)
    to Turbulence or Speed and that reading will control it live — a knob or a
    light sensor next to the rig becomes a real input into what's on screen,
    not just an output from it.

  SETUP
  -----
  1. Update NUM_SERVOS and SERVO_PINS[] below to match your actual build.
  2. Wire each servo: signal -> its pin from SERVO_PINS[], ground -> common ground
     shared with the Arduino's GND.
  3. POWER: do NOT run more than 1-2 small servos off the Arduino's 5V pin or USB
     power — they draw more current than the onboard regulator or a USB port can
     supply, and you'll get brownouts/resets. Use a separate 5V supply (a UBEC or
     a 5V wall adapter) for the servos, with its ground tied to the Arduino's GND.
  4. (Optional, for sensor feedback) Wire SENSOR_PIN (default A0) to either:
       - A potentiometer: outer legs to 5V and GND, wiper to A0.
       - A photoresistor (light sensor): one leg to 5V, other leg to A0 AND to
         one leg of a 10k resistor, other leg of the resistor to GND (a voltage
         divider — A0 alone can't read a photoresistor's resistance directly).
     No sensor wired is fine too — A0 will just float and send noisy values;
     leave "Sensor drives" set to Off in FORMFIND if you haven't wired one up.
  5. Upload this sketch, then open FORMFIND in Chrome/Edge and click "Connect
     Arduino" in the Physical rig panel. Set the servo count in that panel to
     match NUM_SERVOS below.
  6. (Optional) Open the Arduino IDE's Serial Monitor at 115200 baud before
     connecting from the browser — you should see "FORMFIND-SERVO-READY" printed
     once on boot, confirming the sketch is alive, followed by a stream of
     "S<value>" lines once SENSOR_SEND_INTERVAL_MS has passed. Close the Serial
     Monitor before connecting from the browser — only one program can hold the
     port at a time.
*/
#include <Servo.h>

const int NUM_SERVOS = 8;
const int SERVO_PINS[NUM_SERVOS] = { 2, 3, 4, 5, 6, 7, 8, 9 };

const int SENSOR_PIN = A0;
const unsigned long SENSOR_SEND_INTERVAL_MS = 50; // ~20Hz, matches FORMFIND's own send rate

Servo servos[NUM_SERVOS];
String lineBuf;
unsigned long lastSensorSend = 0;

void setup() {
  Serial.begin(115200);
  for (int i = 0; i < NUM_SERVOS; i++) {
    servos[i].attach(SERVO_PINS[i]);
    servos[i].write(90); // neutral/center on boot
  }
  lineBuf.reserve(128);
  Serial.println("FORMFIND-SERVO-READY");
}

void loop() {
  while (Serial.available() > 0) {
    char c = Serial.read();
    if (c == '\n') {
      handleLine(lineBuf);
      lineBuf = "";
    } else if (c != '\r') {
      lineBuf += c;
      if (lineBuf.length() > 200) lineBuf = ""; // guard against garbage/overflow
    }
  }

  unsigned long now = millis();
  if (now - lastSensorSend >= SENSOR_SEND_INTERVAL_MS) {
    lastSensorSend = now;
    Serial.print('S');
    Serial.println(analogRead(SENSOR_PIN));
  }
}

void handleLine(const String &line) {
  if (line.length() == 0 || line.charAt(0) != 'A') return; // ignore anything that isn't a servo frame
  int idx = 1;
  int servoIdx = 0;
  int len = line.length();
  while (idx < len && servoIdx < NUM_SERVOS) {
    int comma = line.indexOf(',', idx);
    String tok = (comma == -1) ? line.substring(idx) : line.substring(idx, comma);
    int angle = constrain(tok.toInt(), 0, 180);
    servos[servoIdx].write(angle);
    servoIdx++;
    if (comma == -1) break;
    idx = comma + 1;
  }
}
