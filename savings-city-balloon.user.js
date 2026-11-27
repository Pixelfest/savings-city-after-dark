// ==UserScript==
// @name         Savings City – Balloonator (walk mode)
// @namespace    savings-city-tweaks
// @version      1.0
// @description  Adds the Balloonator to walk mode (key 9, click): a dart gun that shoots small ampoules. Whoever is hit bloats up into a sphere with a puffy head, floats up into the sky, and about 8 m up, 10 seconds later, bursts – their insides and a lot of blood rain down on the street below.
// @match        https://your-savings-city-host.example/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * Needs walk mode (1.38 or newer for the help text; plugin weapons, rayBuildings, hitCar, hitProp,
 * addTarget), the core (classes, frame loop, sound output, smoke) and residents (skin(p, cause) with
 * the person's colours, spatter, avoid, alarm). Officers are taken with cops' skin(i, cause).
 *
 * - The shot: a small ampoule (a needle, a vial of pink serum and a tuft) flies along the crosshair,
 *   fast, with a little drop. The first person whose body it crosses is hit (residents' or cops'
 *   skin(…, 'balloon'): they leave the city, count as "balloon" in the bodycount, and this script
 *   draws them from then on). A wall, car, tree, lamp or the ground shatters it.
 * - Inflate (INFLATE s): the torso swells into a sphere – shirt on the upper half, trousers on the
 *   lower half, a band of bare belly in between where the shirt rides up – the legs get stubby and
 *   kick, the head puffs up a little (a box head with round cheeks, two eyes and an "O" mouth).
 * - Float: from LIFT_AT the feet leave the ground; they rise slower, then faster, swinging and
 *   turning slowly, drifting with the wind, to ALTITUDE (≈ 8 m) at POP_AT (10 s).
 * - Over-inflation (the last OVER s): the sphere stretches further, trembles and flushes red, the
 *   eyes bulge, the rubber creaks.
 * - Pop: a bang and a red mist; the insides (the skinner's set: flesh, organs, a skull with jaw and
 *   teeth, ribs, spine, leg bones, intestines) burst out and rain down, rags of the stretched
 *   clothes and skin flutter down after them, the legs drop. A lot of blood: a spray in every
 *   direction, a blood rain for a moment, drips from every falling piece, a splat where each one lands
 *   and a big pool under the spot. The heap lies GORE_TIME seconds, people keep away from it.
 * - A floating balloon can be popped early: shoot it (any walk-mode weapon, also another ampoule)
 *   or catch it in an explosion.
 * - Everything is instanced: one InstancedMesh per shape (boxes, spheres, half spheres, blobs) with a
 *   slot pool each. At most MAX_BALLOONS float at once (a new one pops the oldest), at most MAX_HEAPS
 *   heaps lie around (the oldest goes first).
 */
(function () {
  'use strict';

  // ---- settings (tiles; 1 tile ≈ 20 m; a person is 0.135 tall) ----
  const KEY = 'Digit9';            // select with 9 (or Q / the scroll wheel)
  const INTERVAL = 0.6;            // seconds between two shots
  const DART_SPEED = 9;            // tiles/s
  const DART_DROP = 0.6;           // tiles/s² it drops
  const MAX_FLIGHT = 1.5;          // seconds: an ampoule that hit nothing by then is gone
  const HIT_R = 0.026;             // a person's half width for the ampoule
  const INFLATE = 2.6;             // seconds the body takes to swell into a sphere
  const R_START = 0.017;           // the sphere's radius at the start…
  const R_FULL = 0.055;            // …and when fully inflated (≈ 1.1 m)
  const HEAD_BLOAT = 0.35;         // the head grows this much (× its size)
  const LIFT_AT = 1.4;             // seconds after the hit the feet leave the ground
  const POP_AT = 10;               // seconds after the hit they burst…
  const ALTITUDE = 0.4;            // …this high (tiles, feet above the ground: ≈ 8 m)
  const OVER = 2;                  // the last seconds: over-inflated, trembling, flushing red
  const DRIFT = 0.012;             // tiles/s the wind takes a balloon along
  const POP_SPEED = 0.42;          // tiles/s the insides burst out with
  const GRAVITY = 3;               // tiles/s² for the falling pieces (a miniature: snappy reads better)
  const BOUNCE = 0.2;
  const SPIN = 10;                 // rad/s, how fast the pieces tumble
  const SPRAY = 16;                // blood drops per direction at the pop (12 directions; × the blood setting)
  const RAIN_TIME = 1.6;           // seconds it rains blood under the spot
  const POOL = 0.09;               // tiles: the pool of blood under the spot grows to this radius
  const GORE_TIME = 25;            // seconds a heap lies…
  const GORE_FADE = 1.2;           // …then it shrinks away this fast
  const AVOID = 0.12;              // people keep this far (tiles) from a heap
  const MAX_BALLOONS = 10;
  const MAX_HEAPS = 14;
  const VOLUME = 0.32;
  const CAP_BOXES = MAX_BALLOONS * 10 + MAX_HEAPS * 60, CAP_SPHERES = MAX_BALLOONS * 2 + 4, CAP_HEMIS = MAX_BALLOONS * 2 + 4;
  const CAP_BLOBS = MAX_HEAPS * 110 + 20;
  // --------------------------------------------------------------

  const H_PERSON = 0.135;
  const rnd = (a, b) => a + Math.random() * (b - a);
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const smooth = (x) => { x = clamp01(x); return x * x * (3 - 2 * x); };
  const W = () => window.scWalk;
  const C = () => window.scCore;
  const RES = () => window.scResidents;
  const COPS = () => window.scCops;

  const SERUM = '#ff3fa4';         // the pink serum in the ampoules
  const ANY = { shirt: '#4f8fd8', trousers: '#2f4a7a', skin: '#eec4a2', hair: '#3d2a1c', bald: false };
  const COP_COLORS = { trousers: '#1f2a4a', shirt: '#3b5a9a', skin: '#e0b48f', hair: '#1f2a4a', bald: false };
  const FLUSH = '#d2405a';         // the stretched skin, just before it goes
  const HEX = {                    // the insides (the skinner's colours)
    organ: ['#8e0f14', '#a8171c', '#6e0b10', '#c0262a', '#7a1020'],
    lung: ['#b8464e', '#c25a60'],
    gut: ['#9c2a2a', '#b3383b', '#7e1d1d'],
    bone: ['#f1ead8', '#e2d8bf', '#fbf6e6'],
    socket: ['#2a1a14', '#3a2620'],
    blood: ['#5e0a0e', '#6e0b10', '#4c080b'],
  };

  // ---------- small 3D maths (3×3 row-major) ----------
  const mul = (A, B) => [
    A[0] * B[0] + A[1] * B[3] + A[2] * B[6], A[0] * B[1] + A[1] * B[4] + A[2] * B[7], A[0] * B[2] + A[1] * B[5] + A[2] * B[8],
    A[3] * B[0] + A[4] * B[3] + A[5] * B[6], A[3] * B[1] + A[4] * B[4] + A[5] * B[7], A[3] * B[2] + A[4] * B[5] + A[5] * B[8],
    A[6] * B[0] + A[7] * B[3] + A[8] * B[6], A[6] * B[1] + A[7] * B[4] + A[8] * B[7], A[6] * B[2] + A[7] * B[5] + A[8] * B[8]];
  const apply = (M, v) => [M[0] * v[0] + M[1] * v[1] + M[2] * v[2], M[3] * v[0] + M[4] * v[1] + M[5] * v[2], M[6] * v[0] + M[7] * v[1] + M[8] * v[2]];
  const rotY = (a) => { const c = Math.cos(a), s = Math.sin(a); return [c, 0, s, 0, 1, 0, -s, 0, c]; };
  const rotX = (a) => { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, c, -s, 0, s, c]; };
  const rotZ = (a) => { const c = Math.cos(a), s = Math.sin(a); return [c, -s, 0, s, c, 0, 0, 0, 1]; };
  const euler = (rx, ry, rz) => mul(mul(rotX(rx), rotY(ry)), rotZ(rz));
  // a basis whose local +z points along -d (the ampoule's tail behind its needle) and +y is as up as can be
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

  // ---------- geometry (unit shapes: size 1 across; instances scale them) ----------
  // Triangles are turned to face away from `inside(centroid)` (the materials are single-sided).
  function orient(P, out) {
    for (let i = 0; i < P.length; i += 9) {
      const ax = P[i + 3] - P[i], ay = P[i + 4] - P[i + 1], az = P[i + 5] - P[i + 2];
      const bx = P[i + 6] - P[i], by = P[i + 7] - P[i + 1], bz = P[i + 8] - P[i + 2];
      const n = [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
      const c = [(P[i] + P[i + 3] + P[i + 6]) / 3, (P[i + 1] + P[i + 4] + P[i + 7]) / 3, (P[i + 2] + P[i + 5] + P[i + 8]) / 3];
      const o = out(c);
      if (n[0] * o[0] + n[1] * o[1] + n[2] * o[2] < 0) for (let k = 0; k < 3; k++) { const t = P[i + 3 + k]; P[i + 3 + k] = P[i + 6 + k]; P[i + 6 + k] = t; }
    }
    return P;
  }
  function boxTris() {
    const v = [[-.5, -.5, -.5], [.5, -.5, -.5], [.5, .5, -.5], [-.5, .5, -.5], [-.5, -.5, .5], [.5, -.5, .5], [.5, .5, .5], [-.5, .5, .5]];
    const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [2, 3, 7], [2, 7, 6], [1, 2, 6], [1, 6, 5], [0, 4, 7], [0, 7, 3]];
    const P = [];
    for (const t of f) for (const k of t) P.push(...v[k]);
    return { P: orient(P, (c) => c) };
  }
  function blobTris() {  // icosahedron of radius 0.5 (flat shaded: lumpy flesh)
    const t = (1 + Math.sqrt(5)) / 2;
    const V = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]]
      .map((v) => { const l = Math.hypot(...v) * 2; return v.map((x) => x / l); });
    const F = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
    const P = [];
    for (const [a, b, c] of F) P.push(...V[a], ...V[b], ...V[c]);
    return { P: orient(P, (c) => c) };
  }
  // a smooth sphere of radius 0.5; half: only the upper half, closed with a flat disc underneath
  function sphereTris(half) {
    const nx = 20, ny = half ? 6 : 12, top = half ? Math.PI / 2 : Math.PI, P = [], N = [];
    const pt = (i, j) => { const th = (i / ny) * top, ph = (j / nx) * Math.PI * 2; return [Math.sin(th) * Math.cos(ph) * 0.5, Math.cos(th) * 0.5, Math.sin(th) * Math.sin(ph) * 0.5]; };
    const tri = (a, b, c) => { if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-6 || Math.hypot(a[0] - c[0], a[1] - c[1], a[2] - c[2]) < 1e-6 || Math.hypot(b[0] - c[0], b[1] - c[1], b[2] - c[2]) < 1e-6) return; P.push(...a, ...b, ...c); };
    for (let i = 0; i < ny; i++) for (let j = 0; j < nx; j++) { const a = pt(i, j), b = pt(i + 1, j), c = pt(i + 1, j + 1), d = pt(i, j + 1); tri(a, b, c); tri(a, c, d); }
    const curved = P.length;
    if (half) for (let j = 0; j < nx; j++) tri([0, 0, 0], pt(ny, j), pt(ny, j + 1));
    orient(P, (c) => (half && Math.abs(c[1]) < 1e-6 ? [0, -1, 0] : c));
    for (let i = 0; i < P.length; i += 3) {
      if (i >= curved) { N.push(0, -1, 0); continue; }
      const l = Math.hypot(P[i], P[i + 1], P[i + 2]) || 1;
      N.push(P[i] / l, P[i + 1] / l, P[i + 2] / l);
    }
    return { P, N };
  }
  // the ampoule, needle at the origin, along +z: [x, y, z, w, h, d, colour]
  const DART = [[0, 0, 0.007, 0.0012, 0.0012, 0.014, '#d9dde2'], [0, 0, 0.016, 0.004, 0.004, 0.005, '#9aa0a8'],
    [0, 0, 0.028, 0.0075, 0.0075, 0.02, SERUM], [0, 0, 0.0185, 0.0085, 0.0085, 0.003, '#dff6f8'], [0, 0, 0.0395, 0.0085, 0.0085, 0.003, '#dff6f8'],
    [0, 0, 0.045, 0.006, 0.006, 0.008, '#ffd1ec'], [0, 0, 0.05, 0.011, 0.002, 0.008, '#ff9ad5'], [0, 0, 0.05, 0.002, 0.011, 0.008, '#ff9ad5']];
  const DART_SCALE = 1.6;

  // ---------- the weapon ----------
  // In your hand: a stubby dart pistol with a glass magazine of pink ampoules on top and a gas
  // canister under the barrel.
  let heldDart = null;
  const def = {
    id: 'balloon', name: 'Ballonator', key: KEY, interval: INTERVAL, kick: 0.5,
    at: [0.13, -0.13, -0.3], aim: 1.05, roll: -0.04, muzzle: [0, 0.01, -0.3],
    build({ builder, mesh, colors }) {
      const { METAL, DARK, GRIP, SKIN, SLEEVE } = colors;
      const b = builder();
      b.box(0, 0.01, -0.14, 0.024, 0.024, 0.3, '#2fb7b0');               // barrel (toy teal)
      b.box(0, 0.01, -0.29, 0.032, 0.032, 0.02, METAL);                 // muzzle
      b.box(0, 0.034, -0.17, 0.02, 0.022, 0.09, '#a9d3d8');             // the glass magazine…
      for (let i = 0; i < 3; i++) b.box(0, 0.034, -0.2 + i * 0.028, 0.014, 0.016, 0.018, SERUM);   // …with ampoules
      b.box(0, 0.047, -0.17, 0.024, 0.005, 0.094, DARK);                // its lid
      b.box(0, -0.016, -0.17, 0.02, 0.02, 0.09, '#c9ccd2');             // gas canister
      b.box(0, -0.016, -0.218, 0.014, 0.014, 0.008, DARK);
      b.box(0, -0.035, 0.02, 0.028, 0.08, 0.035, GRIP, -0.3);           // grip
      b.box(0, -0.06, 0.02, 0.045, 0.05, 0.05, SKIN, -0.3);             // hand
      b.box(0.005, -0.1, 0.1, 0.06, 0.065, 0.16, SLEEVE, 0.45);         // sleeve
      const root = mesh(b);
      const bd = builder();                                              // the ampoule in the barrel, its tuft sticking out
      bd.box(0, 0.01, -0.305, 0.016, 0.004, 0.02, '#ff9ad5');
      bd.box(0, 0.01, -0.305, 0.004, 0.016, 0.02, '#ff9ad5');
      heldDart = mesh(bd);
      root.add(heldDart);
      return { root, flash: mesh(builder()) };                          // no muzzle flash: a puff of gas
    },
    fire({ o, d, start }) { shoot(o, d, start); },
  };
  (window.scWalkWeapons = window.scWalkWeapons || []).push(def);

  // ---------- pools ----------
  let K = null, scene = null, ready = false, dartGeo = null, dartMat = null;
  const pools = {};
  function noSnow(m) { m.defines = { ...(m.defines || {}), SNOW_COVER: '-0.50' }; return m; }
  function makePool(name, shape, cap, shadow) {
    const g = new K.Geometry();
    g.setAttribute('position', new K.Attr(new Float32Array(shape.P), 3));
    if (shape.N) g.setAttribute('normal', new K.Attr(new Float32Array(shape.N), 3)); else g.computeVertexNormals();
    const mesh = new K.Instanced(g, noSnow(new K.Lambert({ color: '#ffffff' })), cap);
    mesh.frustumCulled = false; mesh.count = 0; mesh.name = 'sc-balloon-' + name;
    mesh.castShadow = !!shadow; mesh.receiveShadow = true;
    const w = new K.Color('#ffffff');
    for (let i = 0; i < cap; i++) mesh.setColorAt(i, w);
    mesh.instanceMatrix.array.fill(0);
    scene.add(mesh);
    const free = [];
    for (let i = cap - 1; i >= 0; i--) free.push(i);
    return { mesh, free, hi: 0, dirty: false, m: mesh.instanceMatrix.array, colors: new Map(), tmp: new K.Color() };
  }
  // a slot (or -1 when the pool is full: that part is then left out)
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
  // a slot's colour between two hex colours (f 0…1)
  function tint(pool, i, a, b, f) {
    if (i < 0) return;
    let ca = pool.colors.get(a); if (!ca) pool.colors.set(a, (ca = new K.Color(a)));
    let cb = pool.colors.get(b); if (!cb) pool.colors.set(b, (cb = new K.Color(b)));
    pool.tmp.copy(ca).lerp(cb, f);
    pool.mesh.setColorAt(i, pool.tmp);
    pool.mesh.instanceColor.needsUpdate = true;
  }
  function ensure() {
    if (ready) return true;
    const c = C();
    K = c && c.classes && c.classes();
    if (!K || !K.Instanced || !K.Geometry || !K.Attr || !K.Color || !K.Lambert || !K.Mesh || !c.scene) return false;
    scene = c.scene;
    pools.box = makePool('box', boxTris(), CAP_BOXES, true);
    pools.sphere = makePool('sphere', sphereTris(false), CAP_SPHERES, true);
    pools.hemi = makePool('hemi', sphereTris(true), CAP_HEMIS, true);
    pools.blob = makePool('blob', blobTris(), CAP_BLOBS, false);
    // the ampoule: one geometry with vertex colours
    const box = boxTris().P, P = [], Co = [], col = new K.Color();
    for (const [x, y, z, w, h, d, hex] of DART) {
      col.set(hex);
      for (let i = 0; i < box.length; i += 3) { P.push((x + box[i] * w) * DART_SCALE, (y + box[i + 1] * h) * DART_SCALE, (z + box[i + 2] * d) * DART_SCALE); Co.push(col.r, col.g, col.b); }
    }
    dartGeo = new K.Geometry();
    dartGeo.setAttribute('position', new K.Attr(new Float32Array(P), 3));
    dartGeo.setAttribute('color', new K.Attr(new Float32Array(Co), 3));
    dartGeo.computeVertexNormals();
    dartMat = noSnow(new K.Lambert({ vertexColors: true }));
    ready = true;
    c.onFrame(step);
    hookTargets();
    return true;
  }
  function flush() {
    for (const p of Object.values(pools)) {
      if (!p.dirty) continue;
      p.dirty = false; p.mesh.count = p.hi; p.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  // ---------- shooting ----------
  const darts = [];
  let reloadAt = 0;
  function shoot(o, d) {
    if (!ensure()) return;
    const mesh = new K.Mesh(dartGeo, dartMat);
    mesh.frustumCulled = false; mesh.castShadow = true; mesh.matrixAutoUpdate = false;
    scene.add(mesh);
    const k = { p: [o.x + d.x * 0.05, o.y + d.y * 0.05 - 0.008, o.z + d.z * 0.05], v: [d.x * DART_SPEED, d.y * DART_SPEED, d.z * DART_SPEED], t: 0, mesh };
    darts.push(k);
    reloadAt = performance.now() + INTERVAL * 800;
    if (heldDart) heldDart.visible = false;
    pfft();
    drawDart(k, [d.x, d.y, d.z]);
  }
  function drawDart(k, dir) { writeM(k.mesh.matrix.elements, 0, shaftBasis(dir), k.p); k.mesh.matrixWorldNeedsUpdate = true; }
  function removeDart(k) { const i = darts.indexOf(k); if (i >= 0) darts.splice(i, 1); k.mesh.removeFromParent(); }

  // one step of a flying ampoule: the first person, floating balloon or solid thing on the way
  function stepDart(k, dt) {
    const w = W();
    k.t += dt;
    k.v[1] -= DART_DROP * dt;
    const sp = Math.hypot(...k.v), L = sp * dt, dir = [k.v[0] / sp, k.v[1] / sp, k.v[2] / sp];
    const o = { x: k.p[0], y: k.p[1], z: k.p[2] }, dd = { x: dir[0], y: dir[1], z: dir[2] };
    let stop = null;
    const consider = (t, what) => { if (t !== null && t >= 0 && t <= L && (!stop || t < stop.t)) stop = { t, ...what }; };
    if (w) {
      const wall = w.rayBuildings && w.rayBuildings(o, dd, L); if (wall) consider(wall.t, { kind: 'solid' });
      const car = w.hitCar && w.hitCar(o, dd, L); if (car) consider(car.t, { kind: 'solid' });
      const prop = w.hitProp && w.hitProp(o, dd, L); if (prop) consider(prop.t, { kind: 'solid' });
    }
    if (dir[1] < 0 && k.p[1] + dir[1] * L < 0.038) consider((k.p[1] - 0.038) / -dir[1], { kind: 'solid' });
    const bh = hitBalloon(o, dd, stop ? stop.t : L); if (bh) consider(bh.t, { kind: 'balloon', b: bh.b });
    const ph = hitPerson(k.p, dir, stop ? stop.t : L); if (ph) consider(ph.t, { kind: 'person', ...ph });
    if (stop) {
      for (let a = 0; a < 3; a++) k.p[a] += dir[a] * stop.t;
      removeDart(k);
      if (stop.kind === 'person') infect(stop, dir);
      else if (stop.kind === 'balloon') pop(stop.b);
      else shatter(k.p, dir);
      return;
    }
    for (let a = 0; a < 3; a++) k.p[a] += dir[a] * L;
    drawDart(k, dir);
    if (k.t > MAX_FLIGHT) removeDart(k);
  }

  // the nearest resident or officer whose body the segment crosses: { t, res } or { t, cop }
  function hitPerson(p, dir, maxT) {
    const res = RES(), hh = dir[0] * dir[0] + dir[2] * dir[2];
    if (hh < 1e-6) return null;
    let best = null;
    const test = (x, z, r, y, H) => {   // closest approach of the line to the body's axis, then the height there
      const u = ((x - p[0]) * dir[0] + (z - p[2]) * dir[2]) / hh;
      if (u < 0 || u > maxT || (best && u >= best.t)) return -1;
      if (Math.hypot(p[0] + dir[0] * u - x, p[2] + dir[2] * u - z) > r) return -1;
      const py = p[1] + dir[1] * u;
      return py >= y && py <= y + H ? u : -1;
    };
    if (res && res.people) {
      const x1 = p[0] + dir[0] * maxT, z1 = p[2] + dir[2] * maxT;
      const bx0 = Math.min(p[0], x1) - 0.05, bx1 = Math.max(p[0], x1) + 0.05, bz0 = Math.min(p[2], z1) - 0.05, bz1 = Math.max(p[2], z1) + 0.05;
      for (const q of res.people) {
        if (!q || q.x < bx0 || q.x > bx1 || q.z < bz0 || q.z > bz1) continue;
        if (q.state === 'inside' || q.state === 'gone' || q.state === 'down') continue;
        const u = test(q.x, q.z, HIT_R * (q.k ? 0.8 : 1), 0.03, H_PERSON * (q.k ? 0.8 : 1) + 0.01);
        if (u >= 0) best = { t: u, res: q };
      }
    }
    const cops = COPS() && typeof COPS().officers === 'function' ? COPS().officers() : [];
    cops.forEach((c, i) => {
      if (!c || (c.state !== 'exit' && c.state !== 'fight') || c.pinned) return;
      const u = test(c.x, c.z, HIT_R, 0.034, H_PERSON + 0.01);
      if (u >= 0) best = { t: u, cop: i };
    });
    return best;
  }

  // the ampoule hits someone: they're ours from now on
  function infect(h, dir) {
    let info = null;
    try { info = h.res ? RES().skin(h.res, 'balloon') : COPS().skin(h.cop, 'balloon'); } catch (e) { console.warn('[balloon] take', e); }
    if (!info) return;
    jab();
    const res = RES();
    if (res && res.spatter) res.spatter(info.x, (info.y || 0.036) + 0.07, info.z, dir[0], dir[2], 2, 0.25, 0.2);
    startBalloon(info);
  }
  function shatter(p, dir) {
    const w = W();
    if (w && w.spawn) {
      for (let n = 0; n < 6; n++) w.spawn('spark', p[0], Math.max(0.04, p[1]), p[2], { color: n < 3 ? SERUM : '#dff6f8', vx: -dir[0] * rnd(0.1, 0.4) + rnd(-0.2, 0.2), vy: rnd(0.1, 0.4), vz: -dir[2] * rnd(0.1, 0.4) + rnd(-0.2, 0.2), g: 3, size: 0.003, life: 0.45 });
      if (w.startEffects) w.startEffects();
    }
    tinkle();
  }

  // ---------- balloons ----------
  const balloons = [];
  function startBalloon(info) {
    while (balloons.length >= MAX_BALLOONS) pop(balloons[0]);
    const sc = (info.h || H_PERSON) / H_PERSON;
    const col = info.colors || (info.cop ? COP_COLORS : ANY);
    const wind = rnd(0, Math.PI * 2);
    const b = { x: info.x, z: info.z, y0: info.y || 0.036, sc, th: typeof info.th === 'number' ? info.th : rnd(0, 6), col, t: 0,
      spin: rnd(-0.5, 0.5), ph: rnd(0, 6), wx: Math.cos(wind) * DRIFT * rnd(0.5, 1), wz: Math.sin(wind) * DRIFT * rnd(0.5, 1), creakAt: 0, pos: null, R: R_START * sc, voice: null };
    const box = (hex) => take(pools.box, hex);
    b.s = {
      legL: box(col.trousers), legR: box(col.trousers), torso: box(col.shirt), head: box(col.skin),
      hair: col.bald ? -1 : box(col.hair), eyeL: box('#1d1512'), eyeR: box('#1d1512'), mouth: box('#5a1418'),
      top: take(pools.hemi, col.shirt), bot: take(pools.hemi, col.trousers), belly: take(pools.sphere, col.skin), cheeks: take(pools.sphere, col.skin),
    };
    balloons.push(b);
    b.voice = squeal(b);
    hiss(b);
    drawBalloon(b, 0);
  }
  function freeBalloon(b) {
    const i = balloons.indexOf(b); if (i >= 0) balloons.splice(i, 1);
    for (const [k, slot] of Object.entries(b.s)) give(k === 'top' || k === 'bot' ? pools.hemi : k === 'belly' || k === 'cheeks' ? pools.sphere : pools.box, slot);
    b.s = {};
  }

  // the shape at time t: where the sphere is, how big, how far over the limit
  function shape(b) {
    const t = b.t, inf = smooth((t - 0.15) / INFLATE);
    const over = clamp01((t - (POP_AT - OVER)) / OVER);
    const jig = 1 + 0.07 * Math.sin(t * 15) * Math.exp(-Math.max(0, t - 0.15) * 1.2) * inf;   // the rubber settles
    const R = (R_START + (R_FULL - R_START) * inf) * b.sc * (1 + 0.24 * over * over);
    const lift = clamp01((t - LIFT_AT) / (POP_AT - LIFT_AT)), alt = ALTITUDE * Math.pow(lift, 1.6);
    const leg = 0.048 * b.sc * (1 - 0.3 * inf);
    return { inf, over, jig, R, lift, alt, leg, cy: b.y0 + alt + leg + R * 0.8 };
  }
  function drawBalloon(b, dt) {
    const s = shape(b), sc = b.sc, R = s.R, t = b.t;
    b.R = R;
    // turning slowly, swinging under the sphere once it's off the ground, trembling at the end
    if (s.lift > 0) b.th += b.spin * dt * s.lift;
    const sw = s.lift > 0 ? Math.min(1, s.lift * 6) : 0;
    const shake = s.over * s.over * 0.08;
    const M = mul(rotY(b.th), mul(rotX(0.14 * sw * Math.sin(t * 1.9 + b.ph) + shake * Math.sin(t * 53)), rotZ(0.1 * sw * Math.sin(t * 1.4 + b.ph * 2) + shake * Math.sin(t * 47))));
    const c = [b.x, s.cy, b.z];
    b.pos = c;
    const at = (v) => { const w = apply(M, v); return [c[0] + w[0], c[1] + w[1], c[2] + w[2]]; };
    const S = pools;
    // the sphere: shirt over the top, trousers under it, bare belly where the shirt rides up
    const gap = R * 0.08 * s.inf, d2 = 2 * R, sq = s.jig;
    put(S.hemi, b.s.top, M, at([0, gap, 0]), d2 / Math.sqrt(sq), d2 * sq, d2 / Math.sqrt(sq));
    put(S.hemi, b.s.bot, mul(M, rotX(Math.PI)), at([0, -gap, 0]), d2 / Math.sqrt(sq), d2 * sq, d2 / Math.sqrt(sq));
    put(S.sphere, b.s.belly, M, c, d2 * 0.975 / Math.sqrt(sq), d2 * 0.975 * sq, d2 * 0.975 / Math.sqrt(sq));
    // the old torso disappears inside the sphere
    const tk = Math.max(0, 1 - s.inf * 1.8);
    put(S.box, b.s.torso, M, at([0, -0.002 * sc, 0]), 0.036 * sc * tk, 0.054 * sc * tk, 0.024 * sc * tk);
    // stubby legs that kick (harder in the air), hanging from under the sphere
    const kick = (s.lift > 0 ? 0.55 : 0.2) * (1 - 0.6 * s.over) * Math.min(1, t * 2);
    for (const side of [-1, 1]) {
      const a = kick * Math.sin(t * 8.5 + (side > 0 ? Math.PI : 0) + b.ph), L = mul(M, rotX(a));
      const hip = [side * 0.0075 * sc * (1 + 0.7 * s.inf), -R * 0.8, 0], hipW = at(hip), off = apply(L, [0, -s.leg / 2, 0]);
      put(S.box, side < 0 ? b.s.legL : b.s.legR, L, [hipW[0] + off[0], hipW[1] + off[1], hipW[2] + off[2]], 0.014 * sc * (1 + 0.6 * s.inf), s.leg, 0.018 * sc * (1 + 0.5 * s.inf));
    }
    // the head on top: a box with round cheeks, puffed up; eyes bulge at the end, mouth an "O"
    const hb = 1 + HEAD_BLOAT * s.inf + 0.12 * s.over, hs = 0.022 * sc * hb, hy = R * 0.9 + hs * 0.5;
    put(S.box, b.s.head, M, at([0, hy, 0]), hs, hs, hs);
    const cheek = hs * (1 + 0.32 * s.inf);
    put(S.sphere, b.s.cheeks, M, at([0, hy - hs * 0.06, 0]), cheek, cheek * 0.95, cheek);
    if (b.s.hair >= 0) put(S.box, b.s.hair, M, at([0, hy + hs * 0.5 + 0.0028 * sc * hb, -0.001 * sc]), 0.024 * sc * hb, 0.0065 * sc * hb, 0.024 * sc * hb);
    const front = Math.max(hs * 0.5, cheek * 0.5) + 0.0005, eye = 0.0032 * sc * (1 + 0.6 * s.over);
    put(S.box, b.s.eyeL, M, at([-0.0045 * sc * hb, hy + hs * 0.1, front]), eye, eye, 0.0015);
    put(S.box, b.s.eyeR, M, at([0.0045 * sc * hb, hy + hs * 0.1, front]), eye, eye, 0.0015);
    const mo = 0.0035 * sc * (1 + 0.5 * s.inf + 0.4 * Math.abs(Math.sin(t * 6)));
    put(S.box, b.s.mouth, M, at([0, hy - hs * 0.25, front]), mo, mo * 1.2, 0.0015);
    // flushing red as it stretches
    if (s.over > 0) {
      const f = s.over * s.over;
      tint(S.sphere, b.s.belly, b.col.skin, FLUSH, f);
      tint(S.sphere, b.s.cheeks, b.col.skin, FLUSH, f * 0.8);
      tint(S.box, b.s.head, b.col.skin, FLUSH, f * 0.8);
    }
  }
  function stepBalloon(b, dt) {
    b.t += dt;
    const s = shape(b);
    if (s.lift > 0) { const w = W(); const nx = b.x + b.wx * dt * s.lift, nz = b.z + b.wz * dt * s.lift; if (!(w && w.blocked && s.alt < 0.05 && w.blocked(nx, nz))) { b.x = nx; b.z = nz; } }
    if (s.over > 0 && (b.creakAt -= dt) <= 0) { b.creakAt = rnd(0.25, 0.6) * (1.2 - s.over); creak(b); }
    if (b.t >= POP_AT) { pop(b); return; }
    drawBalloon(b, dt);
  }

  // shooting a balloon (walk mode's bullets, rockets, …) pops it early
  function hitBalloon(o, d, maxT) {
    let best = null;
    for (const b of balloons) {
      if (!b.pos) continue;
      const c = b.pos, r = b.R * 1.05, ex = o.x - c[0], ey = o.y - c[1], ez = o.z - c[2];
      const bb = ex * d.x + ey * d.y + ez * d.z, cc = ex * ex + ey * ey + ez * ez - r * r, disc = bb * bb - cc;
      if (disc < 0) continue;
      const t = -bb - Math.sqrt(disc);
      if (t > 0 && t < maxT && (!best || t < best.t)) best = { t, b };
    }
    return best;
  }
  let targetsHooked = false;
  function hookTargets() {
    const w = W();
    if (targetsHooked || !w || typeof w.addTarget !== 'function') return;
    targetsHooked = true;
    w.addTarget({ hit: (o, d, maxT) => hitBalloon(o, d, maxT), onHit: (h) => { if (h && h.b && balloons.includes(h.b)) pop(h.b); } });
  }
  // an explosion nearby pops them too
  window.addEventListener('sc:blast', (e) => {
    const d = e.detail || {}, r = Math.max(d.knock || 0, d.gib || 0, 0.15);
    for (const b of balloons.slice()) if (b.pos && Math.hypot(b.pos[0] - d.x, b.pos[2] - d.z) < r + b.R) pop(b);
  });

  // ---------- the pop ----------
  // The insides: the skinner's set, in person-local units (x, y up from the floor, z front):
  // [pool, colour list, colour index, x, y, z, sx, sy, sz, rx, ry, rz] (full sizes).
  const INSIDE = [
    ['blob', 'bone', 1, 0, 0.117, 0, 0.017, 0.016, 0.017],                  // cranium
    ['blob', 'socket', 0, -0.0045, 0.115, 0.0075, 0.0045, 0.0045, 0.003],   // eye sockets
    ['blob', 'socket', 1, 0.0045, 0.115, 0.0075, 0.0045, 0.0045, 0.003],
    ['box', 'bone', 0, 0, 0.106, 0.004, 0.013, 0.003, 0.008],               // jaw
    ['box', 'bone', 1, -0.004, 0.1085, 0.0085, 0.0015, 0.003, 0.0015],      // teeth
    ['box', 'bone', 2, -0.002, 0.1085, 0.0085, 0.0015, 0.003, 0.0015],
    ['box', 'bone', 0, 0, 0.1085, 0.0085, 0.0015, 0.003, 0.0015],
    ['box', 'bone', 1, 0.002, 0.1085, 0.0085, 0.0015, 0.003, 0.0015],
    ['box', 'bone', 2, 0.004, 0.1085, 0.0085, 0.0015, 0.003, 0.0015],
    ['blob', 'organ', 0, -0.003, 0.08, 0.004, 0.009, 0.011, 0.008],         // heart
    ['blob', 'lung', 0, -0.007, 0.082, -0.001, 0.007, 0.02, 0.01],          // lungs
    ['blob', 'lung', 1, 0.007, 0.082, -0.001, 0.007, 0.02, 0.01],
    ['blob', 'organ', 1, 0.006, 0.066, 0.002, 0.012, 0.006, 0.01],          // liver
    ['blob', 'gut', 0, -0.006, 0.064, 0.003, 0.007, 0.007, 0.007],          // stomach
    ['box', 'bone', 0, 0, 0.075, -0.007, 0.003, 0.05, 0.003],               // spine
    ['box', 'bone', 1, 0, 0.06, 0.007, 0.024, 0.002, 0.002, 0, 0, 0.12],    // ribs
    ['box', 'bone', 2, 0, 0.07, 0.007, 0.024, 0.002, 0.002, 0, 0, -0.12],
    ['box', 'bone', 0, 0, 0.08, 0.007, 0.024, 0.002, 0.002, 0, 0, 0.12],
    ['box', 'bone', 1, 0, 0.09, 0.007, 0.024, 0.002, 0.002, 0, 0, -0.12],
    ['box', 'bone', 2, 0, 0.06, -0.007, 0.024, 0.002, 0.002, 0, 0, -0.12],
    ['box', 'bone', 0, 0, 0.07, -0.007, 0.024, 0.002, 0.002, 0, 0, 0.12],
    ['box', 'bone', 1, 0, 0.08, -0.007, 0.024, 0.002, 0.002, 0, 0, -0.12],
    ['box', 'bone', 2, 0, 0.09, -0.007, 0.024, 0.002, 0.002, 0, 0, 0.12],
    ['box', 'gut', 0, -0.005, 0.055, 0.005, 0.014, 0.004, 0.004, 0, 0.4, 0],   // intestines
    ['box', 'gut', 1, 0.005, 0.052, 0.006, 0.013, 0.004, 0.004, 0, -0.5, 0],
    ['box', 'gut', 2, 0, 0.06, 0.004, 0.012, 0.004, 0.004, 0, 0.1, 0],
    ['box', 'gut', 0, -0.003, 0.05, 0.002, 0.012, 0.004, 0.004, 0, 0.9, 0],
    ['box', 'gut', 1, 0.004, 0.058, 0.002, 0.012, 0.004, 0.004, 0, 0, 0.4],
    ['blob', 'organ', 3, -0.007, 0.03, 0.003, 0.008, 0.024, 0.008],        // muscle of the legs
    ['blob', 'organ', 4, 0.007, 0.03, 0.003, 0.008, 0.024, 0.008],
    ['box', 'bone', 0, -0.006, 0.024, 0, 0.005, 0.04, 0.005],               // thigh bones
    ['box', 'bone', 1, 0.006, 0.024, 0, 0.005, 0.04, 0.005],
    ['box', 'bone', 2, -0.006, 0.015, 0.002, 0.004, 0.026, 0.004],          // shin bones
    ['box', 'bone', 0, 0.006, 0.015, 0.002, 0.004, 0.026, 0.004],
  ];
  const FLESH = ['organ', 'organ', 'organ', 'gut', 'lung'];
  // the red mass that filled the body (the skinner's flesh, fewer and a bit bigger lumps)
  function flesh() {
    const out = [];
    for (let n = 0; n < 40; n++) {
      const d = rnd(0.008, 0.013);
      out.push(['blob', FLESH[(Math.random() * FLESH.length) | 0], (Math.random() * 5) | 0, rnd(-0.014, 0.014), rnd(0.01, 0.1), rnd(-0.009, 0.009), d * rnd(0.8, 1.2), d * rnd(0.7, 1.2), d * rnd(0.8, 1.2), rnd(0, 3), rnd(0, 3), 0]);
    }
    return out;
  }

  const heaps = [];
  function pop(b) {
    if (!balloons.includes(b)) return;
    if (!b.pos) drawBalloon(b, 0);
    const c = b.pos.slice(), R = b.R, sc = b.sc, floor = b.y0, col = b.col;
    freeBalloon(b);
    stopVoice(b);
    while (heaps.length >= MAX_HEAPS) removeHeap(heaps[0]);
    const h = { x: c[0], z: c[2], floor, t: 0, parts: [], splats: 0, pool: take(pools.blob, HEX.blood[0]), rain: RAIN_TIME, c, fade: 1, sc };
    heaps.push(h);
    const add = (pool, hex, p, v, size, rot, kind) => {
      const slot = take(pools[pool], hex);
      if (slot < 0) return;
      h.parts.push({ pool, slot, x: p[0], y: p[1], z: p[2], vx: v[0], vy: v[1], vz: v[2], rx: rot[0], ry: rot[1], rz: rot[2],
        wx: rnd(-SPIN, SPIN), wy: rnd(-SPIN, SPIN), wz: rnd(-SPIN, SPIN), sx: size[0], sy: size[1], sz: size[2], kind,
        r: kind === 'rag' ? Math.min(...size) / 2 : Math.max(...size) / 2, settled: false, landed: false });
    };
    const out = (dx, dy, dz, speed) => { const l = Math.hypot(dx, dy, dz) || 1; return [dx / l * speed + rnd(-0.05, 0.05), dy / l * speed + rnd(0.05, 0.25), dz / l * speed + rnd(-0.05, 0.05)]; };
    // the insides, spread out through the sphere, burst outward
    const spread = R / (0.03 * sc);
    for (const [pool, cl, ci, lx, ly, lz, sx, sy, sz, rx = 0, ry = 0, rz = 0] of flesh().concat(INSIDE)) {
      const ox = lx * sc * spread * 0.8, oy = (ly - 0.07) * sc * spread * 0.5, oz = lz * sc * spread * 1.6;
      const p = [c[0] + ox, c[1] + oy, c[2] + oz];
      add(pool, HEX[cl][ci % HEX[cl].length], p, out(ox || rnd(-1, 1), oy, oz || rnd(-1, 1), POP_SPEED * rnd(0.35, 1)), [sx * sc, sy * sc, sz * sc], [rx, ry + b.th, rz], 'meat');
    }
    // rags of the stretched shirt, trousers and skin (thin), fluttering down after them
    const rag = (hex, n, top) => {
      for (let k = 0; k < n; k++) {
        const a = rnd(0, Math.PI * 2), e = top ? rnd(0.1, 1.2) : rnd(-1.2, -0.1), dx = Math.cos(a) * Math.cos(e), dz = Math.sin(a) * Math.cos(e), dy = Math.sin(e);
        const w = rnd(0.012, 0.024) * sc;
        add('box', hex, [c[0] + dx * R, c[1] + dy * R, c[2] + dz * R], out(dx, dy, dz, POP_SPEED * rnd(0.8, 1.5)), [w, w * rnd(0.6, 1), 0.0018 * sc], [rnd(0, 6), rnd(0, 6), rnd(0, 6)], 'rag');
      }
    };
    rag(col.shirt, 8, true); rag(col.trousers, 6, false); rag(col.skin, 6, Math.random() < 0.5);
    if (!col.bald) rag(col.hair, 2, true);
    // the legs drop as they are
    for (const side of [-1, 1]) add('box', col.trousers, [c[0] + side * 0.012 * sc, c[1] - R * 0.9, c[2]], [side * rnd(0.05, 0.15), rnd(0, 0.1), rnd(-0.08, 0.08)], [0.014 * sc * 1.4, 0.034 * sc, 0.018 * sc * 1.4], [0, b.th, 0], 'meat');
    // blood every way, a red mist
    const res = RES();
    if (res && res.spatter) for (let k = 0; k < 12; k++) { const a = (k / 12) * Math.PI * 2 + rnd(-0.2, 0.2); res.spatter(c[0], c[1], c[2], Math.cos(a), Math.sin(a), SPRAY, 1.2, 0.6); }
    const core = C();
    if (core && core.smoke) for (let k = 0; k < 12; k++) core.smoke('dust', c[0] + rnd(-R, R) * 0.5, c[1] + rnd(-R, R) * 0.5, c[2] + rnd(-R, R) * 0.5, { color: k % 3 ? '#9a1418' : '#c23a3e', vx: rnd(-0.35, 0.35), vy: rnd(-0.1, 0.25), vz: rnd(-0.35, 0.35), size: rnd(0.018, 0.032) * sc, grow: 3, life: rnd(1, 1.8), rise: -0.02, drag: 2.5, alpha: 0.7 });
    if (res && res.avoid) res.avoid(h.x, h.z, AVOID, GORE_TIME + GORE_FADE + 2);
    if (res && res.alarm) res.alarm(h.x, h.z, 0.6, 6);
    bang(h);
  }
  function removeHeap(h) {
    const i = heaps.indexOf(h); if (i >= 0) heaps.splice(i, 1);
    for (const p of h.parts) give(pools[p.pool], p.slot);
    give(pools.blob, h.pool);
    h.parts = [];
  }
  function stepHeap(h, dt) {
    h.t += dt;
    const res = RES();
    // it rains blood for a moment under the spot
    if (h.rain > 0 && res && res.spatter) {
      h.rain -= dt;
      const k = h.rain / RAIN_TIME;
      res.spatter(h.c[0] + rnd(-0.05, 0.05) * h.sc, h.c[1] - rnd(0, 0.03), h.c[2] + rnd(-0.05, 0.05) * h.sc, rnd(-1, 1), rnd(-1, 1), 1 + 3 * k, 0.15, 0);
    }
    if (h.t > GORE_TIME) { h.fade = Math.max(0, 1 - (h.t - GORE_TIME) / GORE_FADE); if (h.fade <= 0) { removeHeap(h); return; } }
    const f = h.fade;
    for (const p of h.parts) {
      if (!p.settled) {
        const rag = p.kind === 'rag';
        p.vy -= GRAVITY * (rag ? 0.45 : 1) * dt;
        if (rag) {                                                   // air drag: they flutter down
          const g = Math.exp(-(p.landed ? 8 : 2.6) * dt);
          p.vx *= g; p.vz *= g; if (p.vy < -0.22) p.vy = -0.22;
          p.vx += Math.sin(h.t * 3 + p.slot) * 0.15 * dt; p.vz += Math.cos(h.t * 2.6 + p.slot) * 0.15 * dt;
        }
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
        p.rx += p.wx * dt; p.ry += p.wy * dt; p.rz += p.wz * dt;
        // falling meat drips
        if (!rag && !p.landed && res && res.spatter && Math.random() < 0.06) res.spatter(p.x, p.y, p.z, 0, 0, 0.5, 0.05, 0);
        const fl = h.floor + p.r;
        if (p.y <= fl) {
          p.y = fl;
          if (!p.landed) { p.landed = true; landed(h, p); }
          if (p.vy < 0) p.vy = -p.vy * (rag ? 0 : BOUNCE);
          if (p.vy < 0.03) p.vy = 0;
          const g = Math.exp(-9 * dt);
          p.vx *= g; p.vz *= g; p.wx *= g; p.wy *= g; p.wz *= g;
          if (p.vy === 0 && Math.hypot(p.vx, p.vz) < 0.004 && Math.abs(p.wx) + Math.abs(p.wy) + Math.abs(p.wz) < 0.3) { p.settled = true; if (rag) { p.rx = 0; p.rz = 0; } }
        }
        put(pools[p.pool], p.slot, rag && p.settled ? rotY(p.ry) : euler(p.rx, p.ry, p.rz), [p.x, p.y, p.z], p.sx * f, rag && p.settled ? p.sz * f : p.sy * f, rag && p.settled ? p.sy * f : p.sz * f);
      } else if (f < 1) {
        const rag = p.kind === 'rag';
        put(pools[p.pool], p.slot, rag ? rotY(p.ry) : euler(p.rx, p.ry, p.rz), [p.x, p.y, p.z], p.sx * f, (rag ? p.sz : p.sy) * f, (rag ? p.sy : p.sz) * f);
      }
    }
    // the pool under the spot grows (once the first of it has come down)
    const pr = POOL * h.sc * smooth((h.t - 0.5) / 4) * f;
    put(pools.blob, h.pool, rotY(h.x * 7), [h.x, h.floor + 0.0012, h.z], pr * 2, 0.0025, pr * 1.7);
  }
  // a piece hits the ground: a splat of blood there, a wet sound
  function landed(h, p) {
    if (p.kind === 'rag') return;
    const res = RES();
    if (res && res.spatter) res.spatter(p.x, h.floor + 0.004, p.z, rnd(-1, 1), rnd(-1, 1), 2, 0.2, 0.15);
    if (h.splats < 24) {
      const s = take(pools.blob, HEX.blood[(Math.random() * 3) | 0]);
      if (s >= 0) {
        h.splats++;
        const r = Math.max(p.sx, p.sz) * rnd(1.3, 2.2);
        put(pools.blob, s, rotY(rnd(0, 6)), [p.x, h.floor + 0.001, p.z], r * rnd(1, 1.6), 0.002, r);
        h.parts.push({ pool: 'blob', slot: s, x: p.x, y: h.floor + 0.001, z: p.z, rx: 0, ry: rnd(0, 6), rz: 0, sx: r * 1.3, sy: 0.002, sz: r, kind: 'splat', settled: true });
      }
    }
    splat(h);
  }

  function step(dt) {
    dt = Math.min(dt || 0, 0.05);
    if (!ready) return;
    if (heldDart && !heldDart.visible && performance.now() > reloadAt) heldDart.visible = true;
    for (const k of darts.slice()) stepDart(k, dt);
    for (const b of balloons.slice()) stepBalloon(b, dt);
    for (const h of heaps.slice()) stepHeap(h, dt);
    flush();
  }

  // ---------- sounds (through the core's output: follows the sound button) ----------
  function audio() { const c = C(); return c && c.audio && c.out ? c : null; }
  // how loud something at (x, z) is where you stand (k: how fast it falls off)
  function near(x, z, k = 0.5) {
    const w = W();
    if (!w || !w.walking || !w.player) return 0.35;
    const d = Math.hypot(x - w.player.x, z - w.player.z);
    return 1 / (1 + d * d * k);
  }
  let noiseBuf = null;
  function noise(a) {
    if (!noiseBuf || noiseBuf.sampleRate !== a.sampleRate) {
      noiseBuf = a.createBuffer(1, a.sampleRate * 2, a.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const s = a.createBufferSource(); s.buffer = noiseBuf; s.loop = true; return s;
  }
  function play(fn) { const c = audio(); if (!c) return null; try { const a = c.audio(); return fn(a, a.currentTime, c.out(a)); } catch (e) { return null; } }
  function env(a, t, peak, len) { const g = a.createGain(); g.gain.setValueAtTime(peak, t); g.gain.exponentialRampToValueAtTime(0.0001, t + len); return g; }
  function pfft() {     // the dart gun: a puff of gas
    play((a, t, out) => {
      const n = noise(a), f = a.createBiquadFilter(), g = env(a, t, VOLUME * 1.1, 0.14);
      f.type = 'bandpass'; f.frequency.setValueAtTime(2500, t); f.frequency.exponentialRampToValueAtTime(700, t + 0.12); f.Q.value = 1.2;
      n.connect(f); f.connect(g); g.connect(out); n.start(t); n.stop(t + 0.15);
    });
  }
  function tinkle() {   // a shattering ampoule
    play((a, t, out) => {
      for (let k = 0; k < 4; k++) {
        const o = a.createOscillator(), g = env(a, t + k * 0.03, VOLUME * 0.18, 0.12);
        o.type = 'sine'; o.frequency.value = rnd(3200, 6200); o.connect(g); g.connect(out); o.start(t + k * 0.03); o.stop(t + k * 0.03 + 0.13);
      }
    });
  }
  function jab() {      // the needle goes in: a little crack of glass and a squirt
    tinkle();
    play((a, t, out) => {
      const n = noise(a), f = a.createBiquadFilter(), g = env(a, t, VOLUME * 0.6, 0.18);
      f.type = 'lowpass'; f.frequency.setValueAtTime(1800, t); f.frequency.exponentialRampToValueAtTime(300, t + 0.16);
      n.connect(f); f.connect(g); g.connect(out); n.start(t); n.stop(t + 0.19);
    });
  }
  function hiss(b) {    // the serum works: a rising hiss while they swell
    const v = near(b.x, b.z);
    if (v < 0.02) return;
    play((a, t, out) => {
      const n = noise(a), f = a.createBiquadFilter(), g = a.createGain();
      f.type = 'bandpass'; f.Q.value = 2; f.frequency.setValueAtTime(600, t); f.frequency.exponentialRampToValueAtTime(3500, t + INFLATE);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(VOLUME * 0.35 * v, t + 0.3); g.gain.exponentialRampToValueAtTime(0.0001, t + INFLATE + 0.3);
      n.connect(f); f.connect(g); g.connect(out); n.start(t); n.stop(t + INFLATE + 0.35);
    });
  }
  // a squeaky, muffled wail that climbs as they swell and float up (stopped when they burst)
  function squeal(b) {
    const v = near(b.x, b.z, 0.3);
    if (v < 0.02) return null;
    return play((a, t, out) => {
      const o = a.createOscillator(), lfo = a.createOscillator(), lg = a.createGain(), f = a.createBiquadFilter(), g = a.createGain();
      const f0 = Math.random() < 0.5 ? rnd(380, 520) : rnd(240, 330);
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f0 * 2.2, t + POP_AT - OVER); o.frequency.exponentialRampToValueAtTime(f0 * 3.2, t + POP_AT);
      lfo.frequency.value = rnd(5, 7); lg.gain.value = f0 * 0.06; lfo.connect(lg); lg.connect(o.frequency);
      f.type = 'lowpass'; f.frequency.value = 1400; f.Q.value = 4;
      g.gain.setValueAtTime(0.0001, t);
      // in bursts: breath, wail, breath…
      for (let s = 0.2; s < POP_AT; s += rnd(0.9, 1.6)) {
        const len = rnd(0.5, 0.9);
        g.gain.setTargetAtTime(VOLUME * 0.28 * v, t + s, 0.05);
        g.gain.setTargetAtTime(0.0001, t + s + len, 0.08);
      }
      o.connect(f); f.connect(g); g.connect(out);
      o.start(t); lfo.start(t); o.stop(t + POP_AT + 0.2); lfo.stop(t + POP_AT + 0.2);
      return { a, g, o, lfo };
    });
  }
  function stopVoice(b) {
    const v = b.voice; b.voice = null;
    if (!v) return;
    try { const t = v.a.currentTime; v.g.gain.cancelScheduledValues(t); v.g.gain.setTargetAtTime(0.0001, t, 0.01); v.o.stop(t + 0.1); v.lfo.stop(t + 0.1); } catch (e) { /* stopped already */ }
  }
  function creak(b) {   // stretched rubber
    const v = near(b.x, b.z, 0.3);
    if (v < 0.02) return;
    play((a, t, out) => {
      const o = a.createOscillator(), f = a.createBiquadFilter(), g = env(a, t, VOLUME * 0.3 * v, 0.22);
      o.type = 'sawtooth'; const f0 = rnd(90, 180); o.frequency.setValueAtTime(f0, t); o.frequency.linearRampToValueAtTime(f0 * rnd(1.4, 2.2), t + 0.2);
      f.type = 'bandpass'; f.frequency.value = rnd(900, 1600); f.Q.value = 8;
      o.connect(f); f.connect(g); g.connect(out); o.start(t); o.stop(t + 0.23);
    });
  }
  function bang(h) {    // the pop: a sharp bang and a wet burst
    const v = Math.max(0.15, near(h.x, h.z, 0.08));
    play((a, t, out) => {
      const n = noise(a), f = a.createBiquadFilter(), g = env(a, t, VOLUME * 2.2 * v, 0.35);
      f.type = 'lowpass'; f.frequency.setValueAtTime(6000, t); f.frequency.exponentialRampToValueAtTime(400, t + 0.3);
      n.connect(f); f.connect(g); g.connect(out); n.start(t); n.stop(t + 0.36);
      const o = a.createOscillator(), og = env(a, t, VOLUME * 1.6 * v, 0.3);
      o.type = 'sine'; o.frequency.setValueAtTime(160, t); o.frequency.exponentialRampToValueAtTime(40, t + 0.25);
      o.connect(og); og.connect(out); o.start(t); o.stop(t + 0.31);
      const w = noise(a), wf = a.createBiquadFilter(), wg = env(a, t + 0.04, VOLUME * 1.0 * v, 0.6);
      wf.type = 'lowpass'; wf.frequency.setValueAtTime(1200, t); wf.frequency.exponentialRampToValueAtTime(150, t + 0.6);
      w.connect(wf); wf.connect(wg); wg.connect(out); w.start(t + 0.04); w.stop(t + 0.65);
    });
  }
  let lastSplat = 0;
  function splat(h) {   // a piece landing
    const now = performance.now(); if (now - lastSplat < 60) return; lastSplat = now;
    const v = near(h.x, h.z);
    if (v < 0.03) return;
    play((a, t, out) => {
      const n = noise(a), f = a.createBiquadFilter(), g = env(a, t, VOLUME * 0.5 * v, 0.12);
      f.type = 'lowpass'; f.frequency.setValueAtTime(rnd(600, 1100), t); f.frequency.exponentialRampToValueAtTime(120, t + 0.1);
      n.connect(f); f.connect(g); g.connect(out); n.start(t); n.stop(t + 0.13);
    });
  }

  // test hooks (by hand in the console, headless runs): fire(o, d) shoots from o along d (unit);
  // infect(x, z) inflates the person nearest to (x, z) at once; pop() bursts every balloon now
  window.scBalloon = {
    fire(o, d) { shoot(o, d); },
    infect(x, z) {
      if (!ensure()) return false;
      const r = RES(); if (!r || !r.freeze) return false;
      const id = r.freeze(x, z); if (id < 0) return false;
      const info = r.skin(id, 'balloon'); if (!info) return false;
      startBalloon(info); return true;
    },
    pop() { for (const b of balloons.slice()) pop(b); },
    get balloons() { return balloons.map((b) => ({ t: +b.t.toFixed(2), x: +b.x.toFixed(3), z: +b.z.toFixed(3), y: b.pos ? +b.pos[1].toFixed(3) : null, feet: b.pos ? +(shape(b).alt).toFixed(3) : null, R: +b.R.toFixed(4) })); },
    get heaps() { return heaps.map((h) => ({ t: +h.t.toFixed(2), parts: h.parts.length, settled: h.parts.filter((p) => p.settled).length })); },
  };
})();
