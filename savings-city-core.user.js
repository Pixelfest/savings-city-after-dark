// ==UserScript==
// @name         Savings City – core
// @namespace    savings-city-tweaks
// @version      1.7
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
 *   onDraw(fn(scene, camera, draw) → true when handled): the last step of every render call, also
 *   the ones the onRender hooks make (graphics: ambient occlusion draws the frame there; `draw` is
 *   three.js' own render). onRenderer(fn(renderer)): called as soon as the renderer exists, before
 *   the app sets it up (graphics wraps setPixelRatio there).
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
 * - smoke(kind, x, y, z, opts): smoke and dust ('dust', 'blacksmoke', 'smoke') as solid low-poly
 *   puffs, one InstancedMesh per kind (see "smoke and dust" below); walk mode's smoke goes here too.
 *   puff(x, y, z, opts): the older dust puff (vx, vy, vz, size, life, delay, color), now one of those.
 * - settings: sliders other scripts add (define({ id, label, min, max, step, value, format?, help? }),
 *   get(id), set(id, v), onChange(id, fn)); kept in localStorage. type: 'toggle' (value true/false)
 *   is an on/off switch, options: ['a', 'b', …] a row of buttons (value = index); reload: true
 *   means it only applies after reloading the page (the popup offers that). A button in the menu opens a
 *   popup with all of them. The core's own: 'detail' (1 = normal … 5 = most detailed), read through
 *   detail() → { level, factor: 2^(level − 1) } – scripts multiply their piece budgets by it.
 *   'blood' (1 … 5), read through blood() → 1, 2, 4, 8 or 16: how much blood spatters.
 * - damage(event) / onDamage(fn): the damage bus. Weapons and disasters describe what happens;
 *   whatever can break registers a handler and decides for itself:
 *     { kind: 'blast' | 'impact' | 'push' | 'crush', x, y, z, radius, power, dir: {x,y,z}, n: {x,y,z},
 *       source: 'rocket' | … }
 *   damage() returns the handlers' results ([] when nothing registered). Also sent as the window
 *   event 'sc:damage' (detail = the event).
 * - lights out: lightsOut(ids) switches off a destroyed building's night glow, Christmas bulbs and
 *   wall glows; lampsOut(x, z, r, { fell }) the street lamps within r (blasts do this by
 *   themselves); darkFacade(material) is the facade without lit windows (for rubble); view() is
 *   the app's city view (found through React). See "lights out" below.
 */
(function () {
  'use strict';
  if (window.scCore) return;                                       // installed twice: the first one wins

  // ---------- renderer, scene, camera ----------
  let renderer = null, scene = null, camera = null, overlay = null;
  const renderFns = [], drawFns = [], rendererFns = [];
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
    const raw = (s, c) => orig.call(r, s, c);
    const render = (s, c) => {
      for (const fn of drawFns) {
        let done = false;
        try { done = fn(s, c, raw); } catch (e) { console.warn('[core] draw', e); }
        if (done) return;
      }
      return orig.call(r, s, c);
    };
    if (renderer === r) for (const fn of rendererFns) { try { fn(r); } catch (e) { console.warn('[core] renderer', e); } }
    r.render = function (s, c) {
      if (s && s.isScene && c && c.isOrthographicCamera && (!scene || s === scene)) { scene = s; camera = c; }
      for (const fn of renderFns) {
        let done = false;
        try { done = fn(s, c, render); } catch (e) { console.warn('[core] render', e); }
        if (done) return;
      }
      return render(s, c);
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

  // ---------- smoke and dust: solid puffs, one InstancedMesh per kind ----------
  // Every puff is one instance of a low-poly ball (icosahedron): position, size, rotation and
  // colour per instance, so all smoke of a kind is one draw call. Solid (no transparency: no
  // sorting, no overdraw): instead of fading, a puff shrinks away at the end of its life and as
  // it climbs towards SMOKE_TOP – nothing is left above that height. Fixed capacity per kind,
  // kept in flat typed arrays (no objects per puff, no garbage); when a kind is full the oldest
  // puff is reused.
  const SMOKE_TOP = 1.5;           // tiles (≈ 30 m): puffs are gone by this height…
  const SMOKE_BAND = 0.7;          // …and start shrinking this far below it
  const SMOKE_WIND = [0.09, 0.035];// tiles per second, a bit stronger higher up
  const SMOKE_TINT = 0.55;         // how far a puff's colour goes towards its kind's "thin" colour as it ages
  const APP_EXHAUST = true;        // the app's own exhaust puffs (a barrel roll) drawn as solid puffs too
  const SMOKE_KINDS = {
    // colours: one is picked per puff (unless the caller gives one); fade: what thin smoke looks like
    // scale: solid puffs look heavier than see-through ones of the same size
    dust: { cap: 1600, scale: 0.8, colors: ['#bfb39f', '#cdc2b0', '#b3a895', '#d6ccba', '#a99f90'], fade: '#e6e0d6' },
    blacksmoke: { cap: 1600, scale: 0.85, colors: ['#1d1d20', '#26262a', '#303034', '#3a3a3e'], fade: '#77777c' },
    smoke: { cap: 500, scale: 1, colors: ['#3b3b3e', '#55565a', '#6e6f74'], fade: '#a4a5aa' },
    exhaust: { cap: 600, scale: 1, colors: ['#eef1f6'], fade: '#ffffff' },
  };
  // per puff, at offset i × ST: position, velocity, age, life, size, grow, rise, drag, flat, thin, wind, colour (3)
  const ST = 18, X = 0, Y = 1, Z = 2, VX = 3, VY = 4, VZ = 5, AGE = 6, LIFE = 7, SIZE = 8, GROW = 9, RISE = 10, DRAG = 11, FLAT = 12, THIN = 13, WINDF = 14, CR = 15;
  const smokeKinds = new Map();    // kind → { mesh, d (Float32Array cap × ST), R (cap × 9), cap, next, used, live, fade }
  let smokeGeo = null, smokeMat = null;
  const linear = new Map();        // '#rrggbb' → [r, g, b] (linear, like three.js colours)
  function lin(hex) {
    let c = linear.get(hex);
    if (!c) { const k = new K.Color(hex); c = [k.r, k.g, k.b]; linear.set(hex, c); }
    return c;
  }
  function icosahedron() {
    // radius 0.5 (a puff of `size` is that wide), flat shaded
    const t = (1 + Math.sqrt(5)) / 2, V = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]]
      .map((v) => { const l = Math.hypot(...v) * 2; return v.map((c) => c / l); });
    const F = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
    const P = [], N = [];
    for (const [a, b, c] of F) {
      const A = V[a], B = V[b], C = V[c], n = [A[0] + B[0] + C[0], A[1] + B[1] + C[1], A[2] + B[2] + C[2]], l = Math.hypot(...n);
      for (const v of [A, B, C]) { P.push(...v); N.push(n[0] / l, n[1] / l, n[2] / l); }
    }
    const g = new K.Geometry();
    g.setAttribute('position', new K.Attr(new Float32Array(P), 3));
    g.setAttribute('normal', new K.Attr(new Float32Array(N), 3));
    return g;
  }
  function smokeKind(kind) {
    let sk = smokeKinds.get(kind);
    if (sk) return sk;
    const def = SMOKE_KINDS[kind];
    if (!def || !scene || !classes() || !K.Instanced) return null;
    if (!smokeGeo) { smokeGeo = icosahedron(); smokeMat = new K.Lambert({ color: '#ffffff' }); }
    const mesh = new K.Instanced(smokeGeo, smokeMat, def.cap);
    mesh.count = 0; mesh.frustumCulled = false; mesh.castShadow = mesh.receiveShadow = false;
    mesh.userData.scSmoke = kind; mesh.userData.scPuff = true; mesh.name = 'sc-smoke-' + kind;
    mesh.setColorAt(0, new K.Color('#ffffff'));
    if (mesh.instanceMatrix.setUsage) { mesh.instanceMatrix.setUsage(35048); mesh.instanceColor.setUsage(35048); }   // dynamic
    scene.add(mesh);
    sk = { kind, mesh, d: new Float32Array(def.cap * ST), R: new Float32Array(def.cap * 9), cap: def.cap, next: 0, used: 0, live: 0, fade: lin(def.fade), colors: def.colors, scale: def.scale };
    // a random orientation per slot, once (puffs don't spin)
    for (let i = 0; i < def.cap; i++) randomRotation(sk.R, i * 9);
    smokeKinds.set(kind, sk);
    return sk;
  }
  function randomRotation(R, o) {
    // a random unit quaternion → 3×3 matrix (row-major)
    let x = Math.random() * 2 - 1, y = Math.random() * 2 - 1, z = Math.random() * 2 - 1, w = Math.random() * 2 - 1;
    const l = Math.hypot(x, y, z, w) || 1; x /= l; y /= l; z /= l; w /= l;
    R[o] = 1 - 2 * (y * y + z * z); R[o + 1] = 2 * (x * y - z * w); R[o + 2] = 2 * (x * z + y * w);
    R[o + 3] = 2 * (x * y + z * w); R[o + 4] = 1 - 2 * (x * x + z * z); R[o + 5] = 2 * (y * z - x * w);
    R[o + 6] = 2 * (x * z - y * w); R[o + 7] = 2 * (y * z + x * w); R[o + 8] = 1 - 2 * (x * x + y * y);
  }
  // A puff of `kind` ('dust', 'blacksmoke', 'smoke'). opts (tiles, seconds): vx, vy, vz; size (how
  // wide it starts), grow (it ends up this many times as big), life, delay; rise (the speed it
  // rises at once it has settled), drag (how fast it settles: velocity → rise + wind), flat (>1:
  // squashed, rolling over the ground), alpha (0…1: thinner smoke is smaller and lighter),
  // wind (0…1), color ('#rrggbb', else one of the kind's colours).
  function smoke(kind, x, y, z, o = {}) {
    const sk = smokeKind(SMOKE_KINDS[kind] ? kind : 'smoke'); if (!sk) return false;
    const i = sk.next; sk.next = (i + 1) % sk.cap; if (sk.used < sk.cap) sk.used = Math.max(sk.used, i + 1);
    const d = sk.d, b = i * ST;
    if (!(d[b + AGE] < d[b + LIFE])) sk.live++;                    // (a slot still in use is simply reused: the oldest)
    d[b + X] = x; d[b + Y] = y; d[b + Z] = z;
    d[b + VX] = o.vx || 0; d[b + VY] = o.vy || 0; d[b + VZ] = o.vz || 0;
    d[b + AGE] = -(o.delay || 0); d[b + LIFE] = o.life || 3;
    d[b + SIZE] = (o.size || 0.1) * sk.scale; d[b + GROW] = o.grow || 3; d[b + RISE] = o.rise ?? 0.1; d[b + DRAG] = o.drag ?? 1;
    d[b + FLAT] = o.flat || 1; d[b + WINDF] = o.wind ?? 1;
    const a = Math.max(0.05, Math.min(1, (o.alpha ?? 0.8) / 0.85));
    d[b + THIN] = 0.55 + 0.45 * a;                                  // thin smoke: smaller…
    const c = lin(o.color || sk.colors[(Math.random() * sk.colors.length) | 0]), f = sk.fade, t = (1 - a) * 0.5;
    d[b + CR] = c[0] + (f[0] - c[0]) * t; d[b + CR + 1] = c[1] + (f[1] - c[1]) * t; d[b + CR + 2] = c[2] + (f[2] - c[2]) * t;   // …and lighter
    return true;
  }
  function stepSmoke(sk, dt) {
    const d = sk.d, R = sk.R, m = sk.mesh.instanceMatrix.array, col = sk.mesh.instanceColor.array, fd = sk.fade;
    let live = 0, hi = 0;
    for (let i = 0; i < sk.used; i++) {
      const b = i * ST, life = d[b + LIFE];
      let age = d[b + AGE];
      const e = i * 16;
      if (!(age < life)) { if (m[e + 15] !== 0) zero(m, e); continue; }   // a free slot: drawn as nothing
      live++; hi = i + 1;
      age += dt; d[b + AGE] = age;
      if (age < 0) { zero(m, e); continue; }                         // not yet (delay)
      // velocity settles towards rising + the wind (cheap: 1 / (1 + drag·dt) instead of exp)
      let y = d[b + Y];
      const k = 1 / (1 + d[b + DRAG] * dt), q = 1 - k, wind = (0.4 + (y > 0 ? y : 0) * 0.35) * d[b + WINDF];
      const vx = d[b + VX] * k + SMOKE_WIND[0] * wind * q, vz = d[b + VZ] * k + SMOKE_WIND[1] * wind * q;
      let vy = d[b + VY] * k + d[b + RISE] * q;
      const x = d[b + X] + vx * dt, z = d[b + Z] + vz * dt;
      y += vy * dt;
      // size: grows fast, then slowly; pops up at the start, shrinks away at the end and near the top
      const f = age / life, g = 1 - (1 - f) * (1 - f);
      let s = d[b + SIZE] * (1 + (d[b + GROW] - 1) * g) * d[b + THIN];
      s *= (f < 0.06 ? f / 0.06 : 1) * (f > 0.5 ? (1 - f) * 2 : 1);
      const top = (SMOKE_TOP - y) / SMOKE_BAND;
      if (top <= 0) { d[b + AGE] = life; live--; zero(m, e); continue; }   // gone at the top
      if (top < 1) s *= top;
      const flat = d[b + FLAT], sy = s / flat, floor = 0.04 + sy * 0.3;
      if (y < floor) { y = floor; if (vy < 0) vy = 0; }               // rolls over the ground, not through it
      d[b + X] = x; d[b + Y] = y; d[b + Z] = z; d[b + VX] = vx; d[b + VY] = vy; d[b + VZ] = vz;
      // matrix = translate · scale(s, s/flat, s) · rotation (column-major)
      const r = i * 9;
      m[e] = R[r] * s; m[e + 1] = R[r + 3] * sy; m[e + 2] = R[r + 6] * s;
      m[e + 4] = R[r + 1] * s; m[e + 5] = R[r + 4] * sy; m[e + 6] = R[r + 7] * s;
      m[e + 8] = R[r + 2] * s; m[e + 9] = R[r + 5] * sy; m[e + 10] = R[r + 8] * s;
      m[e + 12] = x; m[e + 13] = y; m[e + 14] = z; m[e + 15] = 1;
      // colour: towards the thin colour as it ages
      const t = f * SMOKE_TINT, c = b + CR, o3 = i * 3;
      col[o3] = d[c] + (fd[0] - d[c]) * t; col[o3 + 1] = d[c + 1] + (fd[1] - d[c + 1]) * t; col[o3 + 2] = d[c + 2] + (fd[2] - d[c + 2]) * t;
    }
    sk.live = live;
    if (!live) { sk.used = 0; sk.next = 0; }                       // all gone: start at the front again (nothing drawn)
    sk.mesh.count = live ? hi : 0;
    upload(sk.mesh.instanceMatrix, hi * 16); upload(sk.mesh.instanceColor, hi * 3);
  }
  function zero(m, e) { for (let k = 0; k < 16; k++) m[e + k] = 0; }
  function upload(a, n) { if (!n) return; if (a.addUpdateRange) a.addUpdateRange(0, n); a.needsUpdate = true; }
  // The app's own exhaust puffs (white smoke from a car's exhaust and wheels in a barrel roll):
  // its points (soft, see-through, sized for the top-down camera) are hidden and every live one is
  // drawn as a solid puff of the same place and size instead.
  let appExhaust = null, exhaustLookedAt = 0;
  function findExhaust() {
    if (appExhaust && appExhaust.parent) return appExhaust;
    const now = performance.now();
    if (now - exhaustLookedAt < 3000) return null;
    exhaustLookedAt = now; appExhaust = null;
    scene.traverse((o) => { const a = o.isPoints && o.geometry && o.geometry.attributes; if (!appExhaust && a && a.aSize && a.aAlpha && !a.aColor) appExhaust = o; });
    return appExhaust;
  }
  function stepExhaust() {
    const pts = findExhaust(); if (!pts) return;
    pts.visible = false;
    const sk = smokeKind('exhaust'); if (!sk) return;
    const a = pts.geometry.attributes, P = a.position.array, S = a.aSize.array, A = a.aAlpha.array, m = sk.mesh.instanceMatrix.array, R = sk.R;
    let n = 0;
    for (let i = 0; i < A.length && n < sk.cap; i++) {
      const al = A[i]; if (al < 0.02 || P[i * 3 + 1] > SMOKE_TOP) continue;
      // fading out (alpha) → shrinking away
      const s = S[i] * 0.75 * Math.sqrt(al / 0.9), e = n * 16, r = (i % sk.cap) * 9;
      m[e] = R[r] * s; m[e + 1] = R[r + 3] * s; m[e + 2] = R[r + 6] * s; m[e + 3] = 0;
      m[e + 4] = R[r + 1] * s; m[e + 5] = R[r + 4] * s; m[e + 6] = R[r + 7] * s; m[e + 7] = 0;
      m[e + 8] = R[r + 2] * s; m[e + 9] = R[r + 5] * s; m[e + 10] = R[r + 8] * s; m[e + 11] = 0;
      m[e + 12] = P[i * 3]; m[e + 13] = P[i * 3 + 1]; m[e + 14] = P[i * 3 + 2]; m[e + 15] = 1;
      n++;
    }
    if (n && !sk.colored) { const c = lin(SMOKE_KINDS.exhaust.colors[0]), col = sk.mesh.instanceColor.array; for (let k = 0; k < sk.cap; k++) col.set(c, k * 3); upload(sk.mesh.instanceColor, sk.cap * 3); sk.colored = true; }
    sk.mesh.count = n;
    upload(sk.mesh.instanceMatrix, n * 16);
  }
  onFrame((dt) => {
    for (const sk of smokeKinds.values()) {
      if (sk.kind === 'exhaust') continue;
      if (sk.mesh.parent !== scene && scene) scene.add(sk.mesh);
      if (sk.used) stepSmoke(sk, dt);
    }
    if (APP_EXHAUST && scene) stepExhaust();
  });
  // the old dust puff (grows, drifts, fades), now a solid one: opts vx, vy, vz, size (about its
  // final radius), life, delay, color
  function puff(x, y, z, o = {}) {
    return smoke('dust', x, y, z, { vx: o.vx, vy: o.vy, vz: o.vz, size: (o.size || 0.15) * 0.9, grow: 4, flat: 1.3, drag: 1.2, rise: 0.02, life: o.life || 3, delay: o.delay, color: o.color });
  }
  // what's in use, per kind (for tests): { kind: { live, capacity } }
  function smokeStats() { const r = {}; for (const [k, sk] of smokeKinds) r[k] = { live: sk.kind === 'exhaust' ? sk.mesh.count : sk.live, capacity: sk.cap }; return r; }

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
    // the sign's tiles: a list of integer [x, y] pairs – but not the table of the 4 directions
    // ([[0,-1],[1,0],[0,1],[-1,0]]), which the 27 Nov build also exports
    const isSign = (a) => Array.isArray(a) && a.length >= 4 && a.length <= 64 && a.every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isInteger))
      && !a.every(([x, y]) => Math.abs(x) + Math.abs(y) === 1);
    return {
      v: find(/\.filter\(\w+\)\.map\(\w+=>\(\{id:\w+\.id,fp:/),
      A: find(/^function\s*\w*\(\w+,\w+\)\{let \w+=\w+\.base\?\?\w+/),
      a: find(/^function\s*\w*\(\w+,\w+,\w+,\w+\)\{\w+=\w+\(\w+,\w+\);let \w+=\[\];for\(let\[\w+,\w+\]of /),
      w: find(/^function\s*\w*\(\w+,\w+=\w+\)\{return \w+\(\w+\)\?Math\.min\(/),
      S: find(/\{let (\w+)=\[\];for\(let (\w+)=0;\2<\w+\.w;\2\+\+\)for\(let (\w+)=0;\3<\w+\.d;\3\+\+\)\w+\(\w+,\2,\3\)&&\1\.push/),
      n: Object.values(m).find(isSign),
    };
  }

  // ---------- settings (sliders in a popup) ----------
  const SETTINGS_KEY = 'sc-settings';
  const defs = [], values = (() => { try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; } })();
  const changeFns = new Map();
  let popupEl = null;                                            // the open popup, if any
  let needReload = false;                                        // a setting changed that applies after a reload
  const settings = {
    // { id, label, min, max, step, value (default), format(v) → text, help }
    define(d) {
      if (!d || !d.id || defs.some((x) => x.id === d.id)) return;
      defs.push(d);
      if (popupEl) renderPopup();
    },
    get(id) {
      const d = defs.find((x) => x.id === id), v = values[id];
      if (v === undefined || v === null) return d ? d.value : undefined;
      if (!d) return v;
      if (d.type === 'toggle') return !!v;
      if (d.options) return Math.min(d.options.length - 1, Math.max(0, Math.round(v))) || 0;
      return Math.min(d.max, Math.max(d.min, v));
    },
    set(id, v) {
      const d = defs.find((x) => x.id === id);
      if (d && d.reload && settings.get(id) !== v) needReload = true;
      values[id] = v;
      try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(values)); } catch {}
      for (const fn of changeFns.get(id) || []) { try { fn(v); } catch (e) { console.warn('[core] setting', id, e); } }
    },
    onChange(id, fn) { if (!changeFns.has(id)) changeFns.set(id, []); changeFns.get(id).push(fn); },
    list: () => defs.map((d) => ({ ...d, current: settings.get(d.id) })),
  };
  const DETAIL_NAMES = ['', 'normaal', 'meer', 'veel', 'heel veel', 'maximaal'];
  settings.define({ id: 'detail', label: 'Detail bij vernielen', min: 1, max: 5, step: 1, value: 1,
    format: (v) => `${v} · ${DETAIL_NAMES[v]}${v > 1 ? ` (${2 ** (v - 1)}× zoveel stukken)` : ''}`,
    help: 'Hoe fijn gebouwen in stukken breken (raket, monster, kernbom). Hoger = mooier, maar zwaarder voor de computer.' });
  const detail = () => { const level = settings.get('detail') || 1; return { level, factor: 2 ** (level - 1) }; };
  settings.define({ id: 'blood', label: 'Bloed', min: 1, max: 5, step: 1, value: 1,
    format: (v) => (v > 1 ? `${2 ** (v - 1)}× zoveel` : 'normaal'),
    help: 'Hoeveel bloed er spat als iemand geraakt wordt (inwoners en agenten): 1, 2, 4, 8 of 16 keer zoveel.' });
  const blood = () => 2 ** ((settings.get('blood') || 1) - 1);

  function renderPopup() {
    const list = popupEl.querySelector('.list');
    list.innerHTML = '';
    for (const d of defs) {
      const row = document.createElement('div');
      row.className = 'set';
      const v = settings.get(d.id), fmt = (x) => (d.format ? d.format(x) : String(x));
      const help = (d.help ? d.help : '') + (d.reload ? (d.help ? ' ' : '') + '<i>Na herladen.</i>' : '');
      const helpHtml = help ? `<div class="help">${help}</div>` : '';
      if (d.type === 'toggle') {
        row.innerHTML = `<div class="head tg"><label for="sc-set-${d.id}">${d.label}</label>
          <input id="sc-set-${d.id}" class="sw" type="checkbox" role="switch"${v ? ' checked' : ''}></div>${helpHtml}`;
        const input = row.querySelector('input');
        input.addEventListener('change', () => { settings.set(d.id, input.checked); renderButtons(); });
      } else if (d.options) {
        row.innerHTML = `<div class="head"><label>${d.label}</label></div><div class="opts" role="radiogroup"></div>${helpHtml}`;
        const opts = row.querySelector('.opts');
        d.options.forEach((name, i) => {
          const b = document.createElement('button');
          b.type = 'button'; b.textContent = name; b.setAttribute('role', 'radio');
          b.setAttribute('aria-checked', String(i === v)); if (i === v) b.className = 'on';
          b.addEventListener('click', () => {
            settings.set(d.id, i);
            for (const x of opts.children) { const on = x === b; x.className = on ? 'on' : ''; x.setAttribute('aria-checked', String(on)); }
            renderButtons();
          });
          opts.appendChild(b);
        });
      } else {
        row.innerHTML = `<div class="head"><label for="sc-set-${d.id}">${d.label}</label><b></b></div>
          <input id="sc-set-${d.id}" type="range" min="${d.min}" max="${d.max}" step="${d.step || 1}" value="${v}">${helpHtml}`;
        const out = row.querySelector('b'), input = row.querySelector('input');
        out.textContent = fmt(v);
        input.addEventListener('input', () => { const x = parseFloat(input.value); out.textContent = fmt(x); settings.set(d.id, x); renderButtons(); });
      }
      list.appendChild(row);
    }
    renderButtons();
  }
  // "Klaar" reloads the page when a setting changed that only applies after a reload
  function renderButtons() {
    if (!popupEl) return;
    popupEl.querySelector('.close').textContent = needReload ? 'Klaar · herladen' : 'Klaar';
  }
  function openSettings() {
    if (popupEl) { closeSettings(); return; }
    popupEl = document.createElement('div');
    popupEl.id = 'sc-settings-popup';
    popupEl.innerHTML = `
      <style>
        #sc-settings-popup{position:fixed;inset:0;z-index:10050;display:flex;align-items:center;justify-content:center;background:rgba(10,12,20,.45);font:500 15px/1.4 system-ui,sans-serif}
        #sc-settings-popup .box{width:min(460px,calc(100vw - 32px));max-height:calc(100vh - 48px);overflow:auto;background:#1d2233;color:#fff;border-radius:16px;padding:20px 22px;box-shadow:0 12px 40px rgba(0,0,0,.5)}
        #sc-settings-popup h2{margin:0 0 4px;font:800 22px/1.2 system-ui,sans-serif;color:#ffd23f}
        #sc-settings-popup .sub{opacity:.75;font-size:13px;margin-bottom:8px}
        #sc-settings-popup .set{background:#151927;border-radius:10px;padding:10px 12px;margin-top:10px}
        #sc-settings-popup .head{display:flex;justify-content:space-between;gap:12px;align-items:baseline}
        #sc-settings-popup .head label{font-weight:700}
        #sc-settings-popup .head b{font-variant-numeric:tabular-nums;text-align:right;color:#ffd23f}
        #sc-settings-popup input[type=range]{width:100%;margin:8px 0 2px;accent-color:#ffd23f}
        #sc-settings-popup .help{font-size:12px;opacity:.7}
        #sc-settings-popup .buttons{display:flex;gap:10px;justify-content:space-between;margin-top:16px}
        #sc-settings-popup .buttons button{border:0;border-radius:10px;padding:10px 18px;font:800 15px system-ui,sans-serif;cursor:pointer;background:#3a4160;color:#fff}
        #sc-settings-popup .buttons .close{background:#ffd23f;color:#223}
        #sc-settings-popup .head.tg{align-items:center}
        #sc-settings-popup .head input.sw{appearance:none;-webkit-appearance:none;flex:none;width:44px;height:24px;margin:0;border-radius:12px;background:#3a4160;position:relative;cursor:pointer;transition:background .15s}
        #sc-settings-popup .head input.sw::after{content:'';position:absolute;left:3px;top:3px;width:18px;height:18px;border-radius:50%;background:#fff;transition:left .15s}
        #sc-settings-popup .head input.sw:checked{background:#ffd23f}
        #sc-settings-popup .head input.sw:checked::after{left:23px;background:#223}
        #sc-settings-popup .head input.sw:focus-visible,#sc-settings-popup .opts button:focus-visible{outline:2px solid #fff;outline-offset:2px}
        #sc-settings-popup .opts{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 4px}
        #sc-settings-popup .opts button{flex:1 1 auto;border:0;border-radius:8px;padding:6px 10px;font:700 13px system-ui,sans-serif;cursor:pointer;background:#3a4160;color:#fff}
        #sc-settings-popup .opts button.on{background:#ffd23f;color:#223}
      </style>
      <div class="box" role="dialog" aria-label="Instellingen">
        <h2>Instellingen</h2>
        <div class="sub">Worden onthouden in deze browser. Ze gelden voor wat hierna gebeurt.</div>
        <div class="list"></div>
        <div class="buttons"><button type="button" class="reset">Standaard</button><button type="button" class="close">Klaar</button></div>
      </div>`;
    document.body.appendChild(popupEl);
    renderPopup();
    popupEl.querySelector('.close').addEventListener('click', closeSettings);
    popupEl.querySelector('.reset').addEventListener('click', () => { for (const d of defs) settings.set(d.id, d.value); renderPopup(); });
    popupEl.tabIndex = -1; popupEl.focus();
    popupEl.addEventListener('click', (e) => { if (e.target === popupEl) closeSettings(); });
    popupEl.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSettings(); });
  }
  function closeSettings() {
    if (popupEl) { popupEl.remove(); popupEl = null; }
    if (needReload) { needReload = false; location.reload(); }
  }
  // the button in the app's menu (next to the other scripts' buttons)
  const SVG = 'xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="g-ico" aria-hidden="true"';
  const ICON = `<svg ${SVG}><path d="M4 21v-7"/><path d="M4 10V3"/><path d="M12 21v-9"/><path d="M12 8V3"/><path d="M20 21v-5"/><path d="M20 12V3"/><path d="M2 14h4"/><path d="M10 8h4"/><path d="M18 16h4"/></svg>`;
  function ensureButton() {
    if (document.getElementById('sc-settings')) return;
    const row = document.querySelector('.hz-tr .menu-mini'); if (!row) return;
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'icon-btn small'; b.id = 'sc-settings';
    b.title = 'Instellingen (scripts)'; b.setAttribute('aria-label', 'Instellingen (scripts)');
    b.innerHTML = '<b class="s-bg"></b>' + ICON;
    b.addEventListener('click', (e) => { e.stopPropagation(); openSettings(); });
    row.appendChild(b);
  }
  const startButton = () => { ensureButton(); new MutationObserver(ensureButton).observe(document.body, { childList: true, subtree: true }); };
  if (document.body) startButton(); else document.addEventListener('DOMContentLoaded', startButton);

  // ---------- small shared helpers ----------
  const isFacade = (m) => !!(m && m.map && typeof m.customProgramCacheKey === 'function' && m.customProgramCacheKey() === 'facade');
  // the building (group with userData.projectId) an object belongs to, or null
  function projectOf(o) { for (let p = o; p; p = p.parent) if (p.userData && p.userData.projectId !== undefined) return p; return null; }

  // ---------- lights out (destroyed buildings, broken street lamps) ----------
  // Most of the app's night light is not in the scene graph: the light pools under the street
  // lamps and the glow round every building are drawn into a "night map" (its own pass) from
  // view.staticLights, which view.gatherStaticLights() rebuilds from view.placed and view.lamps
  // whenever view.staticLightsDirty is set. Christmas bulbs and wall glows come from
  // view.syncLights() (view.entries, per project, when view.lightsDirty is set). The view (the
  // app's city class) is found through React: the canvas' container div belongs to a component
  // that keeps the view in a ref. Its methods are wrapped on that one instance: while they run,
  // the dark buildings and dead lamps are left out of the lists they read.
  // Street lamps: view.lamps (road lamps first – one instance each in view.lampPosts' pole and
  // head InstancedMeshes – then the highways' lamps, merged into the road mesh), their glow
  // sprites in view.lampGlow (one point per lamp, additive, colour in `aColor`).
  const darkIds = new Set();                                       // project ids whose lights are out
  const deadLamps = new Map();                                     // lamp key → 'out' | 'fell'
  const lampKey = (l) => Math.round(l.lightX * 100) + ',' + Math.round(l.lightZ * 100);
  let view = null;
  function findView() {
    if (view) return view;
    const el = renderer && renderer.domElement && renderer.domElement.parentElement;
    if (!el) return null;
    const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
    if (!key) return null;
    for (let f = el[key]; f; f = f.return) {
      for (let h = f.memoizedState; h && typeof h === 'object' && 'next' in h; h = h.next) {
        const v = h.memoizedState && h.memoizedState.current;
        if (v && typeof v === 'object' && 'staticLights' in v && v.nightMap && typeof v.gatherStaticLights === 'function') return (view = hookView(v));
      }
    }
    return null;
  }
  function hookView(v) {
    const gather = v.gatherStaticLights;
    v.gatherStaticLights = function () {
      if (!this.staticLightsDirty || (!darkIds.size && !deadLamps.size)) return gather.apply(this, arguments);
      const placed = this.placed, lamps = this.lamps;
      if (Array.isArray(placed)) this.placed = placed.filter((p) => !darkIds.has(p.id));
      if (Array.isArray(lamps)) this.lamps = lamps.filter((l) => !deadLamps.has(lampKey(l)));
      try { return gather.apply(this, arguments); } finally { this.placed = placed; this.lamps = lamps; }
    };
    if (typeof v.syncLights === 'function') {
      const sync = v.syncLights;
      v.syncLights = function () {
        if (!this.lightsDirty || !darkIds.size || !(this.entries instanceof Map)) return sync.apply(this, arguments);
        const entries = this.entries;
        this.entries = new Map([...entries].filter(([id]) => !darkIds.has(id)));
        try { return sync.apply(this, arguments); } finally { this.entries = entries; }
      };
    }
    // the app sets the lamps again when the roads change (posts first, then view.lamps, then the glow)
    const glow = v.lampGlow;
    if (glow && typeof glow.set === 'function') {
      const set = glow.set;
      glow.set = function () { const r = set.apply(this, arguments); try { darkenLamps(); } catch (e) { console.warn('[core] lamps', e); } return r; };
    }
    v.staticLightsDirty = true; v.lightsDirty = true;
    return v;
  }
  // dead lamps: glow sprite black (it adds light), head swapped for an unlit copy, a fallen one's post gone
  let M4 = null;
  function darkenLamps() {
    const v = view; if (!v || !deadLamps.size) return;
    const lamps = Array.isArray(v.lamps) ? v.lamps : [];
    const g = v.lampGlow && v.lampGlow.object && v.lampGlow.object.geometry, col = g && g.getAttribute('aColor');
    if (col) {
      let changed = false;
      lamps.forEach((l, i) => { if (i < col.count && deadLamps.has(lampKey(l)) && (col.getX(i) || col.getY(i) || col.getZ(i))) { col.setXYZ(i, 0, 0, 0); changed = true; } });
      if (changed) col.needsUpdate = true;
    }
    const posts = v.lampPosts && v.lampPosts.object; if (!posts) return;
    const own = posts.children.filter((c) => c.isInstancedMesh && !c.userData.scDarkHeads), poles = own[0], heads = own[1];
    if (!poles || !heads) return;
    M4 = M4 || new heads.matrix.constructor();
    let dark = posts.children.find((c) => c.userData.scDarkHeads);      // (view.lampPosts.set() clears the group: made again then)
    if (!dark) {
      const mat = heads.material.clone();                         // keeps the app's night-map shader patch (prototype)
      mat.emissiveIntensity = 0;
      dark = new heads.constructor(heads.geometry, mat, heads.count);
      dark.count = 0; dark.frustumCulled = false; dark.castShadow = dark.receiveShadow = true;
      dark.userData.scDarkHeads = true; dark.userData.slots = new Map();
      posts.add(dark);
    }
    const isZero = (mesh, i) => { mesh.getMatrixAt(i, M4); const e = M4.elements; return !e[0] && !e[1] && !e[2] && !e[5] && !e[10]; };
    const zero = (mesh, i) => { mesh.setMatrixAt(i, M4.makeScale(0, 0, 0)); mesh.instanceMatrix.needsUpdate = true; };
    const n = Math.min(heads.count, poles.count, lamps.length);
    for (let i = 0; i < n; i++) {
      const k = lampKey(lamps[i]), state = deadLamps.get(k);
      if (!state) continue;
      if (!isZero(heads, i)) {
        if (state === 'out' && dark.count < heads.count) { heads.getMatrixAt(i, M4); dark.setMatrixAt(dark.count, M4); dark.userData.slots.set(k, dark.count++); dark.instanceMatrix.needsUpdate = true; }
        zero(heads, i);
      }
      if (state === 'fell') {
        if (!isZero(poles, i)) zero(poles, i);
        const s = dark.userData.slots.get(k);
        if (s !== undefined) { zero(dark, s); dark.userData.slots.delete(k); }
      }
    }
  }
  // lightsOut(id | [ids]): those buildings' night glow, Christmas bulbs and wall glows go out
  function lightsOut(ids) {
    let n = 0;
    for (const id of [].concat(ids)) if (id !== undefined && id !== null && !darkIds.has(id)) { darkIds.add(id); n++; }
    const v = findView();
    if (n && v) { v.staticLightsDirty = true; v.lightsDirty = true; }
    return n;
  }
  // lampsOut(x, z, r, { fell }): street lamps within r tiles go out; fell (true, or fn(distance,
  // lamp) → true) knocks the post down as well (it vanishes). Returns how many changed.
  function lampsOut(x, z, r, opts = {}) {
    const v = findView(); if (!v || !Array.isArray(v.lamps)) return 0;
    let n = 0;
    for (const l of v.lamps) {
      const d = Math.hypot(l.lightX - x, l.lightZ - z);
      if (!(d <= r)) continue;
      const k = lampKey(l), was = deadLamps.get(k);
      const fell = typeof opts.fell === 'function' ? !!opts.fell(d, l) : !!opts.fell;
      if (was === 'fell' || (was && !fell)) continue;
      deadLamps.set(k, fell ? 'fell' : 'out'); n++;
    }
    if (n) { v.staticLightsDirty = true; darkenLamps(); }
    return n;
  }
  // darkFacade(material): a copy of the facade material without the lit windows (rubble, ruins)
  const darkMats = new WeakMap();
  function darkFacade(m) {
    if (!isFacade(m) || (m.userData && m.userData.scDark)) return m;
    let d = darkMats.get(m);
    if (!d) {
      d = m.clone();
      d.userData = Object.assign({}, m.userData, { scDark: true });
      const compile = m.onBeforeCompile;
      d.onBeforeCompile = function (sh, r) { compile.call(this, sh, r); sh.uniforms.uNight = { value: 0 }; };   // windows light up only when uNight > 0
      d.customProgramCacheKey = m.customProgramCacheKey;                 // same shader code; uniforms are per material
      darkMats.set(m, d);
    }
    return d;
  }
  // explosions break the bulbs of street lamps within their radius (the nuke does its own)
  onDamage((ev) => {
    if (ev && ev.kind === 'blast' && ev.source !== 'nuke' && ev.x !== undefined && ev.radius > 0) lampsOut(ev.x, ev.z, ev.radius);
    return null;
  });

  window.scCore = {
    version: '1.7',
    get renderer() { return renderer; },
    get scene() { return scene; },
    get camera() { return camera; },
    get overlay() { return overlay; },
    onRender(fn) { if (typeof fn === 'function') renderFns.push(fn); },
    onDraw(fn) { if (typeof fn === 'function') drawFns.push(fn); },
    onRenderer(fn) { if (typeof fn !== 'function') return; rendererFns.push(fn); if (renderer) try { fn(renderer); } catch (e) { console.warn('[core] renderer', e); } },
    onGeometryProto, app,
    classes,
    get city() { return city; },
    get cityVersion() { return cityVersion; },
    onCity(fn) { if (typeof fn === 'function') { cityFns.push(fn); if (city) try { fn(city); } catch (e) { console.warn('[core] city', e); } } },
    traffic: () => trafficCars,
    out, audio, onFrame, puff, smoke, smokeStats, damage, onDamage, isFacade, projectOf,
    view: findView, lightsOut, lampsOut, darkFacade, isDark: (id) => darkIds.has(id),
    settings, detail, blood, openSettings,
  };
  // scripts that loaded before the core and are waiting for it
  const waiting = Array.isArray(window.scCoreWaiting) ? window.scCoreWaiting : [];
  window.scCoreWaiting = { push: (fn) => { try { fn(window.scCore); } catch (e) { console.warn('[core] waiting', e); } } };
  for (const fn of waiting) window.scCoreWaiting.push(fn);
})();
