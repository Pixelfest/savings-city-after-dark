// ==UserScript==
// @name         Savings City – kebab harpoon (walk mode)
// @namespace    savings-city-tweaks
// @version      1.0
// @description  Adds a harpoon gun to walk mode (key 8): a heavy barbed bolt that goes straight through everyone in its way – up to six people on one shaft – and sticks in the next wall, tree, lamp or the ground, where they hang twitching and bleeding. Police officers on the shaft keep shooting at you (badly) until they bleed out. Hit a car and it's on the line: hold the mouse button to reel it in (the driver bails out), let go and it rolls on; X cuts the cable.
// @match        https://your-savings-city-host.example/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * Needs walk mode (1.37 or newer: plugin weapons, rayBuildings, hitCar, hitProp, onKey), the core
 * (classes, frame loop, sound output) and residents (skin(i, cause) with the person's colours,
 * spatter, screamAt, addRunner, knockDown). Officers are pinned with cops 1.16 or newer (pin).
 *
 * - The shot: a barbed steel bolt on a cable flies along the crosshair (a little drop), fast.
 *   Every person whose body it crosses is taken off the street (residents' skin(p, 'harpoon'):
 *   they count as "harpoon" in the bodycount) and carried on the shaft – the first one nearest the
 *   tip, the next behind them, at most MAX_SKEWER. Officers stay the cops script's own: pinned
 *   (scCops.pin), they turn on the shaft and keep firing at you, badly, until they bleed out.
 * - It stops in the first solid thing: a wall (the tip goes in), a tree or a lamp, the ground (at
 *   an angle; whoever is low on it ends up lying in a heap at its foot), a parked car. The cable
 *   comes off, except on a car.
 * - On the shaft: people twitch for a few seconds and go limp, blood sprays out where the bolt went
 *   through, drips for a while and pools under each of them. The kebab stays KEBAB_TIME seconds.
 * - A traffic car that's hit is hooked: the driver gets out and runs, the car is ours (drawn from
 *   its own batch's model, the traffic car itself leaves the road). Hold the mouse button to reel
 *   it in: it's dragged towards you, turning so the hook trails, and knocks over whoever is in the
 *   way. Let go: it rolls on and slows down. A click while a car is on the line reels, it doesn't
 *   fire; X cuts the cable (so does a car that's pulled in all the way and let go, switching
 *   weapons, leaving walk mode, or a car more than CABLE_MAX away).
 * - Everything for the figures is instanced (one box pool, one blob pool for the pools of blood);
 *   shafts and the cable are plain meshes. At most MAX_KEBABS shafts (the oldest goes first).
 */
(function () {
  'use strict';

  // ---- settings (tiles; 1 tile ≈ 20 m; a person is 0.135 tall) ----
  const KEY = 'Digit8';            // select with 8 (or Q / the scroll wheel)
  const INTERVAL = 1.2;            // seconds between two shots (reloading)
  const BOLT_SPEED = 11;           // tiles/s
  const BOLT_DROP = 0.5;           // tiles/s² it drops
  const MAX_FLIGHT = 2;            // seconds: a bolt that hit nothing by then is gone
  const SHAFT = 0.36;              // tiles: the shaft's length (≈ 7 m)
  const TIP_GAP = 0.05;            // the first person sits this far behind the tip…
  const GAP = 0.045;               // …and the next ones this far apart
  const MAX_SKEWER = 6;            // people on one shaft
  const EMBED = 0.045;             // how deep the tip goes into a wall, a tree or the ground
  const HIT_R = 0.024;             // a person's half width for the bolt
  const TWITCH = [2.5, 6];         // seconds a person on the shaft twitches
  const BLEED = 12;                // seconds they drip
  const POOL = 0.045;              // tiles: the pool of blood under each grows to this radius
  const KEBAB_TIME = 45;           // seconds a kebab stays…
  const KEBAB_FADE = 1.2;          // …then it shrinks away this fast
  const MAX_KEBABS = 8;
  const REEL_ACCEL = 3;            // tiles/s² a hooked car is pulled with while you hold the button…
  const REEL_SPEED = 1.3;          // …up to this speed
  const ROLL_FRICTION = 0.7;       // tiles/s² it slows down with once you let go
  const CABLE_MIN = 0.28;          // it can't be pulled closer than this
  const CABLE_MAX = 6;             // the cable snaps beyond this
  const RUN_OVER = 0.35;           // tiles/s: faster than this, a dragged car knocks people over
  const VOLUME = 0.3;
  const CAP_BOXES = MAX_KEBABS * MAX_SKEWER * 6, CAP_BLOBS = MAX_KEBABS * MAX_SKEWER + 8;
  // --------------------------------------------------------------

  const H_PERSON = 0.135, FLOOR = 0.038, TORSO = 0.076;
  const rnd = (a, b) => a + Math.random() * (b - a);
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const W = () => window.scWalk;
  const C = () => window.scCore;
  const RES = () => window.scResidents;
  const COPS = () => window.scCops;

  const ANY_SHIRT = ['#e25d5d', '#4f8fd8', '#f0a24a', '#7bc77b', '#f2f2f2', '#9b6fd8'];
  // the figure (person-local, feet at 0, z = front): [part, x, y, z, w, h, d]
  const FIGURE = [['legs', -0.0075, 0.024, 0, 0.014, 0.048, 0.018], ['legs', 0.0075, 0.024, 0, 0.014, 0.048, 0.018],
    ['shirt', 0, 0.076, 0, 0.036, 0.054, 0.024], ['skin', 0, 0.116, 0, 0.022, 0.022, 0.022], ['hair', 0, 0.1305, -0.001, 0.024, 0.007, 0.024]];

  // ---------- small 3D maths (3×3 row-major) ----------
  function rotM(x, y, z, a) {
    const c = Math.cos(a), s = Math.sin(a), t = 1 - c;
    return [t * x * x + c, t * x * y - s * z, t * x * z + s * y, t * x * y + s * z, t * y * y + c, t * y * z - s * x, t * x * z - s * y, t * y * z + s * x, t * z * z + c];
  }
  const mul = (A, B) => [
    A[0] * B[0] + A[1] * B[3] + A[2] * B[6], A[0] * B[1] + A[1] * B[4] + A[2] * B[7], A[0] * B[2] + A[1] * B[5] + A[2] * B[8],
    A[3] * B[0] + A[4] * B[3] + A[5] * B[6], A[3] * B[1] + A[4] * B[4] + A[5] * B[7], A[3] * B[2] + A[4] * B[5] + A[5] * B[8],
    A[6] * B[0] + A[7] * B[3] + A[8] * B[6], A[6] * B[1] + A[7] * B[4] + A[8] * B[7], A[6] * B[2] + A[7] * B[5] + A[8] * B[8]];
  const apply = (M, v) => [M[0] * v[0] + M[1] * v[1] + M[2] * v[2], M[3] * v[0] + M[4] * v[1] + M[5] * v[2], M[6] * v[0] + M[7] * v[1] + M[8] * v[2]];
  const rotY = (a) => { const c = Math.cos(a), s = Math.sin(a); return [c, 0, s, 0, 1, 0, -s, 0, c]; };
  // a basis whose local +z points along -d (the shaft runs back from the tip) and +y is as up as can be
  function shaftBasis(d) {
    const z = [-d[0], -d[1], -d[2]], up = Math.abs(d[1]) > 0.95 ? [1, 0, 0] : [0, 1, 0];
    let x = [up[1] * z[2] - up[2] * z[1], up[2] * z[0] - up[0] * z[2], up[0] * z[1] - up[1] * z[0]];
    const xl = Math.hypot(...x) || 1; x = x.map((a) => a / xl);
    const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
    return [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]];
  }
  function writeM(e, o, B, t, sx = 1, sy = 1, sz = 1) {
    e[o] = B[0] * sx; e[o + 1] = B[3] * sx; e[o + 2] = B[6] * sx; e[o + 3] = 0;
    e[o + 4] = B[1] * sy; e[o + 5] = B[4] * sy; e[o + 6] = B[7] * sy; e[o + 7] = 0;
    e[o + 8] = B[2] * sz; e[o + 9] = B[5] * sz; e[o + 10] = B[8] * sz; e[o + 11] = 0;
    e[o + 12] = t[0]; e[o + 13] = t[1]; e[o + 14] = t[2]; e[o + 15] = 1;
  }
  function setObj(obj, B, t, s = 1) { obj.matrixAutoUpdate = false; writeM(obj.matrix.elements, 0, B, t, s, s, s); obj.matrixWorldNeedsUpdate = true; }

  // ---------- geometry ----------
  function boxTris() {
    const v = [[-.5, -.5, -.5], [.5, -.5, -.5], [.5, .5, -.5], [-.5, .5, -.5], [-.5, -.5, .5], [.5, -.5, .5], [.5, .5, .5], [-.5, .5, .5]];
    const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [2, 3, 7], [2, 7, 6], [1, 2, 6], [1, 6, 5], [0, 4, 7], [0, 7, 3]];
    const P = [];
    for (const t of f) for (const k of t) P.push(...v[k]);
    return P;
  }
  function blobTris() {  // icosahedron of radius 0.5
    const t = (1 + Math.sqrt(5)) / 2;
    const V = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]]
      .map((v) => { const l = Math.hypot(...v) * 2; return v.map((x) => x / l); });
    const F = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
    const P = [];
    for (const [a, b, c] of F) P.push(...V[a], ...V[c], ...V[b]);
    return P;
  }
  // the bolt, tip at the origin, shaft along +z: a steel rod with a barbed head and a cable eye
  // (L: the shaft length; boxes [x, y, z, w, h, d, colour, turn around z])
  function boltParts(L) {
    return [[0, 0, L / 2, 0.006, 0.006, L, '#4a4e57'], [0, 0, 0.012, 0.012, 0.012, 0.024, '#b9bec6', Math.PI / 4],
      [0, 0, 0.003, 0.006, 0.006, 0.008, '#e3e6ea'],
      [0.009, 0, 0.026, 0.004, 0.003, 0.02, '#9aa0a8', 0], [-0.009, 0, 0.026, 0.004, 0.003, 0.02, '#9aa0a8', 0],
      [0, 0.009, 0.026, 0.003, 0.004, 0.02, '#9aa0a8', 0], [0, -0.009, 0.026, 0.003, 0.004, 0.02, '#9aa0a8', 0],
      [0, 0, L - 0.004, 0.012, 0.012, 0.008, '#2b2d33']];
  }

  // ---------- the weapon ----------
  // In your hand: a heavy harpoon gun with a reel under the barrel; the bolt sticks out in front
  // (gone while it's out, back when reloaded).
  let heldBolt = null;
  const def = {
    id: 'harpoon', name: 'Kebabharpoen', key: KEY, interval: INTERVAL, kick: 1.6,
    at: [0.13, -0.15, -0.34], aim: 1.1, roll: -0.04, muzzle: [0, 0.012, -0.36],
    build({ builder, mesh, colors }) {
      const { METAL, DARK, GRIP, SKIN, SLEEVE } = colors;
      const b = builder();
      b.box(0, 0.012, -0.16, 0.034, 0.034, 0.4, DARK);                  // barrel
      b.box(0, 0.012, -0.355, 0.042, 0.042, 0.02, METAL);                // muzzle ring
      b.box(0, -0.026, -0.12, 0.05, 0.05, 0.05, '#7a2b1f');             // reel drum
      b.box(0.028, -0.026, -0.12, 0.006, 0.02, 0.02, METAL);            // its handle
      b.box(0, -0.026, -0.12, 0.054, 0.018, 0.018, '#d8d1c2');          // the cable wound on it
      b.box(0, -0.035, 0.02, 0.028, 0.08, 0.035, GRIP, -0.3);           // grip
      b.box(0, 0.0, 0.09, 0.03, 0.045, 0.12, GRIP);                     // stock
      b.box(0, -0.06, 0.02, 0.045, 0.05, 0.05, SKIN, -0.3);             // hand
      b.box(0.005, -0.1, 0.1, 0.06, 0.065, 0.16, SLEEVE, 0.45);         // sleeve
      const root = mesh(b);
      const bb = builder();                                              // the bolt, ready
      for (const [x, y, z, w, h, d, hex, roll] of boltParts(0.28)) bb.box(x, y + 0.012, z - 0.56, w * 1.6, h * 1.6, d, hex, 0, roll || 0);
      heldBolt = mesh(bb);
      root.add(heldBolt);
      return { root, flash: mesh(builder()) };                          // no muzzle flash
    },
    fire({ o, d, start }) { shoot(o, d, start); },
  };
  (window.scWalkWeapons = window.scWalkWeapons || []).push(def);

  // ---------- pools and meshes ----------
  let K = null, scene = null, ready = false, boltGeo = null, boltMat = null, cable = null;
  const pools = {};
  function noSnow(m) { m.defines = { ...(m.defines || {}), SNOW_COVER: '-0.50' }; return m; }
  function makePool(name, tris, cap) {
    const g = new K.Geometry();
    g.setAttribute('position', new K.Attr(new Float32Array(tris), 3));
    g.computeVertexNormals();
    const mesh = new K.Instanced(g, noSnow(new K.Lambert({ color: '#ffffff' })), cap);
    mesh.frustumCulled = false; mesh.count = 0; mesh.name = 'sc-harpoon-' + name;
    mesh.castShadow = name === 'box'; mesh.receiveShadow = true;
    const w = new K.Color('#ffffff');
    for (let i = 0; i < cap; i++) mesh.setColorAt(i, w);
    mesh.instanceMatrix.array.fill(0);
    scene.add(mesh);
    const free = [];
    for (let i = cap - 1; i >= 0; i--) free.push(i);
    return { mesh, free, hi: 0, dirty: false, m: mesh.instanceMatrix.array, colors: new Map() };
  }
  function take(pool, hex) {
    const i = pool.free.pop();
    if (i === undefined) return -1;
    if (i + 1 > pool.hi) pool.hi = i + 1;
    let col = pool.colors.get(hex);
    if (!col) pool.colors.set(hex, (col = new K.Color(hex)));
    pool.mesh.setColorAt(i, col);
    if (pool.mesh.instanceColor) pool.mesh.instanceColor.needsUpdate = true;
    return i;
  }
  function give(pool, i) { if (i < 0) return; pool.m.fill(0, i * 16, i * 16 + 16); pool.free.push(i); pool.dirty = true; }
  function put(pool, i, B, t, sx, sy, sz) { if (i < 0) return; writeM(pool.m, i * 16, B, t, sx, sy, sz); pool.dirty = true; }
  function ensure() {
    if (ready) return true;
    const c = C();
    K = c && c.classes && c.classes();
    if (!K || !K.Instanced || !K.Geometry || !K.Attr || !K.Color || !K.Lambert || !K.Basic || !c.scene) return false;
    scene = c.scene;
    pools.box = makePool('box', boxTris(), CAP_BOXES);
    pools.blob = makePool('blob', blobTris(), CAP_BLOBS);
    // the bolt: one geometry with vertex colours
    const box = boxTris(), P = [], Co = [], col = new K.Color();
    for (const [x, y, z, w, h, d, hex, roll] of boltParts(SHAFT)) {
      col.set(hex);
      const cr = Math.cos(roll || 0), sr = Math.sin(roll || 0);
      for (let i = 0; i < box.length; i += 3) {
        const vx = box[i] * w, vy = box[i + 1] * h;
        P.push(x + vx * cr - vy * sr, y + vx * sr + vy * cr, z + box[i + 2] * d); Co.push(col.r, col.g, col.b);
      }
    }
    boltGeo = new K.Geometry();
    boltGeo.setAttribute('position', new K.Attr(new Float32Array(P), 3));
    boltGeo.setAttribute('color', new K.Attr(new Float32Array(Co), 3));
    boltGeo.computeVertexNormals();
    boltMat = noSnow(new K.Lambert({ vertexColors: true }));
    const cg = new K.Geometry();
    cg.setAttribute('position', new K.Attr(new Float32Array(box), 3));
    cg.computeVertexNormals();
    cable = new K.Mesh(cg, new K.Basic({ color: '#1c1b1a' }));
    cable.frustumCulled = false; cable.visible = false;
    scene.add(cable);
    ready = true;
    c.onFrame(step);
    return true;
  }
  function flush() {
    for (const p of Object.values(pools)) {
      if (!p.dirty) continue;
      p.dirty = false; p.mesh.count = p.hi; p.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  // ---------- mouse button (held = reeling) and the X key ----------
  let held = false;
  window.addEventListener('mousedown', (e) => { if (e.button === 0) held = true; }, true);
  window.addEventListener('mouseup', (e) => { if (e.button === 0) held = false; }, true);
  window.addEventListener('blur', () => { held = false; });
  let keyHooked = false;
  function hookKeys() {
    const w = W();
    if (keyHooked || !w || typeof w.onKey !== 'function') return;
    keyHooked = true;
    w.onKey((code) => { if (code === 'KeyX' && hook && w.weapon === 'harpoon') { cut(true); return true; } return false; });
  }

  // ---------- shooting ----------
  const kebabs = [];
  let hook = null;          // { kebab, car } the car on the line
  let reloadAt = 0;
  function shoot(o, d, start) {
    if (!ensure()) return;
    hookKeys();
    if (hook) return;                                              // a car on the line: a click reels, it doesn't fire
    while (kebabs.length >= MAX_KEBABS) removeKebab(kebabs[0]);
    const mesh = new K.Mesh(boltGeo, boltMat);
    mesh.castShadow = true; mesh.frustumCulled = false;
    scene.add(mesh);
    // from the eye along the crosshair (where it's aimed), drawn from the muzzle
    const k = { tip: [o.x + d.x * 0.06, o.y + d.y * 0.06 - 0.01, o.z + d.z * 0.06], v: [d.x * BOLT_SPEED, d.y * BOLT_SPEED, d.z * BOLT_SPEED], d: [d.x, d.y, d.z],
      state: 'fly', t: 0, age: 0, mesh, victims: [], embed: 0, fade: 1, car: null, from: start ? [start.x, start.y, start.z] : null };
    kebabs.push(k);
    reloadAt = performance.now() + INTERVAL * 900;
    if (heldBolt) heldBolt.visible = false;
    thunk();
    whir();
    drawKebab(k);
  }

  // one step of a flying bolt: the first solid thing on the way, and everyone before it
  function stepFlying(k, dt) {
    const w = W();
    k.t += dt;
    k.v[1] -= BOLT_DROP * dt;
    const sp = Math.hypot(...k.v), L = sp * dt, dir = [k.v[0] / sp, k.v[1] / sp, k.v[2] / sp];
    k.d = dir;
    const o = { x: k.tip[0], y: k.tip[1], z: k.tip[2] }, dd = { x: dir[0], y: dir[1], z: dir[2] };
    let stop = null;
    const consider = (t, what) => { if (t !== null && t >= 0 && t <= L && (!stop || t < stop.t)) stop = { t, ...what }; };
    if (w) {
      const wall = w.rayBuildings && w.rayBuildings(o, dd, L); if (wall) consider(wall.t, { kind: 'wall', n: wall.n });
      const car = w.hitCar && w.hitCar(o, dd, L); if (car) consider(car.t, { kind: 'car', car: car.car, index: car.index });
      const prop = w.hitProp && w.hitProp(o, dd, L); if (prop) consider(prop.t, { kind: 'prop', prop: prop.prop });
    }
    if (dir[1] < 0 && k.tip[1] + dir[1] * L < FLOOR) consider((k.tip[1] - FLOOR) / -dir[1], { kind: 'ground' });
    skewer(k, dir, stop ? stop.t : L);
    if (stop) {
      for (let a = 0; a < 3; a++) k.tip[a] += dir[a] * stop.t;
      stick(k, stop);
      return;
    }
    for (let a = 0; a < 3; a++) k.tip[a] += dir[a] * L;
    if (k.t > MAX_FLIGHT) removeKebab(k);
  }

  // everyone whose body the bolt crosses between the tip and t (along dir)
  function skewer(k, dir, t) {
    if (k.victims.length >= MAX_SKEWER) return;
    const res = RES(), x0 = k.tip[0], y0 = k.tip[1], z0 = k.tip[2], hh = dir[0] * dir[0] + dir[2] * dir[2];
    if (hh < 1e-6) return;
    const found = [];
    const test = (x, z, k2, y, H) => {   // → distance along the bolt, or -1
      const u = ((x - x0) * dir[0] + (z - z0) * dir[2]) / hh;
      if (u < 0 || u > t) return -1;
      const px = x0 + dir[0] * u, pz = z0 + dir[2] * u;
      if (Math.hypot(px - x, pz - z) > HIT_R * k2) return -1;
      const py = y0 + dir[1] * u;
      return py >= y && py <= y + H ? u : -1;
    };
    if (res && res.people) {
      const bx0 = Math.min(x0, x0 + dir[0] * t) - 0.05, bx1 = Math.max(x0, x0 + dir[0] * t) + 0.05, bz0 = Math.min(z0, z0 + dir[2] * t) - 0.05, bz1 = Math.max(z0, z0 + dir[2] * t) + 0.05;
      for (const q of res.people) {
        if (!q || q.x < bx0 || q.x > bx1 || q.z < bz0 || q.z > bz1) continue;
        if (q.state === 'inside' || q.state === 'gone' || q.state === 'down') continue;
        const k2 = q.k ? 0.75 : 1, u = test(q.x, q.z, k2, 0.036, H_PERSON * (q.k ? 0.8 : 1));
        if (u >= 0) found.push({ u, res: q });
      }
    }
    const cops = COPS() && typeof COPS().officers === 'function' ? COPS().officers() : [];
    cops.forEach((c, i) => {
      if (!c || (c.state !== 'exit' && c.state !== 'fight')) return;
      const u = test(c.x, c.z, 1, 0.038, H_PERSON);
      if (u >= 0) found.push({ u, cop: i, x: c.x, z: c.z });
    });
    found.sort((a, b) => a.u - b.u);
    for (const f of found) {
      if (k.victims.length >= MAX_SKEWER) break;
      const at = [x0 + dir[0] * f.u, y0 + dir[1] * f.u, z0 + dir[2] * f.u];
      if (f.res) {
        let info = null;
        try { info = res.skin(f.res, 'harpoon'); } catch (e) { console.warn('[harpoon] take', e); }
        if (info) addVictim(k, { person: info, at, d: f.u });
      } else {
        let h = null;
        try { h = COPS().pin(f.cop); } catch (e) { h = null; }
        if (h) addVictim(k, { cop: h, at, d: f.u, th: Math.atan2(-dir[0], -dir[2]) });
      }
    }
  }
  function addVictim(k, v) {
    const res = RES(), info = v.person;
    const sc = info ? (info.h || H_PERSON) / H_PERSON : 1;
    const colors = info && info.colors ? info.colors : { shirt: ANY_SHIRT[(Math.random() * ANY_SHIRT.length) | 0], trousers: '#2f4a7a', skin: '#eec4a2', hair: '#3d2a1c', bald: false };
    const parts = [];
    if (info) for (const [kind, x, y, z, sx, sy, sz] of FIGURE) {
      if (kind === 'hair' && colors.bald) continue;
      const hex = kind === 'legs' ? colors.trousers : kind === 'shirt' ? colors.shirt : kind === 'skin' ? colors.skin : colors.hair;
      parts.push({ slot: take(pools.box, hex), o: [x * sc, (y - TORSO) * sc, z * sc], s: [sx * sc, sy * sc, sz * sc] });
    }
    // where on the shaft they are pierced (behind the tip; sliding back to their place on it)
    const i = k.victims.length;
    k.victims.push({ parts, cop: v.cop || null, sc, th: info && typeof info.th === 'number' ? -info.th : v.th || 0, s: 0.01, place: TIP_GAP + i * GAP,
      twitch: rnd(TWITCH[0], TWITCH[1]), ph: rnd(0, 6), t: 0, pool: take(pools.blob, '#5e0a0e'), dripAt: 0, lean: 0, yaw: rnd(-0.3, 0.3) });
    // blood out of both sides where the bolt went through
    if (res && res.spatter) {
      res.spatter(v.at[0], v.at[1], v.at[2], k.d[0], k.d[2], 8, 0.9, 0.25);
      res.spatter(v.at[0], v.at[1], v.at[2], -k.d[0], -k.d[2], 3, 0.4, 0.2);
    }
    if (i === 0 && res && res.screamAt && Math.random() < 0.7) res.screamAt(v.at[0], v.at[2], undefined, false);
    squelch();
    for (let a = 0; a < 3; a++) k.v[a] *= 0.93;                    // every body slows it down a little
  }

  // the bolt stops: in a wall, a tree or lamp, the ground, a car
  function stick(k, stop) {
    const w = W();
    k.state = 'stuck'; k.stop = stop.kind;
    k.embed = stop.kind === 'car' ? 0.02 : EMBED;
    for (let a = 0; a < 3; a++) k.tip[a] += k.d[a] * k.embed;
    for (const v of k.victims) v.place += k.embed;
    if (stop.kind === 'ground' && w && w.spawn) for (let n = 0; n < 8; n++) w.spawn('dust', k.tip[0], FLOOR + 0.01, k.tip[2], { fade: true, vx: rnd(-0.2, 0.2), vy: rnd(0.05, 0.2), vz: rnd(-0.2, 0.2), rise: 0.02, size: rnd(0.02, 0.04), grow: 2, life: rnd(1, 2), alpha: 0.6 });
    if ((stop.kind === 'wall' || stop.kind === 'prop') && w && w.spawn) {
      for (let n = 0; n < 10; n++) w.spawn(stop.kind === 'prop' ? 'wood' : 'debris', k.tip[0] - k.d[0] * k.embed, k.tip[1], k.tip[2] - k.d[2] * k.embed, { vx: -k.d[0] * rnd(0.2, 0.6) + rnd(-0.2, 0.2), vy: rnd(0.1, 0.5), vz: -k.d[2] * rnd(0.2, 0.6) + rnd(-0.2, 0.2), g: 3, size: rnd(0.003, 0.008), life: rnd(1, 2), land: true, spin: true });
      w.spawn('spark', k.tip[0], k.tip[1], k.tip[2], { vx: 0, vy: 0.3, vz: 0, g: 2, size: 0.005, life: 0.3 });
    }
    if (w && w.startEffects) w.startEffects();
    if (stop.kind === 'car' && stop.index !== undefined && !stop.car.isStatic) hookCar(k, stop.car, stop.index);
    else clang(stop.kind);
  }

  // ---------- a car on the line ----------
  function hookCar(k, t, index) {
    const w = W(), res = RES();
    const proxy = w.carObjects().get(index);
    let batch = null;
    w.scene.traverse((o) => { if (!batch && o.isInstancedMesh && Array.isArray(o.userData.cars) && o.userData.cars.includes(index)) batch = o; });
    if (!proxy || !batch || t.scTaken || t.scBurst) { clang('car'); return; }
    proxy.updateWorldMatrix(true, false);
    const e = proxy.matrixWorld.elements;
    const mesh = new K.Mesh(batch.geometry, batch.material);
    mesh.castShadow = true; mesh.receiveShadow = true; mesh.frustumCulled = false; mesh.rotation.order = 'YXZ';
    scene.add(mesh);
    proxy.scale.setScalar(0.0001);
    const car = { mesh, x: e[12], y: e[13], z: e[14], h: t.heading, vx: 0, vz: 0, src: t, knockAt: 0 };
    // the driver gets out on the far side and runs (not from a car nobody's in)
    if (!t.scAbandoned && !t.isStatic && res && typeof res.addRunner === 'function') {
      const pl = w.player, fx = Math.cos(t.heading), fz = Math.sin(t.heading), side = (-fz * (pl.x - t.x) + fx * (pl.z - t.z)) > 0 ? -1 : 1;
      setTimeout(() => res.addRunner(t.x - fz * 0.08 * side, t.z + fx * 0.08 * side, pl.x, pl.z), 400);
    }
    t.scTaken = true; t.scAbandoned = true;
    // the traffic car itself leaves the road (nothing queues behind an invisible car)
    Object.assign(t, { from: '100000,100000', to: '100000,100001', s: 0, lane: 1, prev: undefined, next: undefined, route: undefined, dest: undefined, side: undefined, parked: Infinity, speed: 0, passing: false, x: 100000, z: 100000 });
    placeCar(car);
    // the bolt (and whoever is on it) from now on moves with the car: in the car's own coordinates
    const inv = (v) => { const c = Math.cos(-car.h), s = Math.sin(-car.h); return [v[0] * c - v[2] * s, v[1], v[0] * s + v[2] * c]; };
    k.car = car; k.localTip = inv([k.tip[0] - car.x, k.tip[1] - car.y, k.tip[2] - car.z]); k.localD = inv(k.d);
    k.state = 'hooked';
    hook = { kebab: k, car };
    clank();
  }
  // the car's heading h is the traffic's (forward = (cos h, sin h)); its mesh is turned by −h
  function placeCar(car) { car.mesh.position.set(car.x, car.y, car.z); car.mesh.rotation.set(0, -car.h, 0); }
  function toWorld(car, v) { const c = Math.cos(car.h), s = Math.sin(car.h); return [v[0] * c - v[2] * s, v[1], v[0] * s + v[2] * c]; }
  function gunPoint() {   // a little in front of you, low and to the right: where the cable leaves the gun
    const pl = W().player, cp = Math.cos(pl.pitch), f = [-Math.sin(pl.yaw) * cp, Math.sin(pl.pitch), -Math.cos(pl.yaw) * cp], r = [Math.cos(pl.yaw), 0, -Math.sin(pl.yaw)];
    return [pl.x + f[0] * 0.06 + r[0] * 0.025, pl.y + f[1] * 0.06 - 0.03, pl.z + f[2] * 0.06 + r[2] * 0.025];
  }
  function stepCars(dt) {
    const w = W(), res = RES();
    for (const k of kebabs) {
      const car = k.car;
      if (!car) continue;
      const on = hook && hook.car === car;
      if (on && (!w || !w.walking || w.driving || w.weapon !== 'harpoon')) cut(false);
      let reeling = false;
      if (hook && hook.car === car) {
        const g = gunPoint(), hp = toWorld(car, k.localTip), hx = car.x + hp[0], hz = car.z + hp[2];
        const dx = g[0] - hx, dz = g[2] - hz, D = Math.hypot(dx, dz) || 1e-6;
        if (D > CABLE_MAX) { cut(true); continue; }
        if (held && D > CABLE_MIN) {
          reeling = true;
          car.vx += dx / D * REEL_ACCEL * dt; car.vz += dz / D * REEL_ACCEL * dt;
          const sp = Math.hypot(car.vx, car.vz); if (sp > REEL_SPEED) { car.vx *= REEL_SPEED / sp; car.vz *= REEL_SPEED / sp; }
          // turning so the hook trails towards you
          const th = Math.atan2(hp[2], hp[0]), ph = Math.atan2(g[2] - car.z, g[0] - car.x);
          car.h += Math.atan2(Math.sin(ph - th), Math.cos(ph - th)) * Math.min(1, dt * 2.5) * Math.min(1, sp / 0.3);
          ratchet(dt);
        } else if (!held && D <= CABLE_MIN + 0.06 && Math.hypot(car.vx, car.vz) < 0.05) cut(true);   // pulled in all the way
      }
      if (!reeling) {                                              // rolling on, slowing down
        const sp = Math.hypot(car.vx, car.vz);
        if (sp > 0) { const n = Math.max(0, sp - ROLL_FRICTION * dt) / sp; car.vx *= n; car.vz *= n; }
      }
      // it stops against you (it doesn't roll through you)
      if (w && w.player) {
        const pl = w.player, px = pl.x - car.x, pz = pl.z - car.z, pd = Math.hypot(px, pz) || 1e-6, toward = (car.vx * px + car.vz * pz) / pd;
        if (pd < CABLE_MIN * 0.85 && toward > 0) { car.vx -= px / pd * toward * 1.2; car.vz -= pz / pd * toward * 1.2; if (toward > 0.4 && w.sound) w.sound('thud'); }
      }
      const sp = Math.hypot(car.vx, car.vz);
      if (sp < 1e-4) continue;
      const nx = car.x + car.vx * dt, nz = car.z + car.vz * dt;
      if (w && w.blocked && w.blocked(nx, car.z)) car.vx *= -0.2; else car.x = nx;
      if (w && w.blocked && w.blocked(car.x, nz)) car.vz *= -0.2; else car.z = nz;
      placeCar(car);
      // whoever is in the way goes over
      const now = performance.now();
      if (sp > RUN_OVER && res && res.people && now > car.knockAt) {
        car.knockAt = now + 100;
        for (const q of res.people) {
          if (!q || q.state !== 'walk' || Math.abs(q.x - car.x) > 0.09 || Math.abs(q.z - car.z) > 0.09) continue;
          if (Math.hypot(q.x - car.x, q.z - car.z) < 0.08 && res.knockDown) { res.knockDown(q, { x: car.vx / sp, y: 0, z: car.vz / sp }, 'car'); if (W() && W().sound) W().sound('hit'); }
        }
      }
    }
  }
  function cut(loud) {
    if (!hook) return;
    hook = null;
    cable.visible = false;
    if (loud) twang();
  }

  // ---------- drawing ----------
  function tailOf(k) { return [k.tip[0] - k.d[0] * SHAFT, k.tip[1] - k.d[1] * SHAFT, k.tip[2] - k.d[2] * SHAFT]; }
  function drawKebab(k) {
    if (k.car) {                                                    // riding on a car
      const tp = toWorld(k.car, k.localTip);
      k.tip = [k.car.x + tp[0], k.car.y + tp[1], k.car.z + tp[2]];
      k.d = toWorld(k.car, k.localD);
    }
    const B = shaftBasis(k.d);
    setObj(k.mesh, B, k.tip, k.fade);
    // the people on it
    for (const v of k.victims) {
      const P = [k.tip[0] - k.d[0] * v.s, k.tip[1] - k.d[1] * v.s, k.tip[2] - k.d[2] * v.s];
      // too low to hang upright (a bolt in the ground): they lie in a heap at its foot
      const need = (TORSO * v.sc) + FLOOR;
      v.lean += (clamp01((need - P[1]) / (0.05 * v.sc)) - v.lean) * 0.2;
      const hd = Math.hypot(k.d[0], k.d[2]) || 1, ax = [-k.d[2] / hd, 0, k.d[0] / hd];
      const alive = v.t < v.twitch, a = alive ? 0.12 * Math.sin(v.t * 31 + v.ph) * (1 - v.t / v.twitch) + 0.08 * Math.sin(v.t * 7.3 + v.ph * 2) * (1 - v.t / v.twitch) : 0;
      const sag = Math.min(1, Math.max(0, v.t - v.twitch * 0.8) / 0.8) * 0.3;     // limp: slumped over the shaft
      let R = rotY(v.th + v.yaw);
      R = mul(rotM(ax[0], ax[1], ax[2], v.lean * Math.PI / 2 + sag), R);
      R = mul(rotM(k.d[0], k.d[1], k.d[2], a), R);
      if (v.cop) {
        const f = apply(R, [0, -TORSO, 0]);
        v.cop.set(P[0] + f[0], Math.max(FLOOR - 0.01, P[1] + f[1]), P[2] + f[2], Math.atan2(k.d[0], k.d[2]) + Math.PI / 2, v.lean);
      } else {
        for (const part of v.parts) {
          const o = apply(R, part.o);
          put(pools.box, part.slot, R, [P[0] + o[0], Math.max(FLOOR + 0.002, P[1] + o[1]), P[2] + o[2]], part.s[0] * k.fade, part.s[1] * k.fade, part.s[2] * k.fade);
        }
      }
      // the pool under them
      const pr = k.state === 'fly' ? 0 : POOL * v.sc * Math.min(1, v.t / 7) * k.fade;
      put(pools.blob, v.pool, rotY(v.ph), [P[0], FLOOR + 0.0012, P[2]], pr * 2, 0.0025, pr * 1.6);
    }
  }
  function drawCable() {
    const k = hook ? hook.kebab : kebabs.find((q) => q.state === 'fly');
    if (!k || !W() || !W().walking) { cable.visible = false; return; }
    const a = gunPoint(), b = tailOf(k), d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], L = Math.hypot(...d) || 1e-6;
    // sagging a little when slack (not reeling): the middle hangs lower – drawn straight, just lower
    const B = shaftBasis(d.map((x) => -x / L));
    setObj(cable, B, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - (hook && !held ? 0.01 : 0), (a[2] + b[2]) / 2]);
    const e = cable.matrix.elements;                                // scale: thin, L long
    for (let i = 0; i < 3; i++) { e[i] *= 0.0025; e[4 + i] *= 0.0025; e[8 + i] *= L; }
    cable.visible = true;
  }

  function removeKebab(k) {
    const i = kebabs.indexOf(k); if (i >= 0) kebabs.splice(i, 1);
    if (hook && hook.kebab === k) cut(false);
    k.mesh.removeFromParent();
    for (const v of k.victims) {
      for (const part of v.parts) give(pools.box, part.slot);
      give(pools.blob, v.pool);
      if (v.cop) try { v.cop.release(); } catch (e) { /* gone already */ }
    }
    k.victims = [];
  }

  function step(dt) {
    dt = Math.min(dt || 0, 0.05);
    if (!ready) return;
    if (heldBolt && !heldBolt.visible && !hook && performance.now() > reloadAt) heldBolt.visible = true;
    const res = RES();
    for (const k of kebabs.slice()) {
      if (k.state === 'fly') { stepFlying(k, dt); if (!kebabs.includes(k)) continue; }
      k.age += dt;
      for (const v of k.victims) {
        v.t += dt;
        v.s += (v.place - v.s) * Math.min(1, dt * 12);                // sliding back to their place on the shaft
        if (v.t < BLEED && res && res.spatter && (v.dripAt -= dt) <= 0) {
          v.dripAt = rnd(0.12, 0.4) * (1 + v.t / 4);
          const P = [k.tip[0] - k.d[0] * v.s, k.tip[1] - k.d[1] * v.s, k.tip[2] - k.d[2] * v.s];
          res.spatter(P[0] + rnd(-0.01, 0.01), P[1] - 0.01, P[2] + rnd(-0.01, 0.01), 0, 0, 0.5, 0.02, 0);
        }
      }
      if (k.age > KEBAB_TIME) { k.fade = Math.max(0, 1 - (k.age - KEBAB_TIME) / KEBAB_FADE); if (k.fade <= 0) { removeKebab(k); continue; } }
      drawKebab(k);
    }
    stepCars(dt);
    drawCable();
    flush();
  }
  window.addEventListener('sc:walk', (e) => { if (!e.detail.walking) cut(false); });

  // ---------- sounds (through the core's output: follows the sound button) ----------
  function audio() { const c = C(); return c && c.audio && c.out ? c : null; }
  let noiseBuf = null;
  function noise(a) {
    if (!noiseBuf || noiseBuf.sampleRate !== a.sampleRate) {
      noiseBuf = a.createBuffer(1, a.sampleRate, a.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const s = a.createBufferSource(); s.buffer = noiseBuf; return s;
  }
  function play(fn) { const c = audio(); if (!c) return; try { const a = c.audio(); fn(a, a.currentTime, c.out(a)); } catch (e) { /* no sound */ } }
  function env(a, t, peak, len) { const g = a.createGain(); g.gain.setValueAtTime(peak, t); g.gain.exponentialRampToValueAtTime(0.0001, t + len); return g; }
  function thunk() {   // the gun: a heavy pneumatic thump
    play((a, t, out) => {
      const o = a.createOscillator(), g = env(a, t, VOLUME * 1.4, 0.25);
      o.type = 'sine'; o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.2);
      o.connect(g); g.connect(out); o.start(t); o.stop(t + 0.26);
      const n = noise(a), f = a.createBiquadFilter(), ng = env(a, t, VOLUME * 0.9, 0.12);
      f.type = 'lowpass'; f.frequency.value = 1800; n.connect(f); f.connect(ng); ng.connect(out); n.start(t); n.stop(t + 0.13);
    });
  }
  function whir() {    // the cable running off the reel
    play((a, t, out) => {
      const n = noise(a), f = a.createBiquadFilter(), g = env(a, t, VOLUME * 0.35, 0.45);
      f.type = 'bandpass'; f.Q.value = 6; f.frequency.setValueAtTime(2400, t); f.frequency.exponentialRampToValueAtTime(700, t + 0.45);
      n.connect(f); f.connect(g); g.connect(out); n.start(t); n.stop(t + 0.46);
    });
  }
  let lastSquelch = 0;
  function squelch() {
    const now = performance.now(); if (now - lastSquelch < 40) return; lastSquelch = now;
    play((a, t, out) => {
      const n = noise(a), f = a.createBiquadFilter(), g = env(a, t, VOLUME * 0.9, 0.2);
      f.type = 'lowpass'; f.frequency.setValueAtTime(900, t); f.frequency.exponentialRampToValueAtTime(160, t + 0.18);
      n.connect(f); f.connect(g); g.connect(out); n.start(t); n.stop(t + 0.21);
    });
  }
  function clang(kind) {
    if (kind === 'ground' || kind === 'prop') { const w = W(); if (w && w.sound) w.sound('thud'); return; }
    play((a, t, out) => {
      for (const [f0, v] of [[620, 1], [1490, 0.5], [2730, 0.25]]) {
        const o = a.createOscillator(), g = env(a, t, VOLUME * 0.45 * v, 0.5);
        o.type = 'triangle'; o.frequency.value = f0 * rnd(0.95, 1.05); o.connect(g); g.connect(out); o.start(t); o.stop(t + 0.52);
      }
    });
  }
  function clank() {   // into the car's metal
    play((a, t, out) => {
      const o = a.createOscillator(), g = env(a, t, VOLUME * 0.8, 0.3);
      o.type = 'square'; o.frequency.setValueAtTime(380, t); o.frequency.exponentialRampToValueAtTime(150, t + 0.25);
      const f = a.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 1400;
      o.connect(f); f.connect(g); g.connect(out); o.start(t); o.stop(t + 0.31);
    });
  }
  let ratchetAcc = 0;
  function ratchet(dt) {   // reeling in: the reel clicks
    ratchetAcc -= dt; if (ratchetAcc > 0) return; ratchetAcc = 0.07;
    play((a, t, out) => {
      const n = noise(a), f = a.createBiquadFilter(), g = env(a, t, VOLUME * 0.35, 0.025);
      f.type = 'highpass'; f.frequency.value = 3000; n.connect(f); f.connect(g); g.connect(out); n.start(t); n.stop(t + 0.03);
    });
  }
  function twang() {   // the cable comes off
    play((a, t, out) => {
      const o = a.createOscillator(), g = env(a, t, VOLUME * 0.5, 0.4);
      o.type = 'sawtooth'; o.frequency.setValueAtTime(220, t); o.frequency.exponentialRampToValueAtTime(90, t + 0.35);
      const f = a.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 900; f.Q.value = 3;
      o.connect(f); f.connect(g); g.connect(out); o.start(t); o.stop(t + 0.41);
    });
  }

  // test hooks (by hand in the console, headless runs): fire(o, d) shoots from o along d (unit);
  // reel(on) holds / lets go of the button; cut() lets go of the car; kebabs: what's out there
  window.scHarpoon = {
    fire(o, d) { shoot(o, d, null); },
    reel(on) { held = !!on; },
    cut: () => cut(true),
    get hooked() { return hook ? { x: hook.car.x, z: hook.car.z, speed: Math.hypot(hook.car.vx, hook.car.vz) } : null; },
    get kebabs() { return kebabs.map((k) => ({ state: k.state, stop: k.stop, tip: k.tip.map((x) => +x.toFixed(3)), victims: k.victims.length, cops: k.victims.filter((v) => v.cop).length })); },
  };
})();
