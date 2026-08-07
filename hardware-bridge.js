/*
  hardware-bridge.js
  -------------------
  A reusable WebSerial bridge between a browser tool and an Arduino running
  arduino/formfind_servo/formfind_servo.ino (or any sketch speaking the same
  protocol). First built for FORMFIND (formfind.html); pulled out here so any
  of Joe's generative-design-tools can drive the same physical rig without
  duplicating the connect/disconnect/read-loop/error-handling logic.

  PROTOCOL (matches formfind_servo.ino)
  --------------------------------------
  Browser -> Arduino, one line per send interval:
      A<angle0>,<angle1>,...,<angleN-1>\n      e.g. "A118,45,90,73\n"
  Arduino -> browser, one line per SENSOR_SEND_INTERVAL_MS on the sketch side:
      S<analogRead value, 0-1023>\n            e.g. "S612\n"

  USAGE
  -----
    import { createHardwareBridge } from './hardware-bridge.js';

    const bridge = createHardwareBridge({
      getAngles: () => currentAnglesArray, // your tool's own 0-180 angle array,
                                            // sampled on its own timer — no need
                                            // to hook into your render loop
      onSensorReading: (normalized, raw) => {
        // normalized: 0-1, raw: 0-1023 straight off analogRead(). Optional —
        // omit if this tool doesn't use the loop-closing sensor input.
      },
      onStatusChange: (status, message) => {
        // status: 'connected' | 'disconnected' | 'error'. Wire this to
        // whatever status text / button visibility your tool's UI uses.
      },
      sendIntervalMs: 50, // optional, defaults to 50 (~20Hz)
    });

    connectBtn.onclick = () => bridge.connect();
    disconnectBtn.onclick = () => bridge.disconnect();
    // bridge.connected is a live boolean getter if you need to check state.

  This module owns its own send timer (setInterval, not tied to your render
  loop) — you don't need to call anything per-frame. It's Chrome/Edge desktop
  only; connect() resolves false and fires onStatusChange('error', ...) on
  unsupported browsers rather than throwing.
*/

export function createHardwareBridge({
  getAngles = null,
  onSensorReading = null,
  onStatusChange = null,
  sendIntervalMs = 50,
} = {}){
  const state = {
    port: null,
    writer: null,
    reader: null,
    connected: false,
    sendTimer: null,
  };

  function notify(status, message){
    if(onStatusChange) onStatusChange(status, message);
  }

  async function connect(){
    if(!('serial' in navigator)){
      notify('error', 'WebSerial needs Chrome or Edge on desktop');
      return false;
    }
    try{
      const port = await navigator.serial.requestPort();
      await port.open({ baudRate: 115200 });
      state.port = port;
      state.writer = port.writable.getWriter();
      state.connected = true;
      notify('connected');
      startSendLoop();
      readLoop(); // fire-and-forget — runs until disconnect() or the port errors out
      return true;
    } catch(e){
      notify('error', "Could not connect — check the port isn't open elsewhere (e.g. Serial Monitor)");
      return false;
    }
  }

  async function disconnect(){
    state.connected = false;
    stopSendLoop();
    try{ if(state.reader) await state.reader.cancel(); }catch(e){}
    try{ if(state.writer) await state.writer.close(); }catch(e){}
    try{ if(state.port) await state.port.close(); }catch(e){}
    state.reader = null;
    state.writer = null;
    state.port = null;
    notify('disconnected');
  }

  function startSendLoop(){
    stopSendLoop();
    state.sendTimer = setInterval(async ()=>{
      if(!state.connected || !state.writer || !getAngles) return;
      const angles = getAngles();
      if(!angles || !angles.length) return;
      const line = 'A' + angles.map(a => Math.round(Math.max(0, Math.min(180, a)))).join(',') + '\n';
      try{
        await state.writer.write(new TextEncoder().encode(line));
      } catch(e){
        notify('error', 'Lost connection to Arduino');
        await disconnect();
      }
    }, sendIntervalMs);
  }

  function stopSendLoop(){
    if(state.sendTimer){ clearInterval(state.sendTimer); state.sendTimer = null; }
  }

  async function readLoop(){
    if(!state.port || !state.port.readable) return;
    const textDecoder = new TextDecoderStream();
    const streamClosed = state.port.readable.pipeTo(textDecoder.writable).catch(()=>{});
    const reader = textDecoder.readable.getReader();
    state.reader = reader;
    let buf = '';
    try{
      while(true){
        const { value, done } = await reader.read();
        if(done) break;
        buf += value;
        let idx;
        while((idx = buf.indexOf('\n')) >= 0){
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if(line.charAt(0) === 'S'){
            const raw = parseInt(line.slice(1), 10);
            if(!Number.isNaN(raw) && onSensorReading){
              onSensorReading(Math.max(0, Math.min(1023, raw)) / 1023, raw);
            }
          }
        }
      }
    } catch(e){
      if(state.connected){
        notify('error', 'Lost connection to Arduino');
        await disconnect();
      }
    } finally {
      try{ reader.releaseLock(); }catch(e){}
      await streamClosed;
    }
  }

  return {
    connect,
    disconnect,
    get connected(){ return state.connected; },
  };
}

/*
  createWebSocketBridge
  -----------------------
  Same shape as createHardwareBridge above (connect/disconnect/connected,
  same getAngles/onSensorReading/onStatusChange callbacks) but talks over a
  plain WebSocket instead of WebSerial. Built for connecting to a local
  bridge script that runs or relays to the actual firmware — see
  formfind_servo/avr8js_sim_bridge.js (runs the real firmware locally via
  avr8js) — no virtual COM port driver, no OS-level driver signing to
  fight. Works for any WebSocket-speaking target that understands the same
  line protocol, not tied to any one backend.

  USAGE
  -----
    const bridge = createWebSocketBridge({
      url: 'ws://localhost:8765',
      getAngles: () => currentAnglesArray,
      onSensorReading: (normalized, raw) => { ... },  // optional
      onStatusChange: (status, message) => { ... },   // 'connected'|'disconnected'|'error'
      sendIntervalMs: 50,                              // optional, defaults to 50
    });
    connectBtn.onclick = () => bridge.connect();
    disconnectBtn.onclick = () => bridge.disconnect();
*/
export function createWebSocketBridge({
  url,
  getAngles = null,
  onSensorReading = null,
  onStatusChange = null,
  sendIntervalMs = 50,
} = {}){
  const state = {
    ws: null,
    connected: false,
    sendTimer: null,
  };

  function notify(status, message){
    if(onStatusChange) onStatusChange(status, message);
  }

  function connect(){
    return new Promise((resolve) => {
      if(!url){
        notify('error', 'No WebSocket URL configured');
        resolve(false);
        return;
      }
      let settled = false;
      let ws;
      try{
        ws = new WebSocket(url);
      } catch(e){
        notify('error', `Could not open ${url}`);
        resolve(false);
        return;
      }
      ws.onopen = () => {
        state.ws = ws;
        state.connected = true;
        settled = true;
        notify('connected');
        startSendLoop();
        resolve(true);
      };
      ws.onmessage = (evt) => {
        const line = String(evt.data).trim();
        if(line.charAt(0) === 'S'){
          const raw = parseInt(line.slice(1), 10);
          if(!Number.isNaN(raw) && onSensorReading){
            onSensorReading(Math.max(0, Math.min(1023, raw)) / 1023, raw);
          }
        }
      };
      ws.onerror = () => {
        if(!settled){
          settled = true;
          notify('error', `Could not connect to ${url} — is the bridge script running?`);
          resolve(false);
        }
      };
      ws.onclose = () => {
        stopSendLoop();
        const wasConnected = state.connected;
        state.ws = null;
        state.connected = false;
        if(wasConnected) notify('disconnected');
        if(!settled){ settled = true; resolve(false); }
      };
    });
  }

  function disconnect(){
    stopSendLoop();
    if(state.ws){
      try{ state.ws.close(); }catch(e){}
    }
    state.ws = null;
    state.connected = false;
    notify('disconnected');
  }

  function startSendLoop(){
    stopSendLoop();
    state.sendTimer = setInterval(() => {
      if(!state.connected || !state.ws || state.ws.readyState !== WebSocket.OPEN || !getAngles) return;
      const angles = getAngles();
      if(!angles || !angles.length) return;
      const line = 'A' + angles.map(a => Math.round(Math.max(0, Math.min(180, a)))).join(',') + '\n';
      try{
        state.ws.send(line);
      } catch(e){
        notify('error', 'Lost connection to bridge script');
        disconnect();
      }
    }, sendIntervalMs);
  }

  function stopSendLoop(){
    if(state.sendTimer){ clearInterval(state.sendTimer); state.sendTimer = null; }
  }

  return {
    connect,
    disconnect,
    get connected(){ return state.connected; },
  };
}
