# MURMUR

A field of 968 kinetic spheres that drift through noise and resolve into text or shapes, like a starling murmuration finding and losing form — inspired by ART+COM's BMW Kinetic Sculpture at the BMW Museum.

Live: (add Netlify URL once deployed)

<!-- Demo GIF/video goes here once captured. Suggested: ~15-20s, ambient mode, showing the
     chaos → shape → chaos cycle at least once, then (optional second clip) the "Show simulated
     rig" fireworks preview firing during Audio mode. Screen-record at whatever resolution your
     capture tool defaults to, convert to a GIF (or use an MP4/WebM — GitHub renders both inline)
     under ~10MB so it loads fast, and reference it here as:
     ![MURMUR demo](./demo.gif) -->

Ambient mode loops indefinitely: chaos → a shape (text, circle, car profile, skyline, blob) → chaos. Manual mode lets you type your own text or pick a preset and scramble back to chaos on demand. Built with Three.js, single HTML file, no build step.

## Acknowledgments

MURMUR is built on these open-source projects:

- [Three.js](https://threejs.org) (MIT) — all 3D rendering, both the kinetic sphere field and the simulated servo rig previews.
- [avr8js](https://github.com/wokwi/avr8js) (MIT) by Wokwi — runs the real compiled `murmur_servo.ino` firmware directly, in-browser (via the embedded preview's Web Worker) and in the standalone `avr8js_sim_bridge.js` bridge script, rather than approximating servo behavior.
- [ws](https://github.com/websockets/ws) (MIT) — the WebSocket server behind `avr8js_sim_bridge.js`'s live bridge and dashboard.

Joe.K · axisbim.io
