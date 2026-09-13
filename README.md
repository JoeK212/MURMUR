# MURMUR

A field of 968 kinetic spheres that drift through noise and resolve into text or shapes, like a starling murmuration finding and losing form — inspired by ART+COM's BMW Kinetic Sculpture at the BMW Museum.

Live: [murmurv1.netlify.app](https://murmurv1.netlify.app)

<!-- Demo GIF/video goes here once captured. Suggested: ~15-20s, ambient mode, showing the
     chaos → shape → chaos cycle at least once, then (optional second clip) Audio mode with
     stems loaded and one Soloed. Screen-record at whatever resolution your capture tool
     defaults to, convert to a GIF (or use an MP4/WebM — GitHub renders both inline) under
     ~10MB so it loads fast, and reference it here as:
     ![MURMUR demo](./demo.gif) -->

Three modes, one shared field of spheres:

- **Ambient loop** — auto-cycles indefinitely: chaos → a shape (text or a preset) → chaos, forever. The default, no interaction required.
- **Manual** — type your own word (up to 12 characters) and resolve into it, or pick a preset (circle, car profile, skyline, blob). Scramble sends it back to chaos on demand.
- **Audio** — upload a file or use your microphone, and the field becomes a live equalizer: bass on the left, treble on the right, with a beat detector driving a shimmer pulse across the grid. Drop in up to 4 pre-separated stems (Vocals/Drums/Bass/Other — get them from [Moises](https://moises.ai), free and no install) instead of one mixed file, and each sphere colors toward whichever stem is loudest at that column right now. **Solo** any stem in the legend to isolate it while listening — the others keep playing silently underneath, so nothing drifts out of sync, and the visualization keeps reacting to all four regardless of which one's soloed.

Speed and Turbulence sliders shape the motion in every mode. **Share** (top-right of the 3D view) copies a link that reproduces the current mode, shape, speed, and turbulence. **Record** captures the view as a downloadable video clip.

## Physical rig (optional)

MURMUR can drive a real row of hobby servos over WebSerial (Chrome/Edge, desktop only) — whatever's on screen gets mirrored to the servos live, and the loop can run the other way too: wire a potentiometer or photoresistor and a physical knob or light level can drive Turbulence or Speed instead. No hardware yet? "Show simulated rig" gives a 3D preview — launch canisters firing particles firework-mortar style, driven by that servo's real angle — running MURMUR's actual compiled firmware in-browser via [avr8js](https://github.com/wokwi/avr8js), no install required. See `murmur_servo/AVR8JS_SETUP.md` for the paired Arduino sketch, wiring notes, and the standalone bridge script if you want a separate dashboard window.

## Built with

Three.js, vanilla JS, single HTML file, no build step, no framework. `vendor/` holds the two Three.js files fetched on every page load, self-hosted for load-time reasons (see CHANGELOG v1.39.9); everything else loads on demand only if you use it.

## Acknowledgments

MURMUR is built on these open-source projects:

- [Three.js](https://threejs.org) (MIT) — all 3D rendering, both the kinetic sphere field and the simulated servo rig previews. `three.module.js` and `OrbitControls.js` are vendored locally under `vendor/` (self-hosted to cut connection-setup latency on the critical load path — see CHANGELOG v1.39.9); everything else Three.js-related (bloom postprocessing, the sim rig's own controls) still loads from unpkg on demand.
- [avr8js](https://github.com/wokwi/avr8js) (MIT) by Wokwi — runs the real compiled `murmur_servo.ino` firmware directly, in-browser (via the embedded preview's Web Worker) and in the standalone `avr8js_sim_bridge.js` bridge script, rather than approximating servo behavior.
- [ws](https://github.com/websockets/ws) (MIT) — the WebSocket server behind `avr8js_sim_bridge.js`'s live bridge and dashboard.

---
Joe.K · [axisbim.io](https://axisbim.io)
