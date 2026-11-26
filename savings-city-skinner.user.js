// ==UserScript==
// @name         Savings City – skinner (walk mode)
// @namespace    savings-city-tweaks
// @version      1.2
// @description  Adds a sci-fi skinner to walk mode (key 5, click): whoever it hits – a resident or a police officer – loses their skin in a flash of energy. The insides and bones are visible for a second, then all the parts fall in a heap on the floor, as if the skin was the only thing holding them together.
// @match        https://your-savings-city-host.example/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * Needs walk mode (1.32 or newer: plugin weapons, tracer, hitCar, rayBuildings), the core (classes,
 * frame loop, sound output, the app's scene) and residents (1.22 or newer: skin, spatter, avoid).
 * Police officers are skinned when cops (1.7 or newer) is loaded.
 *
 * - The shot: a beam from the skinner. It hits the nearest resident or officer on the line before
 *   a wall or car; the beam's arrival skins them (residents' and cops' skin(): they leave the city
 *   and get counted as "skinned" by the bodycount).
 * - Peel (0.9 s): an energy ring rises through the body; the pale skin rolls back piece by piece
 *   (head first, then torso, arms and legs), so the insides show through.
 * - Inside (from the start, under the skin): a red heart that pulses, lungs, liver, stomach,
 *   intestines, muscle, a bone skull with eye sockets, jaw and teeth, ribs, spine, arm and leg bones.
 *   Exposed (1 s): the insides, after the skin is gone.
 * - Fall: every part falls from where it sits (gravity, a bounce or two, a little push along the
 *   shot, spinning), lands and comes to rest in a heap. Blood spatters on the way down.
 * - Pile: the heap stays for PILE_TIME seconds, then fades. People keep away from it (avoid).
 * - Everything is instanced: one InstancedMesh per kind of part (blobs, rods, skin, rings), a slot
 *   pool each. At most MAX_ACTIVE bodies are moving or exposed at a time (the oldest one is dropped
 *   straight into its fall), at most MAX_BODIES in all (the oldest heap goes first).
 * - Blood follows the core's blood setting through residents' spatter.
 */
(function () {
  'use strict';

  // ---- settings (tiles; 1 tile ≈ 20 m; a person is 0.135 tall) ----
  const KEY = 'Digit5';            // select with 5 (or Q / the scroll wheel)
  const INTERVAL = 0.35;           // seconds between two shots
  const RANGE = 1.3;               // tiles (≈ 26 m)
  const PEEL_TIME = 0.9;           // seconds the skin takes to peel back
  const EXPOSED_TIME = 1.0;        // seconds the insides are shown before everything falls
  const FALL_MAX = 2.0;            // seconds after which every part has landed, whatever happened
  const PILE_TIME = 20;            // seconds a heap stays on the floor…
  const PILE_FADE = 1;             // …then it fades out this fast
  const MAX_ACTIVE = 6;            // bodies moving or exposed at once
  const MAX_BODIES = 30;           // bodies in all (heaps included)
  const GRAVITY = 3;               // tiles/s² (a miniature: a snappy fall reads better)
  const BOUNCE = 0.25;             // bounce on the floor
  const PUSH = 0.12;               // tiles/s pushed along the shot when the parts start to fall
  const SPIN = 9;                  // rad/s, how fast the parts tumble
  const SPLAT = 16;                // blood drops when the body starts to fall (× the blood setting)
  const AVOID = 0.035;             // people keep this far (tiles) from a heap
  const ENERGY = '#5ff3ff';        // the cyan energy of the skinner and the ring
  const VOLUME = 0.35;
  const CAP_BLOBS = 320, CAP_RODS = 720, CAP_SKIN = 220, CAP_RINGS = 40;
  // --------------------------------------------------------------

  const H_PERSON = 0.135;          // a standing person (residents' scale)
  const rnd = (a, b) => a + Math.random() * (b - a);
  const W = () => window.scWalk;
  const C = () => window.scCore;
  const RES = () => window.scResidents;

  const HEX = {
    organ: ['#8e0f14', '#a8171c', '#6e0b10', '#c0262a', '#7a1020'],
    lung: ['#b8464e', '#c25a60'],
    gut: ['#9c2a2a', '#b3383b', '#7e1d1d'],
    bone: ['#f1ead8', '#e2d8bf', '#fbf6e6'],
    skin: ['#eedbcc', '#e6cfbe'],
    socket: ['#2a1a14', '#3a2620'],
    ring: [ENERGY],
  };

  // ---------- the weapon ----------
  const def = {
    id: 'skinner', name: 'Huidschiller', key: KEY, interval: INTERVAL, kick: 0.1,
    at: [0.14, -0.12, -0.2], aim: 1.1, roll: -0.03, muzzle: [0, 0.005, -0.42],
    build({ builder, mesh, makeFlash, colors }) {
      const { DARK, GRIP, SKIN, SLEEVE, METAL } = colors;
      const b = builder();
      b.box(0, 0, -0.1, 0.05, 0.06, 0.26, METAL);                 // body
      b.box(0, 0.035, -0.02, 0.035, 0.02, 0.12, DARK);            // spine on top
      b.prism(0, 0, -0.27, 0.03, 0.05, 8, DARK);                  // the emitter housing
      b.prism(0, 0, -0.3, 0.02, 0.014, 10, ENERGY);               // glowing emitter ring
      b.prism(0, 0, -0.31, 0.011, 0.01, 8, ENERGY);              // the core
      b.box(0, -0.06, 0.05, 0.028, 0.07, 0.04, GRIP, -0.25);       // grip
      b.box(0.002, -0.07, 0.065, 0.046, 0.055, 0.05, SKIN, -0.25); // hand
      b.box(0.006, -0.12, 0.14, 0.06, 0.065, 0.16, SLEEVE, 0.45);  // sleeve
      b.box(0, -0.07, -0.16, 0.05, 0.05, 0.05, ENERGY);            // cell, lit
      b.box(-0.02, -0.11, -0.18, 0.06, 0.06, 0.16, SLEEVE, 0.6);
      return { root: mesh(b), flash: makeFlash(1.1) };
    },
    fire({ o, d, start }) { shoot(o, d, start); },
  };
  (window.scWalkWeapons = window.scWalkWeapons || []).push(def);

  // ---------- the shot ----------
  // Nearest officer on the line (same shape as cops' own targets: a thin cylinder per officer).
  function hitOfficer(o, d, maxT) {
    const cops = (window.scCops && typeof window.scCops.officers === 'function' && window.scCops.officers()) || [];
    const R = 0.022, a = d.x * d.x + d.z * d.z;
    let best = null;
    if (a < 1e-9) return null;
    cops.forEach((c, i) => {
      if (c.state !== 'exit' && c.state !== 'fight') return;
      const ex = o.x - c.x, ez = o.z - c.z, b = 2 * (ex * d.x + ez * d.z), cc = ex * ex + ez * ez - R * R, disc = b * b - 4 * a * cc;
      if (disc < 0) return;
      const t = (-b - Math.sqrt(disc)) / (2 * a), y = o.y + d.y * t;
      if (t > 0 && t < maxT && y >= 0.038 && y <= 0.172 && (!best || t < best.t)) best = { t, index: i };
    });
    return best;
  }

  function shoot(o, d, start) {
    const w = W(), res = RES();
    if (!w) return;
    // how far the beam reaches: a wall, a car, the ground, or the range
    let reach = RANGE;
    const wall = w.rayBuildings ? w.rayBuildings(o, d, reach) : null;
    if (wall) reach = wall.t;
    if (d.y < -1e-6) reach = Math.min(reach, o.y / -d.y);
    const car = w.hitCar ? w.hitCar(o, d, reach) : null;
    if (car) reach = car.t;
    // the nearest resident or officer before that
    let hit = null;
    if (res && typeof res.hit === 'function') {
      const h = res.hit(o, d, reach);
      if (h) { hit = { t: h.t, who: 'res', index: h.index }; reach = h.t; }
    }
    const off = hitOfficer(o, d, reach);
    if (off) hit = { t: off.t, who: 'cop', index: off.index };

    const tEnd = hit ? hit.t : reach;
    const end = { x: o.x + d.x * tEnd, y: o.y + d.y * tEnd, z: o.z + d.z * tEnd };
    zap();
    w.sound('hit');
    if (!hit) {
      if (wall || car) sparks(end, d);                      // the energy sparks off a wall or a car
      return;
    }
    w.tracer(start, end, () => {
      const info = hit.who === 'res'
        ? (res && typeof res.skin === 'function' ? res.skin(hit.index) : null)
        : (window.scCops && typeof window.scCops.skin === 'function' ? window.scCops.skin(hit.index) : null);
      if (info) skinBody(info, d);
    });
  }

  function sparks(p, d) {
    const w = W();
    if (!w || !w.spawn) return;
    for (let k = 0; k < 8; k++) w.spawn('spark', p.x, Math.max(0.02, p.y), p.z, { vx: -d.x * rnd(0.1, 0.4) + rnd(-0.2, 0.2), vy: rnd(0.1, 0.5), vz: -d.z * rnd(0.1, 0.4) + rnd(-0.2, 0.2), g: 3, size: 0.004, life: 0.4 });
    w.startEffects();
  }

  // a short electric zap through the core's output (follows the sound button)
  function zap() {
    const c = C();
    if (!c || !c.audio || !c.out) return;
    try {
      const a = c.audio(), t = a.currentTime;
      const osc = a.createOscillator(), g = a.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(1800, t);
      osc.frequency.exponentialRampToValueAtTime(120, t + 0.45);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(VOLUME, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
      osc.connect(g); g.connect(c.out(a));
      osc.start(t); osc.stop(t + 0.55);
    } catch (e) { /* no sound: fine */ }
  }

  // ---------- geometry (unit shapes; instances scale them) ----------
  function boxTris() {   // unit cube, both windings (the materials are single-sided)
    const v = [[-.5, -.5, -.5], [.5, -.5, -.5], [.5, .5, -.5], [-.5, .5, -.5], [-.5, -.5, .5], [.5, -.5, .5], [.5, .5, .5], [-.5, .5, .5]];
    const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [2, 3, 7], [2, 7, 6], [1, 2, 6], [1, 6, 5], [0, 4, 7], [0, 7, 3]];
    const P = [];
    for (const [a, b, c] of f) P.push(...v[a], ...v[b], ...v[c], ...v[a], ...v[c], ...v[b]);
    return P;
  }
  function blobTris() {  // icosahedron of radius 0.5: the scale is the full size of an organ
    const t = (1 + Math.sqrt(5)) / 2;
    const V = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]]
      .map((v) => { const l = Math.hypot(...v) * 2; return v.map((x) => x / l); });
    const F = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
    const P = [];
    for (const [a, b, c] of F) P.push(...V[a], ...V[b], ...V[c], ...V[a], ...V[c], ...V[b]);
    return P;
  }
  function ringTris() {  // flat annulus in the floor plane, both sides up
    const P = [], n = 20, ro = 1, ri = 0.8;
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
      const o0 = [Math.cos(a0) * ro, 0, Math.sin(a0) * ro], o1 = [Math.cos(a1) * ro, 0, Math.sin(a1) * ro];
      const i0 = [Math.cos(a0) * ri, 0, Math.sin(a0) * ri], i1 = [Math.cos(a1) * ri, 0, Math.sin(a1) * ri];
      P.push(...o0, ...o1, ...i1, ...o0, ...i1, ...i0, ...o0, ...i1, ...o1, ...o0, ...i0, ...i1);
    }
    return P;
  }

  // ---------- pools: one InstancedMesh per kind, slots handed out and given back ----------
  let K = null, scene = null, ready = false;
  const pools = {};
  const white = () => new K.Color('#ffffff');
  function makePool(name, tris, cap, material) {
    const g = new K.Geometry();
    g.setAttribute('position', new K.Attr(new Float32Array(tris), 3));
    const mesh = new K.Instanced(g, material, cap);
    mesh.frustumCulled = false; mesh.count = 0; mesh.name = 'sc-skinner-' + name;
    const w = white();
    for (let i = 0; i < cap; i++) mesh.setColorAt(i, w);
    scene.add(mesh);
    const free = [];
    for (let i = cap - 1; i >= 0; i--) free.push(i);
    return { mesh, cap, free, hi: 0, dirty: false, m: mesh.instanceMatrix.array, colors: new Map() };
  }
  // a slot in a pool (or -1 when the pool is full: that part is then left out)
  function take(pool, hex) {
    const i = pool.free.pop();
    if (i === undefined) return -1;
    if (i + 1 > pool.hi) pool.hi = i + 1;
    if (hex) {
      let col = pool.colors.get(hex);
      if (!col) pool.colors.set(hex, (col = new K.Color(hex)));
      pool.mesh.setColorAt(i, col);
      if (pool.mesh.instanceColor) pool.mesh.instanceColor.needsUpdate = true;
    }
    return i;
  }
  function give(pool, i) {
    if (i < 0) return;
    pool.m.fill(0, i * 16, i * 16 + 16);   // all zeros: invisible
    pool.free.push(i);
    pool.dirty = true;
  }
  // column-major matrix for position, Euler rotation (Rx·Ry·Rz) and scale, written at slot i
  function put(pool, i, x, y, z, rx, ry, rz, sx, sy, sz) {
    if (i < 0) return;
    const cx = Math.cos(rx), sxn = Math.sin(rx), cy = Math.cos(ry), syn = Math.sin(ry), cz = Math.cos(rz), szn = Math.sin(rz);
    const r00 = cy * cz, r01 = -cy * szn, r02 = syn;
    const r10 = cx * szn + sxn * syn * cz, r11 = cx * cz - sxn * syn * szn, r12 = -sxn * cy;
    const r20 = sxn * szn - cx * syn * cz, r21 = sxn * cz + cx * syn * szn, r22 = cx * cy;
    const e = pool.m, o = i * 16;
    e[o] = r00 * sx; e[o + 1] = r10 * sx; e[o + 2] = r20 * sx; e[o + 3] = 0;
    e[o + 4] = r01 * sy; e[o + 5] = r11 * sy; e[o + 6] = r21 * sy; e[o + 7] = 0;
    e[o + 8] = r02 * sz; e[o + 9] = r12 * sz; e[o + 10] = r22 * sz; e[o + 11] = 0;
    e[o + 12] = x; e[o + 13] = y; e[o + 14] = z; e[o + 15] = 1;
    pool.dirty = true;
  }

  function ensure() {
    if (ready) return true;
    const c = C();
    K = c && c.classes && c.classes();
    if (!K || !K.Instanced || !K.Geometry || !K.Attr || !K.Basic || !K.Color || !c.scene) return false;
    scene = c.scene;
    pools.blob = makePool('blob', blobTris(), CAP_BLOBS, new K.Basic({ color: '#ffffff' }));
    pools.rod = makePool('rod', boxTris(), CAP_RODS, new K.Basic({ color: '#ffffff' }));
    pools.skin = makePool('skin', boxTris(), CAP_SKIN, new K.Basic({ color: '#ffffff' }));
    pools.ring = makePool('ring', ringTris(), CAP_RINGS, new K.Basic({ color: '#ffffff', transparent: true, opacity: 0.9, depthWrite: false, blending: 2 }));
    ready = true;
    c.onFrame(step);
    return true;
  }

  // ---------- the body ----------
  // Interior, in person-local units (x, y up from the floor, z; a person is 0.135 tall). Each entry:
  // [pool, colour list, colour index or -1, x, y, z, sx, sy, sz, rx, ry, rz]. Sizes are full sizes.
  const INSIDE = [
    ['blob', 'bone', 1, 0, 0.124, 0, 0.026, 0.024, 0.026],           // cranium
    ['blob', 'socket', 0, -0.0065, 0.118, 0.01, 0.0075, 0.0075, 0.005],   // eye sockets
    ['blob', 'socket', 1, 0.0065, 0.118, 0.01, 0.0075, 0.0075, 0.005],
    ['rod', 'socket', 0, 0, 0.112, 0.012, 0.004, 0.006, 0.004],           // nose hole
    ['rod', 'bone', 0, 0, 0.106, 0.006, 0.018, 0.006, 0.012],             // jaw
    ['rod', 'bone', 1, -0.006, 0.109, 0.0115, 0.0025, 0.004, 0.002],      // teeth
    ['rod', 'bone', 2, -0.003, 0.109, 0.0115, 0.0025, 0.004, 0.002],
    ['rod', 'bone', 0, 0, 0.109, 0.0115, 0.0025, 0.004, 0.002],
    ['rod', 'bone', 1, 0.003, 0.109, 0.0115, 0.0025, 0.004, 0.002],
    ['rod', 'bone', 2, 0.006, 0.109, 0.0115, 0.0025, 0.004, 0.002],
    ['blob', 'organ', 0, -0.004, 0.08, 0.008, 0.018, 0.02, 0.016],   // heart
    ['blob', 'lung', 0, -0.013, 0.082, -0.002, 0.018, 0.04, 0.02],   // lungs
    ['blob', 'lung', 1, 0.013, 0.082, -0.002, 0.018, 0.04, 0.02],
    ['blob', 'organ', 1, 0.01, 0.068, 0.006, 0.024, 0.012, 0.016],   // liver
    ['blob', 'gut', 0, -0.01, 0.064, 0.009, 0.014, 0.014, 0.014],    // stomach
    ['blob', 'organ', 3, -0.012, 0.03, 0.01, 0.014, 0.03, 0.014],    // muscle on the legs
    ['blob', 'organ', 4, 0.012, 0.03, 0.01, 0.014, 0.03, 0.014],
    ['rod', 'bone', 0, 0, 0.075, -0.012, 0.005, 0.05, 0.005],        // spine
    ['rod', 'bone', 1, 0, 0.108, 0.006, 0.02, 0.005, 0.012],         // jaw
    ['rod', 'bone', 2, 0, 0.058, 0.011, 0.038, 0.0035, 0.0035, 0, 0, 0.12],   // ribs, front and back
    ['rod', 'bone', 0, 0, 0.07, 0.011, 0.038, 0.0035, 0.0035, 0, 0, -0.12],
    ['rod', 'bone', 1, 0, 0.082, 0.011, 0.038, 0.0035, 0.0035, 0, 0, 0.12],
    ['rod', 'bone', 2, 0, 0.094, 0.011, 0.038, 0.0035, 0.0035, 0, 0, -0.12],
    ['rod', 'bone', 0, 0, 0.058, -0.011, 0.038, 0.0035, 0.0035, 0, 0, -0.12],
    ['rod', 'bone', 1, 0, 0.07, -0.011, 0.038, 0.0035, 0.0035, 0, 0, 0.12],
    ['rod', 'bone', 2, 0, 0.082, -0.011, 0.038, 0.0035, 0.0035, 0, 0, -0.12],
    ['rod', 'bone', 0, 0, 0.094, -0.011, 0.038, 0.0035, 0.0035, 0, 0, 0.12],
    ['rod', 'bone', 1, -0.033, 0.08, 0, 0.006, 0.032, 0.006],        // upper arm bones
    ['rod', 'bone', 2, 0.033, 0.08, 0, 0.006, 0.032, 0.006],
    ['rod', 'bone', 0, -0.033, 0.075, 0, 0.005, 0.03, 0.005],        // forearm bones
    ['rod', 'bone', 1, 0.033, 0.075, 0, 0.005, 0.03, 0.005],
    ['rod', 'bone', 2, -0.011, 0.024, 0, 0.008, 0.04, 0.008],        // thigh bones
    ['rod', 'bone', 0, 0.011, 0.024, 0, 0.008, 0.04, 0.008],
    ['rod', 'bone', 1, -0.011, 0.01, 0.004, 0.007, 0.03, 0.007],     // shin bones
    ['rod', 'bone', 2, 0.011, 0.01, 0.004, 0.007, 0.03, 0.007],
    ['rod', 'gut', 0, -0.008, 0.052, 0.012, 0.022, 0.006, 0.006, 0, 0.4, 0],   // intestines
    ['rod', 'gut', 1, 0.008, 0.047, 0.013, 0.02, 0.006, 0.006, 0, -0.5, 0],
    ['rod', 'gut', 2, 0, 0.058, 0.011, 0.018, 0.005, 0.005, 0, 0.1, 0],
    ['rod', 'gut', 0, -0.004, 0.044, 0.009, 0.016, 0.006, 0.006, 0, 0.9, 0],
    ['rod', 'gut', 1, 0.006, 0.055, 0, 0.02, 0.006, 0.006, 0, 0, 0.4],
  ];
  // the skin: pale shells over the body, peeled off in the first 0.4 s
  // [x, y, z, sx, sy, sz, delay]: the head peels first, then the torso, arms and legs
  const SKIN_SHELL = [
    [-0.011, 0.024, 0, 0.017, 0.048, 0.018, 0.4],     // legs
    [0.011, 0.024, 0, 0.017, 0.048, 0.018, 0.4],
    [0, 0.076, 0, 0.044, 0.056, 0.03, 0.2],           // torso
    [-0.033, 0.08, 0, 0.016, 0.05, 0.016, 0.3],       // arms
    [0.033, 0.08, 0, 0.016, 0.05, 0.016, 0.3],
    [0, 0.12, 0, 0.032, 0.034, 0.032, 0],             // head
  ];
  const ROLL = 0.35;   // seconds one piece of skin takes to roll back

  const bodies = [];
  // local (x right, y up, z front) → world, for a body turned by b.th (its front faces the shooter)
  function local(b, lx, ly, lz) {
    const s = Math.sin(b.th), c = Math.cos(b.th);
    return [b.x + lx * c + lz * s, b.y + ly, b.z - lx * s + lz * c];
  }
  function release(b) {
    for (const p of b.parts) give(pools[p.pool], p.slot);
    for (const p of b.skin) give(pools.skin, p.slot);
    if (b.ring >= 0) give(pools.ring, b.ring);
    b.parts = []; b.skin = []; b.ring = -1;
  }
  function removeBody(b) {
    release(b);
    b.gone = true;
    const i = bodies.indexOf(b);
    if (i >= 0) bodies.splice(i, 1);
  }

  // Skins someone. info = { x, z, y (floor), h (height), k } from residents' or cops' skin().
  function skinBody(info, d) {
    if (!ensure()) return false;
    const l = Math.hypot(d.x, d.z) || 1;
    const sc = (info.h || H_PERSON) / H_PERSON;             // children are smaller
    while (bodies.length >= MAX_BODIES) removeBody(bodies[0]);
    const moving = bodies.filter((b) => b.phase === 'peel' || b.phase === 'exposed' || b.phase === 'fall');
    if (moving.length >= MAX_ACTIVE) hurry(moving[0]);      // the oldest one drops straight to its fall

    const b = { x: info.x, y: info.y || 0.036, z: info.z, sc, th: Math.atan2(-d.x, -d.z), dx: d.x / l, dz: d.z / l, phase: 'peel', t: 0, parts: [], skin: [], ring: -1, flaps: [], fallT: 0, pileT: 0, fadeT: 0, gone: false };
    b.ring = take(pools.ring, HEX.ring[0]);
    for (const [lx, ly, lz, sx, sy, sz, delay] of SKIN_SHELL) {
      b.skin.push({ slot: take(pools.skin, HEX.skin[0]), lx: lx * sc, ly: ly * sc, lz: lz * sc, sx: sx * sc, sy: sy * sc, sz: sz * sc, delay });
    }
    for (let k = 0; k < 4; k++) {                           // flakes of skin that fly off
      b.flaps.push({ slot: take(pools.skin, HEX.skin[1]), lx: rnd(-0.02, 0.02) * sc, ly: rnd(0.03, 0.12) * sc, lz: rnd(-0.015, 0.015) * sc,
        vx: b.dx * 0.06 + rnd(-0.05, 0.05), vy: rnd(0.08, 0.2), vz: b.dz * 0.06 + rnd(-0.05, 0.05),
        rx: rnd(0, 6), ry: rnd(0, 6), rz: rnd(0, 6), sx: 0.02 * sc, sy: 0.03 * sc, sz: 0.002 * sc });
    }
    showInside(b);                                          // the insides are there from the start, under the skin
    bodies.push(b);
    return true;
  }

  // the shot's skin is gone at once: the body moves on to its fall (for the cap)
  function hurry(b) { b.t = PEEL_TIME + EXPOSED_TIME; }

  function releaseSkin(b) {
    for (const p of b.skin) give(pools.skin, p.slot);
    for (const f of b.flaps) give(pools.skin, f.slot);
    b.skin = []; b.flaps = [];
    give(pools.ring, b.ring); b.ring = -1;
  }

  // the insides appear as the skin goes
  function showInside(b) {
    b.parts = [];
    for (const [pool, col, ci, lx, ly, lz, sx, sy, sz, rx = 0, ry = 0, rz = 0] of INSIDE) {
      const hex = HEX[col][ci % HEX[col].length];
      const slot = take(pools[pool], hex);
      if (slot < 0) continue;
      const p = { pool, slot, lx: lx * b.sc, ly: ly * b.sc, lz: lz * b.sc, sx: sx * b.sc, sy: sy * b.sc, sz: sz * b.sc, rx, ry: ry + b.th, rz,
        vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0, x: 0, y: 0, z: 0, settled: false, heart: pool === 'blob' && col === 'organ' && ci === 0 && lz === 0.008 };
      b.parts.push(p);
      const [X, Y, Z] = local(b, p.lx, p.ly, p.lz);
      put(pools[pool], slot, X, Y, Z, p.rx, p.ry, p.rz, p.sx, p.sy, p.sz);
    }
  }

  // every part starts to fall from where it is, with a push along the shot and a spin
  function fall(b) {
    b.phase = 'fall'; b.fallT = 0;
    for (const p of b.parts) {
      [p.x, p.y, p.z] = local(b, p.lx, p.ly, p.lz);
      p.vx = b.dx * PUSH * rnd(0.3, 1.2) + rnd(-0.03, 0.03);
      p.vy = rnd(0, 0.06);
      p.vz = b.dz * PUSH * rnd(0.3, 1.2) + rnd(-0.03, 0.03);
      p.wx = rnd(-SPIN, SPIN); p.wy = rnd(-SPIN, SPIN); p.wz = rnd(-SPIN, SPIN);
      p.r = Math.max(p.sx, p.sy, p.sz) / 2;
    }
    const r = RES();
    if (r && typeof r.spatter === 'function') r.spatter(b.x, b.y + 0.06 * b.sc, b.z, b.dx, b.dz, SPLAT, 0.45, 0.35);
    if (r && typeof r.avoid === 'function') r.avoid(b.x, b.z, AVOID, PILE_TIME + PILE_FADE + 2);
  }

  function stepFall(b, dt) {
    let all = true;
    const force = b.fallT > FALL_MAX;
    for (const p of b.parts) {
      if (p.settled) continue;
      if (!force) {
        p.vy -= GRAVITY * dt;
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
        p.rx += p.wx * dt; p.ry += p.wy * dt; p.rz += p.wz * dt;
        const floor = b.y + p.r;
        if (p.y <= floor) {                                  // on the floor: bounce, then rest
          p.y = floor;
          if (p.vy < 0) p.vy = -p.vy * BOUNCE;
          if (p.vy < 0.03) p.vy = 0;
          const g = Math.exp(-8 * dt);
          p.vx *= g; p.vz *= g; p.wx *= g; p.wy *= g; p.wz *= g;
          if (p.vy === 0 && Math.hypot(p.vx, p.vz) < 0.004 && Math.abs(p.wx) + Math.abs(p.wy) + Math.abs(p.wz) < 0.2) {
            p.settled = true; p.vx = p.vz = 0; p.wx = p.wy = p.wz = 0;
          }
        }
      } else {
        p.y = b.y + p.r; p.settled = true;
      }
      if (!p.settled) all = false;
      put(pools[p.pool], p.slot, p.x, p.y, p.z, p.rx, p.ry, p.rz, p.sx, p.sy, p.sz);
    }
    if (all || force) { b.phase = 'pile'; b.pileT = 0; }
  }

  // the peel: the energy ring rises; each piece of skin shrinks towards its bottom edge (rolls back),
  // the head first, so the insides show through from the top down
  function peel(b) {
    const p = Math.min(1, b.t / PEEL_TIME), sc = b.sc, h = H_PERSON * sc;
    if (b.ring >= 0) {
      const r = (0.012 + 0.05 * p) * sc;
      put(pools.ring, b.ring, b.x, b.y + h * p * 0.95 + 0.002, b.z, 0, 0, 0, r, 1, r);
    }
    for (const s of b.skin) {
      const q = Math.min(1, Math.max(0, (b.t - s.delay) / ROLL)), left = 1 - q;
      const height = s.sy * left;
      const [X, Y, Z] = local(b, s.lx, s.ly - s.sy / 2 + height / 2, s.lz);
      put(pools.skin, s.slot, X, Y, Z, 0, b.th, 0, s.sx, Math.max(height, 1e-5), s.sz);
    }
    for (const f of b.flaps) {
      const k = Math.max(0, 1 - p);
      put(pools.skin, f.slot, b.x + f.lx + f.vx * b.t, b.y + f.ly + f.vy * b.t, b.z + f.lz + f.vz * b.t,
        f.rx + b.t * 6, f.ry + b.t * 4, f.rz, f.sx * k, f.sy * k, f.sz * k);
    }
  }

  function step(dt) {
    if (!ready || !bodies.length) { flush(); return; }
    dt = Math.min(dt || 0, 0.05);
    for (const b of bodies.slice()) {
      if (b.gone) continue;
      b.t += dt;
      if (b.phase === 'peel') {
        if (b.t < PEEL_TIME) { peel(b); continue; }
        releaseSkin(b);                                      // the skin is gone
        b.phase = 'exposed';
      }
      if (b.phase === 'exposed') {
        if (b.t < PEEL_TIME + EXPOSED_TIME) {
          for (const p of b.parts) if (p.heart) {            // the heart keeps beating
            const k = 1 + 0.07 * Math.sin(b.t * 9) ** 2;
            const [X, Y, Z] = local(b, p.lx, p.ly, p.lz);
            put(pools[p.pool], p.slot, X, Y, Z, p.rx, p.ry, p.rz, p.sx * k, p.sy * k, p.sz * k);
          }
          continue;
        }
        fall(b);
      }
      if (b.phase === 'fall') {
        b.fallT += dt;
        stepFall(b, dt);
        if (b.phase !== 'pile') continue;
      }
      if (b.phase === 'pile') {
        b.pileT += dt;
        if (b.pileT >= PILE_TIME) { b.phase = 'fade'; b.fadeT = 0; }
        continue;
      }
      if (b.phase === 'fade') {
        b.fadeT += dt;
        const k = Math.max(0, 1 - b.fadeT / PILE_FADE);
        for (const p of b.parts) put(pools[p.pool], p.slot, p.x, p.y, p.z, p.rx, p.ry, p.rz, p.sx * k, p.sy * k, p.sz * k);
        if (b.fadeT >= PILE_FADE) removeBody(b);
      }
    }
    flush();
  }
  function flush() {
    for (const name of Object.keys(pools)) {
      const p = pools[name];
      if (!p.dirty) continue;
      p.dirty = false;
      p.mesh.count = p.hi;
      p.mesh.instanceMatrix.needsUpdate = true;
    }
  }
})();
