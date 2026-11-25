// ==UserScript==
// @name         Savings City – core
// @namespace    savings-city-tweaks
// @version      1.1
// @description  Shared base for the Savings City scripts: the app's scene and renderer, three.js classes, city data, traffic, sound, one frame loop, dust and the damage bus. Install it first; other scripts build on it.
// @match        https://your-savings-city-host.example/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * One place for what every script used to set up for itself. Other scripts use window.scCore
 * when they need it. A script that has to register something at page start (a render hook, the
 * geometry trap) and may load before the core puts a function on window.scCoreWaiting:
 *   const whenCore = (fn) => (window.scCore ? fn(window.scCore) : (window.scCoreWaiting = window.scCoreWaiting || []).push(fn));
 * the core runs those as soon as it's there. So the order the scripts load in doesn't matter, as
 * long as all run at document-start.
 *
 * - renderer / scene / camera: three.js announces every renderer and scene on
 *   window.__THREE_DEVTOOLS__ (if that exists – it's created here at page start). The renderer's
 *   render() is wrapped once: the scene and camera of the app's own (orthographic) render are kept.
 *   onRender(fn(scene, camera, render) → true when handled): every render call goes past these
 *   first; one that returns true has drawn the frame itself with `render` (walk mode: its own camera).
 * - overlay: the app adds all its layers in one call, scene.add(greenery, …, overlayGroup); the last
 *   one holds the selection and hover highlights.
 * - onGeometryProto(fn(proto)): BufferGeometry's prototype, revealed by a one-time setter on the
 *   "isBufferGeometry" flag three.js sets in its constructor (car tyres and walk mode patch
 *   translate/rotateY there). Registered after it was found: called right away.
 * - app(): the app's own helpers (a Promise), found by the shape of their code – see findHelpers.
 * - classes(): three.js constructors borrowed from objects in the scene (there is no global THREE).
 * - city / onCity(fn): the /api/city data the app reads (every Response.json() is watched).
 * - traffic(): the app's list of traffic cars, revealed by its traffic.cars.forEach(...) call.
 * - sound: out(ctx) gives a gain node that follows the app's sound button (mute + volume);
 *   audio() one shared AudioContext.
 * - onFrame(fn): one requestAnimationFrame loop for everyone; fn(dt, now), dt in seconds (at most
 *   0.1). Errors are caught per callback (and reported once).
 * - puff(x, y, z, opts): a dust puff (grows, drifts, fades) that works without walk mode.
 * - damage(event) / onDamage(fn): the damage bus. Weapons and disasters describe what happens;
 *   whatever can break registers a handler and decides for itself:
 *     { kind: 'blast' | 'impact' | 'push' | 'crush', x, y, z, radius, power, dir: {x,y,z}, n: {x,y,z},
 *       source: 'rocket' | … }
 *   damage() returns the handlers' results ([] when nothing registered). Also sent as the window
 *   event 'sc:damage' (detail = the event).
 */
(function () {
  'use strict';
  if (window.scCore) return;                                       // installed twice: the first one wins

  // ---------- renderer, scene, camera ----------
  let renderer = null, scene = null, camera = null, overlay = null;
  const renderFns = [];
  const hook = window.__THREE_DEVTOOLS__ || (window.__THREE_DEVTOOLS__ = new EventTarget());
  hook.addEventListener('observe', (e) => {
    const o = e.detail;
    if (o && o.isScene && !o.__scCoreAdd) {
      // the app adds its layers in one call; the last one (selection + hover) is the overlay
      o.__scCoreAdd = true;
      const add = o.add;
      o.add = function () { if (arguments.length >= 6 && !overlay) overlay = arguments[arguments.length - 1]; return add.apply(this, arguments); };
    }
    if (!o || !o.isWebGLRenderer || o.__scCore) return;
    const r = o;
    r.__scCore = true;
    renderer = renderer || r;
    const orig = r.render;
    const render = (s, c) => orig.call(r, s, c);
    r.render = function (s, c) {
      if (s && s.isScene && c && c.isOrthographicCamera && (!scene || s === scene)) { scene = s; camera = c; }
      for (const fn of renderFns) {
        let done = false;
        try { done = fn(s, c, render); } catch (e) { console.warn('[core] render', e); }
        if (done) return;
      }
      return orig.apply(this, arguments);
    };
  });

  // ---------- BufferGeometry's prototype (one-time trap) ----------
  let geoProto = null;
  const geoFns = [];
  (function trapGeometry() {
    const KEY = 'isBufferGeometry';
    const prev = Object.getOwnPropertyDescriptor(Object.prototype, KEY);
    if (prev && !prev.set) return;
    Object.defineProperty(Object.prototype, KEY, {
      configurable: true,
      set(v) {
        if (prev) prev.set.call(this, v); else delete Object.prototype[KEY];   // (an older script's trap: chained)
        delete Object.prototype[KEY];
        if (!Object.prototype.hasOwnProperty.call(this, KEY)) Object.defineProperty(this, KEY, { value: v, writable: true, enumerable: true, configurable: true });
        let p = Object.getPrototypeOf(this);
        while (p && !Object.prototype.hasOwnProperty.call(p, 'translate')) p = Object.getPrototypeOf(p);
        if (!p) { console.warn('[core] BufferGeometry.translate not found'); return; }
        geoProto = p;
        for (const fn of geoFns) { try { fn(p); } catch (e) { console.warn('[core] geometry', e); } }
      },
    });
  })();
  function onGeometryProto(fn) { if (typeof fn !== 'function') return; geoFns.push(fn); if (geoProto) try { fn(geoProto); } catch (e) { console.warn('[core] geometry', e); } }

  // ---------- three.js classes, borrowed from the scene ----------
  let K = null;
  function classes() {
    if (K) return K;
    if (!scene) return null;
    let mesh = null, inst = null, lambert = null, basic = null, color = null;
    scene.traverse((o) => {
      if (!mesh && o.isMesh && !o.isInstancedMesh && !o.isSkinnedMesh && o.geometry && o.geometry.attributes.position) mesh = o;
      if (!inst && o.isInstancedMesh) inst = o;
      const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const m of ms) {
        if (!lambert && m.isMeshLambertMaterial) lambert = m;
        if (!basic && m.isMeshBasicMaterial) basic = m;
        if (!color && m.color && m.color.isColor) color = m.color;
      }
    });
    if (!mesh || !lambert || !color) return null;
    const base = (proto, name) => { while (proto && !Object.prototype.hasOwnProperty.call(proto, name)) proto = Object.getPrototypeOf(proto); return proto && proto.constructor; };
    K = {
      Mesh: mesh.constructor, Instanced: inst && inst.constructor, Geometry: base(Object.getPrototypeOf(mesh.geometry), 'translate'),
      Object3D: base(Object.getPrototypeOf(scene), 'add'), Attr: mesh.geometry.attributes.position.constructor,
      Lambert: lambert.constructor, Basic: basic && basic.constructor, Color: color.constructor,
      M4: mesh.matrix.constructor, V3: mesh.position.constructor, Q: mesh.quaternion.constructor, Euler: scene.rotation.constructor,
    };
    return K;
  }

  // ---------- city data ----------
  let city = null, cityVersion = 0;
  const cityFns = [];
  const origJson = Response.prototype.json;
  Response.prototype.json = async function () {
    const d = await origJson.apply(this, arguments);
    try {
      if (d && Array.isArray(d.projects) && Array.isArray(d.roads)) {
        city = d; cityVersion++;
        for (const fn of cityFns) { try { fn(d); } catch (e) { console.warn('[core] city', e); } }
      }
    } catch {}
    return d;
  };

  // ---------- traffic ----------
  let trafficCars = null;
  const origForEach = Array.prototype.forEach;
  Array.prototype.forEach = function () {
    if (this !== trafficCars && this.length) {
      const c = this[0];
      if (c && typeof c === 'object' && typeof c.base === 'number' && typeof c.heading === 'number' && 'from' in c && 'to' in c) trafficCars = this;
    }
    return origForEach.apply(this, arguments);
  };

  // ---------- sound: follows the app's own sound button (mute + volume, kept in localStorage) ----------
  const appSoundLevel = () => {
    try {
      if (localStorage.getItem('citysaver:muted') === '1') return 0;
      const v = parseFloat(localStorage.getItem('citysaver:volume'));
      return Math.min(2.8, ((Number.isFinite(v) ? v : 0.6) / 0.6) ** 2);   // the app's level: volume², 0.6 = normal
    } catch { return 1; }
  };
  const outs = new Map();          // AudioContext → its gain node
  function out(ctx) {
    let g = outs.get(ctx);
    if (!g) {
      g = ctx.createGain(); g.gain.value = appSoundLevel(); g.connect(ctx.destination);
      outs.set(ctx, g);
      if (!out.timer) out.timer = setInterval(() => { for (const [c, n] of outs) n.gain.setTargetAtTime(appSoundLevel(), c.currentTime, 0.05); }, 500);
    }
    return g;
  }
  let audioCtx = null;
  function audio() {
    audioCtx = audioCtx || new AudioContext();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }

  // ---------- one frame loop ----------
  const frameFns = new Set(), warned = new Set();
  let last = 0;
  function frame(t) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, last ? (t - last) / 1000 : 0); last = t;
    for (const fn of frameFns) {
      try { fn(dt, t); } catch (e) { if (!warned.has(fn)) { warned.add(fn); console.warn('[core] frame', e); } }
    }
  }
  requestAnimationFrame(frame);
  function onFrame(fn) { frameFns.add(fn); return () => frameFns.delete(fn); }

  // ---------- dust puffs (work without walk mode) ----------
  const puffs = [];
  let puffGeo = null, puffMat = null;
  function puffGeometry() {
    // a low-poly ball of radius 1
    const P = [], N = [], seg = 8, ring = 5;
    const pt = (i, j) => { const a = (i / seg) * Math.PI * 2, b = (j / ring) * Math.PI - Math.PI / 2; return [Math.cos(b) * Math.cos(a), Math.sin(b), Math.cos(b) * Math.sin(a)]; };
    for (let j = 0; j < ring; j++) for (let i = 0; i < seg; i++) {
      const a = pt(i, j), b = pt(i + 1, j), c = pt(i + 1, j + 1), d = pt(i, j + 1);
      for (const v of [a, c, b, a, d, c]) { P.push(...v); N.push(...v); }
    }
    const g = new K.Geometry();
    g.setAttribute('position', new K.Attr(new Float32Array(P), 3));
    g.setAttribute('normal', new K.Attr(new Float32Array(N), 3));
    return g;
  }
  // opts: vx, vy, vz (tiles/s), size (final radius, roughly), life (s), delay (s), color
  function puff(x, y, z, o = {}) {
    if (!scene || !classes()) return;
    if (!puffGeo) { puffGeo = puffGeometry(); puffMat = new K.Lambert({ color: '#b9aa96', transparent: true, opacity: 0.85, depthWrite: false }); }
    const mat = puffMat.clone();
    if (o.color) mat.color.set(o.color);
    const m = new K.Mesh(puffGeo, mat);
    m.position.set(x, y, z); m.scale.setScalar(0.001); m.visible = false; m.frustumCulled = false; m.userData.scPuff = true;
    scene.add(m);
    puffs.push({ m, vx: o.vx || 0, vy: o.vy || 0, vz: o.vz || 0, size: o.size || 0.15, life: o.life || 3, age: -(o.delay || 0) });
  }
  onFrame((dt) => {
    for (let k = puffs.length - 1; k >= 0; k--) {
      const p = puffs[k]; p.age += dt;
      if (p.age < 0) continue;
      const f = p.age / p.life;
      if (f >= 1) { p.m.removeFromParent(); p.m.material.dispose(); puffs.splice(k, 1); continue; }
      p.m.visible = true;
      const drag = Math.exp(-1.2 * dt); p.vx *= drag; p.vz *= drag; p.vy *= drag;
      p.m.position.x += p.vx * dt; p.m.position.y += p.vy * dt; p.m.position.z += p.vz * dt;
      p.m.scale.set(p.size * (0.4 + f * 1.4), p.size * (0.3 + f * 0.9), p.size * (0.4 + f * 1.4));
      p.m.material.opacity = 0.85 * (1 - f) * Math.min(1, p.age * 4);
    }
  });

  // ---------- the damage bus ----------
  const damageFns = [];
  function damage(ev) {
    const results = [];
    for (const fn of damageFns) { try { const r = fn(ev); if (r) results.push(r); } catch (e) { console.warn('[core] damage', e); } }
    try { window.dispatchEvent(new CustomEvent('sc:damage', { detail: ev })); } catch {}
    return results;
  }
  function onDamage(fn) { if (typeof fn === 'function') damageFns.push(fn); }

  // ---------- the app's own helpers ----------
  // The main module is imported again (the same URL → the already-loaded instance). Its export
  // names are minified and change with every build, so the helpers are recognised by what their
  // code looks like (checked against the builds of 24 and 25 Nov 2026):
  //   v = placed projects → [{id, fp, gx, gy, facing}]   A = rotate a footprint (fp, facing)
  //   a = front-door road keys (gx, gy, fp, facing)      w = floors of a project
  //   S = cells of a footprint                           n = tiles of the welcome sign
  let appHelpers = null;
  async function app() {
    if (appHelpers) return appHelpers;
    const s = [...document.querySelectorAll('script[type="module"][src]')].find((s) => /\/index-[^/]*\.js/.test(s.src));
    if (!s) throw new Error('main module not found');
    const m = findHelpers(await import(s.src));
    if (typeof m.v !== 'function' || typeof m.a !== 'function') throw new Error('app internals changed (new build?)');
    return (appHelpers = m);
  }
  function findHelpers(m) {
    const fns = Object.values(m).filter((f) => typeof f === 'function');
    const code = (f) => { try { return Function.prototype.toString.call(f); } catch { return ''; } };
    const find = (re) => fns.find((f) => re.test(code(f)));
    const isSign = (a) => Array.isArray(a) && a.length >= 4 && a.length <= 64 && a.every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isInteger));
    return {
      v: find(/\.filter\(\w+\)\.map\(\w+=>\(\{id:\w+\.id,fp:/),
      A: find(/^function\s*\w*\(\w+,\w+\)\{let \w+=\w+\.base\?\?\w+/),
      a: find(/^function\s*\w*\(\w+,\w+,\w+,\w+\)\{\w+=\w+\(\w+,\w+\);let \w+=\[\];for\(let\[\w+,\w+\]of /),
      w: find(/^function\s*\w*\(\w+,\w+=\w+\)\{return \w+\(\w+\)\?Math\.min\(/),
      S: find(/\{let (\w+)=\[\];for\(let (\w+)=0;\2<\w+\.w;\2\+\+\)for\(let (\w+)=0;\3<\w+\.d;\3\+\+\)\w+\(\w+,\2,\3\)&&\1\.push/),
      n: Object.values(m).find(isSign),
    };
  }

  // ---------- small shared helpers ----------
  const isFacade = (m) => !!(m && m.map && typeof m.customProgramCacheKey === 'function' && m.customProgramCacheKey() === 'facade');
  // the building (group with userData.projectId) an object belongs to, or null
  function projectOf(o) { for (let p = o; p; p = p.parent) if (p.userData && p.userData.projectId !== undefined) return p; return null; }

  window.scCore = {
    version: '1.1',
    get renderer() { return renderer; },
    get scene() { return scene; },
    get camera() { return camera; },
    get overlay() { return overlay; },
    onRender(fn) { if (typeof fn === 'function') renderFns.push(fn); },
    onGeometryProto, app,
    classes,
    get city() { return city; },
    get cityVersion() { return cityVersion; },
    onCity(fn) { if (typeof fn === 'function') { cityFns.push(fn); if (city) try { fn(city); } catch (e) { console.warn('[core] city', e); } } },
    traffic: () => trafficCars,
    out, audio, onFrame, puff, damage, onDamage, isFacade, projectOf,
  };
  // scripts that loaded before the core and are waiting for it
  const waiting = Array.isArray(window.scCoreWaiting) ? window.scCoreWaiting : [];
  window.scCoreWaiting = { push: (fn) => { try { fn(window.scCore); } catch (e) { console.warn('[core] waiting', e); } } };
  for (const fn of waiting) window.scCoreWaiting.push(fn);
})();
