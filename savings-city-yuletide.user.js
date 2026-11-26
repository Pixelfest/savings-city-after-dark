// ==UserScript==
// @name         Savings City – yuletide grenade (walk mode)
// @namespace    savings-city-tweaks
// @version      1.1
// @description  Adds a yuletide grenade to walk mode (key 6, click to throw): a little Christmas tree that goes off the moment it hits the ground, throwing out a ring of green sprinkles that shows how far it reaches. A Christmas tree grows out of everyone within 10 m and tears them apart: their organs hang in it as baubles, their bowels are the garland, their head goes on top, and the blood splatters on the ground.
// @match        https://your-savings-city-host.example/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * Needs walk mode (1.32 or newer: plugin weapons, rayBuildings), the core (classes, frame loop,
 * sound output, the app's scene) and residents (1.25 or newer: skin(i, cause) with the person's
 * colours, spatter, avoid, alarm). Police officers get a tree too when cops (1.13 or newer) is loaded.
 *
 * - The throw: a little Christmas tree leaves your hand along the crosshair (a bit upwards),
 *   tumbles, bounces off walls and goes off the moment it hits the ground (so nobody gets the
 *   time to run); one that never lands (MAX_FLIGHT) goes off in the air.
 * - The blast: a flash, tinsel and pine needles, a puff of snow and a few bars of a Christmas tune.
 *   A ring of bright green sprinkles shoots out over the ground and stops exactly at RADIUS, where
 *   it lies for a moment: everyone inside that ring changes.
 *   Everyone outside within RADIUS (≈ 10 m) is taken (residents' and cops' skin(i, 'tree'): they
 *   leave the city and count as "tree" in the bodycount); people further away run.
 * - Each victim (nearest first, a little later the further out): the body swells and shakes as a
 *   tree grows inside it, then it tears open. The tree shoots up out of it (with a little
 *   overshoot; always green); blood sprays all around onto the ground and pools at its foot. The
 *   clothes (trousers and shirt, in the person's own colours) slump down into a heap in that
 *   puddle under the tree; the organs fly into the tree and
 *   hang from the tips of its branches like baubles; the bowels wind around it as a garland, pulled
 *   out bead by bead; the head flies up and is stuck on top, where it keeps dripping for a while.
 * - The tree stands TREE_TIME seconds, then shrinks away. People keep away from it (avoid).
 * - Everything is instanced: one InstancedMesh per shape (cones, blobs, boxes), lit like the city,
 *   with a slot pool each. At most MAX_TREES trees at a time (the oldest goes first).
 * - Blood follows the core's blood setting through residents' spatter.
 */
(function () {
  'use strict';

  // ---- settings (tiles; 1 tile ≈ 20 m; a person is 0.135 tall) ----
  const KEY = 'Digit6';            // select with 6 (or Q / the scroll wheel)
  const INTERVAL = 1.0;            // seconds between two throws
  const THROW_SPEED = 2.6;         // tiles/s along the crosshair…
  const THROW_UP = 0.6;            // …plus this much upwards
  const MAX_FLIGHT = 4;            // seconds: a grenade that hasn't landed by then goes off anyway
  const RADIUS = 0.5;              // tiles: everyone this close gets a tree (≈ 10 m)
  const PANIC_RADIUS = 2.5;        // people within this distance run away
  const RIPPLE = 0.35;             // seconds: the furthest victim starts this much after the nearest
  const SPRINKLES = 160;           // green sprinkles in the ring that marks the blast radius
  const SPRINKLE_OUT = 0.35;       // seconds they take to fly out to the edge…
  const SPRINKLE_STAY = 1.6;       // …how long they lie there…
  const SPRINKLE_FADE = 0.5;       // …and how fast they shrink away
  const SPRINKLE_GREENS = ['#3ddc5a', '#7cf07a', '#1fae3c', '#b6ff8a'];
  const SWELL = 0.4;               // seconds the body swells before it tears
  const GROW = 0.65;               // seconds the tree takes to shoot up after that
  const TREE_SIZE = 1;             // × the tree's size (≈ 0.27 tiles tall, twice a person)
  const TREE_TIME = 30;            // seconds a tree stands…
  const TREE_FADE = 1.5;           // …then it shrinks away this fast
  const MAX_TREES = 60;            // trees at once (the oldest goes first)
  const BEADS = 46;                // pieces of bowel in the garland
  const SPLAT = 7;                 // blood drops per direction when the body tears (8 directions, × the blood setting)
  const DRIP_TIME = 5;             // seconds the head on top keeps dripping
  const AVOID = 0.13;              // people keep this far (tiles) from a tree
  const GRAVITY = 3;               // tiles/s² for the thrown tree
  const BOUNCE = 0.35;             // how much of its speed the grenade keeps on a bounce
  const VOLUME = 0.3;
  const CAP_CONES = 320, CAP_BLOBS = 6000, CAP_BOXES = 2400;
  // --------------------------------------------------------------

  const H_PERSON = 0.135;
  const rnd = (a, b) => a + Math.random() * (b - a);
  const W = () => window.scWalk;
  const C = () => window.scCore;
  const RES = () => window.scResidents;

  // the tree, in tree units (× TREE_SIZE × a little variation): the trunk and four tiers of
  // branches, each a cone [bottom y, height, radius]
  // (the lowest branches start a little up, so you can see the heap of clothes under them)
  const TRUNK = [0.016, 0.054, 0.016];          // [width, height, depth] of the trunk
  const TIERS = [[0.044, 0.11, 0.105], [0.102, 0.1, 0.086], [0.158, 0.09, 0.066], [0.21, 0.082, 0.046]];
  const TOP = 0.292;
  const GREEN = '#237a3b';         // the tree is always green, whoever it grew out of
  const GREENS = [GREEN, GREEN, GREEN, GREEN];
  const TRUNK_COLOR = '#5b3a1e';
  // police officers' look (cops don't hand out colours)
  const COP_COLORS = { shirt: '#2b4a8a', trousers: '#1f2a44', skin: '#eec4a2', hair: '#2b1d14', bald: false };
  const ANY_SHIRT = ['#e25d5d', '#4f8fd8', '#f0a24a', '#7bc77b', '#f2f2f2', '#9b6fd8'];
  const FLESH = ['#8e0f14', '#a8171c', '#6e0b10', '#c0262a'];
  const GUT = ['#c4686a', '#b3383b', '#d27c7a', '#a84a4c'];
  // the organs that end up as baubles: [colour, size x, y, z, where in the torso (x, y, z)]
  const ORGANS = [
    ['#8e0f14', 0.012, 0.014, 0.011, -0.003, 0.08, 0.004],     // heart
    ['#c25a60', 0.01, 0.02, 0.011, -0.008, 0.082, 0],          // lungs
    ['#b8464e', 0.01, 0.02, 0.011, 0.008, 0.082, 0],
    ['#6e0b10', 0.016, 0.009, 0.013, 0.006, 0.066, 0.002],     // liver
    ['#b3383b', 0.011, 0.011, 0.01, -0.006, 0.064, 0.003],     // stomach
    ['#7a1020', 0.007, 0.01, 0.007, -0.007, 0.058, -0.006],    // kidneys
    ['#7a1020', 0.007, 0.01, 0.007, 0.007, 0.058, -0.006],
    ['#a8171c', 0.009, 0.009, 0.009, 0.004, 0.072, 0.006],     // lumps of flesh
    ['#c0262a', 0.009, 0.008, 0.009, -0.004, 0.07, -0.004],
    ['#8e0f14', 0.008, 0.009, 0.008, 0, 0.09, 0.004],
    ['#a8171c', 0.008, 0.008, 0.008, 0.002, 0.06, 0],
    ['#6e0b10', 0.009, 0.008, 0.009, -0.002, 0.076, -0.005],
  ];

  // ---------- geometry (unit shapes, both windings; instances scale them) ----------
  function both(P, a, b, c) { P.push(...a, ...b, ...c, ...a, ...c, ...b); }
  function boxTris() {   // unit cube centred on the origin
    const v = [[-.5, -.5, -.5], [.5, -.5, -.5], [.5, .5, -.5], [-.5, .5, -.5], [-.5, -.5, .5], [.5, -.5, .5], [.5, .5, .5], [-.5, .5, .5]];
    const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [2, 3, 7], [2, 7, 6], [1, 2, 6], [1, 6, 5], [0, 4, 7], [0, 7, 3]];
    const P = [];
    for (const [a, b, c] of f) both(P, v[a], v[b], v[c]);
    return P;
  }
  function blobTris() {  // icosahedron of radius 0.5
    const t = (1 + Math.sqrt(5)) / 2;
    const V = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]]
      .map((v) => { const l = Math.hypot(...v) * 2; return v.map((x) => x / l); });
    const F = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
    const P = [];
    for (const [a, b, c] of F) both(P, V[a], V[b], V[c]);
    return P;
  }
  function coneTris(n = 9) {   // base radius 0.5 at y = 0, the tip at y = 1; a closed base
    const P = [];
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
      const p0 = [Math.cos(a0) * 0.5, 0, Math.sin(a0) * 0.5], p1 = [Math.cos(a1) * 0.5, 0, Math.sin(a1) * 0.5];
      both(P, p0, p1, [0, 1, 0]);
      both(P, p0, [0, 0, 0], p1);
    }
    return P;
  }

  // ---------- the weapon ----------
  // The model in your hand: a little tree on a short trunk (held by the trunk), with baubles, a
  // star and a grenade's ring through the trunk. Cones go straight into the builder's triangles.
  const def = {
    id: 'yuletide', name: 'Kerstgranaat', key: KEY, interval: INTERVAL, kick: 0.5,
    at: [0.2, -0.21, -0.45], aim: 1.2, roll: 0, muzzle: [0, 0.06, -0.02],
    build({ builder, mesh, colors }) {
      const { SKIN, SLEEVE } = colors;
      const b = builder(), K2 = C() && C().classes && C().classes();
      const col = K2 && K2.Color ? new K2.Color() : null;
      const L = [-0.35, 0.85, 0.4], ll = Math.hypot(...L);
      const cone = (cx, cy, cz, r, h, hex) => {               // a shaded cone standing on (cx, cy, cz)
        if (!col) { b.box(cx, cy + h / 2, cz, r * 1.4, h, r * 1.4, hex); return; }
        col.set(hex);
        const n = 10, ny = r / Math.hypot(r, h);
        for (let i = 0; i < n; i++) {
          const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2, am = (a0 + a1) / 2;
          const nx = Math.cos(am) * (h / Math.hypot(r, h)), nz = Math.sin(am) * (h / Math.hypot(r, h));
          const k = 0.3 + 0.7 * Math.max(0, (nx * L[0] + ny * L[1] + nz * L[2]) / ll);
          for (const v of [[Math.cos(a0) * r, 0, Math.sin(a0) * r], [0, h, 0], [Math.cos(a1) * r, 0, Math.sin(a1) * r]]) {
            b.P.push(cx + v[0], cy + v[1], cz + v[2]); b.C.push(col.r * k, col.g * k, col.b * k);
          }
        }
      };
      b.box(0, -0.02, 0, 0.018, 0.05, 0.018, TRUNK_COLOR);          // trunk
      cone(0, 0.0, 0, 0.055, 0.06, GREENS[0]);                       // three tiers
      cone(0, 0.03, 0, 0.044, 0.05, GREENS[1]);
      cone(0, 0.056, 0, 0.032, 0.045, GREENS[2]);
      b.box(0, 0.104, 0, 0.014, 0.014, 0.014, '#ffd23f', 0, 0.78);   // the star
      b.box(0.03, 0.006, 0.026, 0.011, 0.011, 0.011, '#d01c1f');     // baubles
      b.box(-0.032, 0.012, 0.02, 0.01, 0.01, 0.01, '#e8c547');
      b.box(0.012, 0.04, 0.026, 0.009, 0.009, 0.009, '#2b6fd6');
      b.box(-0.016, 0.05, 0.022, 0.009, 0.009, 0.009, '#d01c1f');
      b.box(0.018, -0.022, 0.0, 0.004, 0.026, 0.026, '#c9ccd2');    // the grenade's ring through the trunk
      b.box(0.002, -0.05, 0.01, 0.05, 0.05, 0.05, SKIN, -0.2);       // hand around the trunk
      b.box(0.01, -0.1, 0.09, 0.06, 0.065, 0.16, SLEEVE, 0.45);      // sleeve
      return { root: mesh(b), flash: mesh(builder()) };               // no muzzle flash
    },
    fire({ d, start }) { throwTree(start, d); },
  };
  (window.scWalkWeapons = window.scWalkWeapons || []).push(def);

  // ---------- pools: one InstancedMesh per shape, slots handed out and given back ----------
  let K = null, scene = null, ready = false;
  const pools = {};
  function makePool(name, tris, cap, shadow) {
    const g = new K.Geometry();
    g.setAttribute('position', new K.Attr(new Float32Array(tris), 3));
    g.computeVertexNormals();
    const mat = noSnow(K.Lambert ? new K.Lambert({ color: '#ffffff' }) : new K.Basic({ color: '#ffffff' }));
    const mesh = new K.Instanced(g, mat, cap);
    mesh.frustumCulled = false; mesh.count = 0; mesh.name = 'sc-yuletide-' + name;
    mesh.castShadow = !!shadow; mesh.receiveShadow = true;
    const w = new K.Color('#ffffff');
    for (let i = 0; i < cap; i++) mesh.setColorAt(i, w);
    mesh.instanceMatrix.array.fill(0);
    scene.add(mesh);
    const free = [];
    for (let i = cap - 1; i >= 0; i--) free.push(i);
    return { mesh, cap, free, hi: 0, dirty: false, m: mesh.instanceMatrix.array, colors: new Map() };
  }
  // In winter the app patches three.js' Lambert shader to lay snow on every upward-facing surface
  // (how much: the SNOW_COVER define, 0.9 when not set). Our trees stay green and the blood red.
  function noSnow(m) { m.defines = { ...(m.defines || {}), SNOW_COVER: '-0.50' }; return m; }
  function take(pool, hex) {   // a slot (-1 when the pool is full: that part is left out)
    const i = pool.free.pop();
    if (i === undefined) return -1;
    if (i + 1 > pool.hi) pool.hi = i + 1;
    let col = pool.colors.get(hex);
    if (!col) pool.colors.set(hex, (col = new K.Color(hex)));
    pool.mesh.setColorAt(i, col);
    if (pool.mesh.instanceColor) pool.mesh.instanceColor.needsUpdate = true;
    return i;
  }
  function give(pool, i) {
    if (i < 0) return;
    pool.m.fill(0, i * 16, i * 16 + 16);   // all zeros: invisible
    pool.free.push(i);
    pool.dirty = true;
  }
  // rotation R = Rx·Ry·Rz (as in put) applied to v
  function rot(rx, ry, rz, v) {
    let [x, y, z] = v, c = Math.cos(rz), s = Math.sin(rz);
    [x, y] = [x * c - y * s, x * s + y * c];
    c = Math.cos(ry); s = Math.sin(ry);
    [x, z] = [x * c + z * s, -x * s + z * c];
    c = Math.cos(rx); s = Math.sin(rx);
    [y, z] = [y * c - z * s, y * s + z * c];
    return [x, y, z];
  }
  // column-major matrix for position, rotation (Rx·Ry·Rz) and scale, written at slot i
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
    if (!K || !K.Instanced || !K.Geometry || !K.Attr || !K.Color || !(K.Lambert || K.Basic) || !c.scene) return false;
    scene = c.scene;
    pools.cone = makePool('cone', coneTris(), CAP_CONES, true);
    pools.blob = makePool('blob', blobTris(), CAP_BLOBS, false);
    pools.box = makePool('box', boxTris(), CAP_BOXES, false);
    ready = true;
    c.onFrame(step);
    return true;
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

  // ---------- the thrown tree ----------
  const grenades = [];
  let gGeo = null, gMat = null;
  function grenadeMesh() {
    if (!gGeo) {
      const P = [], Cs = [], col = new K.Color();
      const add = (tris, tx, ty, tz, sx, sy, sz, hex) => {
        col.set(hex);
        for (let i = 0; i < tris.length; i += 3) { P.push(tx + tris[i] * sx, ty + tris[i + 1] * sy, tz + tris[i + 2] * sz); Cs.push(col.r, col.g, col.b); }
      };
      const cone = coneTris(8), box = boxTris(), blob = blobTris(), g = 0.13;   // a tenth of a big tree, a bit bigger
      add(box, 0, 0.005, 0, 0.005, 0.01, 0.005, TRUNK_COLOR);
      add(cone, 0, 0.007, 0, 0.034, 0.02, 0.034, GREENS[0]);
      add(cone, 0, 0.016, 0, 0.026, 0.017, 0.026, GREENS[1]);
      add(cone, 0, 0.024, 0, 0.018, 0.014, 0.018, GREENS[2]);
      add(blob, 0, 0.039, 0, 0.006, 0.006, 0.006, '#ffd23f');
      add(blob, 0.012, 0.01, 0.006, 0.005, 0.005, 0.005, '#d01c1f');
      add(blob, -0.01, 0.017, -0.006, 0.004, 0.004, 0.004, '#e8c547');
      add(blob, 0.002, 0.022, 0.008, 0.004, 0.004, 0.004, '#2b6fd6');
      add(box, 0.004, 0.004, 0, 0.001, 0.006, 0.006, '#c9ccd2');
      void g;
      gGeo = new K.Geometry();
      gGeo.setAttribute('position', new K.Attr(new Float32Array(P), 3));
      gGeo.setAttribute('color', new K.Attr(new Float32Array(Cs), 3));
      gGeo.computeVertexNormals();
      gMat = noSnow(K.Lambert ? new K.Lambert({ vertexColors: true }) : new K.Basic({ vertexColors: true }));
    }
    const m = new K.Mesh(gGeo, gMat);
    m.frustumCulled = false; m.castShadow = true;
    return m;
  }
  function throwTree(start, d) {
    if (!ensure()) return;
    const w = W();
    const m = grenadeMesh();
    m.position.set(start.x, start.y, start.z);
    scene.add(m);
    grenades.push({ m, p: { ...start }, v: { x: d.x * THROW_SPEED, y: d.y * THROW_SPEED + THROW_UP, z: d.z * THROW_SPEED },
      t: 0, spin: { x: rnd(-9, 9), y: rnd(-6, 6), z: rnd(-9, 9) } });
    whoosh();
    if (w && w.note) void 0;
  }
  const FLOOR = 0.038;
  function stepGrenades(dt) {
    const w = W();
    for (let k = grenades.length - 1; k >= 0; k--) {
      const g = grenades[k];
      g.t += dt;
      if (g.t >= MAX_FLIGHT) { g.m.removeFromParent(); grenades.splice(k, 1); detonate(g.p, false); continue; }
      g.v.y -= GRAVITY * dt;
      const len = Math.hypot(g.v.x, g.v.y, g.v.z) * dt;
      if (len > 1e-6 && w && w.rayBuildings) {                       // a wall in the way: bounce off it
        const d = { x: g.v.x * dt / len, y: g.v.y * dt / len, z: g.v.z * dt / len };
        const h = w.rayBuildings(g.p, d, len + 0.01);
        if (h && h.n) {
          const vn = g.v.x * h.n.x + g.v.y * h.n.y + g.v.z * h.n.z;
          if (vn < 0) {
            g.v.x -= (1 + BOUNCE) * vn * h.n.x; g.v.y -= (1 + BOUNCE) * vn * h.n.y; g.v.z -= (1 + BOUNCE) * vn * h.n.z;
            g.v.x *= 0.8; g.v.z *= 0.8;
            const t = Math.max(0, h.t - 0.01);
            g.p.x += d.x * t; g.p.y += d.y * t; g.p.z += d.z * t;
            thud();
          }
        }
      }
      g.p.x += g.v.x * dt; g.p.y += g.v.y * dt; g.p.z += g.v.z * dt;
      if (g.p.y <= FLOOR) {                                           // the ground: it goes off right there
        g.p.y = FLOOR;
        g.m.removeFromParent(); grenades.splice(k, 1); detonate(g.p, true);
        continue;
      }
      g.m.rotation.x += g.spin.x * dt; g.m.rotation.y += g.spin.y * dt; g.m.rotation.z += g.spin.z * dt;
      g.m.position.set(g.p.x, g.p.y, g.p.z);
    }
  }

  // ---------- the blast ----------
  function detonate(p, landed = true) {
    const w = W(), res = RES(), cx = p.x, cz = p.z, y = Math.max(p.y, FLOOR) + 0.02;
    if (w && w.spawn) {
      w.spawn('flash', cx, y, cz, { size: 0.18, life: 0.2, grow: 2 });
      const TINSEL = ['#d01c1f', '#e8c547', '#2b6fd6', '#ffffff', '#c9ccd2', '#2a8443'];
      for (let k = 0; k < 40; k++) {
        const a = Math.random() * Math.PI * 2, sp = rnd(0.3, 1.1);
        w.spawn('debris', cx, y, cz, { color: TINSEL[k % TINSEL.length], vx: Math.cos(a) * sp, vy: rnd(0.4, 1.4), vz: Math.sin(a) * sp, g: 2.2, size: rnd(0.004, 0.008), life: rnd(1.5, 2.5), land: true, spin: true });
      }
      for (let k = 0; k < 16; k++) { const a = Math.random() * Math.PI * 2, sp = rnd(0.2, 0.8); w.spawn('leaf', cx, y, cz, { vx: Math.cos(a) * sp, vy: rnd(0.3, 1), vz: Math.sin(a) * sp, g: 1.5, size: rnd(0.005, 0.009), life: rnd(1, 2), land: true, spin: true }); }
      for (let k = 0; k < 12; k++) { const a = Math.random() * Math.PI * 2, sp = rnd(0.3, 1.2); w.spawn('spark', cx, y, cz, { vx: Math.cos(a) * sp, vy: rnd(0.3, 1.2), vz: Math.sin(a) * sp, g: 3, size: 0.005, life: rnd(0.3, 0.7) }); }
      for (let k = 0; k < 5; k++) w.spawn('dust', cx + rnd(-0.04, 0.04), y, cz + rnd(-0.04, 0.04), { fade: true, color: '#ffffff', vx: rnd(-0.2, 0.2), vy: rnd(0.05, 0.2), vz: rnd(-0.2, 0.2), rise: 0.03, size: rnd(0.025, 0.04), grow: 2, life: rnd(0.8, 1.3), alpha: 0.6 });
      w.startEffects();
    }
    pop(); jingle();
    sprinkle(cx, cz);
    // everyone outside within RADIUS: nearest first
    const found = [];
    if (res && res.people) {
      res.people.forEach((q, i) => {
        if (!q || q.state === 'inside' || q.state === 'down' || q.state === 'gone') return;
        const dist = Math.hypot(q.x - cx, q.z - cz);
        if (dist <= RADIUS) found.push({ who: 'res', i, dist });
      });
    }
    const cops = (window.scCops && typeof window.scCops.officers === 'function' && window.scCops.officers()) || [];
    cops.forEach((c, i) => {
      if (c.state !== 'exit' && c.state !== 'fight') return;
      const dist = Math.hypot(c.x - cx, c.z - cz);
      if (dist <= RADIUS) found.push({ who: 'cop', i, dist });
    });
    found.sort((a, b) => a.dist - b.dist);
    for (const f of found) {
      let info = null;
      try {
        info = f.who === 'res' ? res.skin(f.i, 'tree') : window.scCops.skin(f.i, 'tree');
      } catch (e) { console.warn('[yuletide] take', e); }
      if (info) plant(info, f.dist / RADIUS * RIPPLE, cx, cz);
    }
    if (res && typeof res.alarm === 'function') res.alarm(cx, cz, PANIC_RADIUS, 15);
    window.dispatchEvent(new CustomEvent('sc:blast', { detail: { x: cx, z: cz, source: 'yuletide', landed } }));
  }

  // ---------- the ring of green sprinkles: shows how far the blast reaches ----------
  // Little green rods that shoot out over the ground from the blast (fast, then slowing down),
  // hop a little, and stop exactly on the RADIUS circle; a few land inside it. They lie there for
  // SPRINKLE_STAY seconds, then shrink away.
  const rings = [];
  function sprinkle(cx, cz) {
    if (!ensure()) return;
    const bits = [];
    for (let k = 0; k < SPRINKLES; k++) {
      const edge = k % 5 !== 0;                               // most on the edge, every fifth inside
      const slot = take(pools.box, SPRINKLE_GREENS[k % SPRINKLE_GREENS.length]);
      if (slot < 0) break;
      bits.push({ slot, a: (k / SPRINKLES) * Math.PI * 2 + rnd(-0.02, 0.02), r: edge ? RADIUS * rnd(0.985, 1.01) : RADIUS * rnd(0.15, 0.95),
        hop: rnd(0.015, 0.05), rx: rnd(0, 6), ry: rnd(0, 6), rz: rnd(0, 6), w: rnd(-14, 14), len: rnd(0.012, 0.018) });
    }
    rings.push({ x: cx, z: cz, t: 0, bits });
  }
  function stepRings(dt) {
    for (let k = rings.length - 1; k >= 0; k--) {
      const R = rings[k];
      R.t += dt;
      const u = Math.min(1, R.t / SPRINKLE_OUT), out = 1 - Math.pow(1 - u, 3);        // fast, then slowing down
      const fade = Math.max(0, 1 - Math.max(0, R.t - SPRINKLE_OUT - SPRINKLE_STAY) / SPRINKLE_FADE);
      for (const b of R.bits) {
        const r = b.r * out, y = FLOOR + 0.003 + b.hop * Math.sin(Math.PI * u);
        const spin = (1 - u) * b.w * R.t;
        put(pools.box, b.slot, R.x + Math.cos(b.a) * r, y, R.z + Math.sin(b.a) * r, u < 1 ? b.rx + spin : Math.PI / 2, b.ry, u < 1 ? b.rz + spin : 0,
          b.len * fade, 0.005 * fade, 0.005 * fade);
      }
      if (fade <= 0) { for (const b of R.bits) give(pools.box, b.slot); rings.splice(k, 1); }
    }
  }

  // ---------- the trees ----------
  // A tree is a list of parts. A part is a few instances (items) that move as one: { items:
  // [{ pool, slot, ox, oy, oz, sx, sy, sz }], from: [x, y, z] (world), to: () → [x, y, z] (world,
  // follows the growing tree), r0, r1 (rotations), spin, t0, t1, lift }. Before t0 it stays at
  // `from` (in the body), between t0 and t1 it flies an arc, after t1 it sits at `to`.
  const trees = [];

  function surfaceR(y) {   // the tree's radius at height y (tree units)
    let r = 0;
    for (const [y0, h, rr] of TIERS) if (y >= y0 && y <= y0 + h) r = Math.max(r, rr * (1 - (y - y0) / h));
    return r;
  }

  function plant(info, delay, bx, bz) {
    while (trees.length >= MAX_TREES) removeTree(trees[0]);
    const sc = (info.h || H_PERSON) / H_PERSON;
    const colors = info.colors || (info.cop ? COP_COLORS : { shirt: ANY_SHIRT[(Math.random() * ANY_SHIRT.length) | 0], trousers: '#2f4a7a', skin: '#eec4a2', hair: '#3d2a1c', bald: false });
    const th = typeof info.th === 'number' ? info.th : rnd(0, Math.PI * 2);
    const T = {
      x: info.x, z: info.z, y: info.y || 0.036, sc, th, S: TREE_SIZE * rnd(0.9, 1.1), spinTree: rnd(0, Math.PI * 2),
      t: -delay, phase: 'wait', parts: [], tiers: [], trunk: -1, fadeK: 1, burst: false, drip: 0, dripT: 0, gone: false, still: false,
      away: Math.atan2(info.z - bz, info.x - bx),
    };
    // the tree's own instances
    T.trunk = take(pools.box, TRUNK_COLOR);
    T.tiers = TIERS.map((_, k) => take(pools.cone, GREENS[k % GREENS.length]));
    // the body, in person-local coordinates (x right, y up, z front; turned by th)
    const L = (lx, ly, lz) => {
      const s = Math.sin(th), c = Math.cos(th);
      return [T.x + (lx * c + lz * s) * sc, T.y + ly * sc, T.z + (-lx * s + lz * c) * sc];
    };
    // a point on the tree (tree units, angle a around it, radius out, height y) → world, now
    const onTree = (a, out, y) => () => {
      const s = T.grow * T.fadeK, a2 = a + T.spinTree;
      return [T.x + Math.cos(a2) * out * T.S * s, treeBase(T) + y * T.S * s, T.z + Math.sin(a2) * out * T.S * s];
    };
    const ground = (a, r, up) => { const p = [T.x + Math.cos(a) * r, T.y + up, T.z + Math.sin(a) * r]; return () => p; };
    const part = (items, from, to, o) => {
      const pt = { items: items.filter((it) => it.slot >= 0), from, to, r0: o.r0 || [0, th, 0], r1: o.r1 || [0, th, 0],
        spin: o.spin || [rnd(-6, 6), rnd(-6, 6), rnd(-6, 6)], t0: o.t0, t1: o.t1, lift: o.lift || 0, trail: !!o.trail, swell: !!o.swell, onTree: !!o.onTree, scale: o.scale || 1 };
      T.parts.push(pt);
      return pt;
    };
    // an instance in a part; end: its size [x, y, z] once landed (it changes shape on the way: clothes go flat)
    const item = (pool, hex, ox, oy, oz, sx, sy, sz, end) => ({ pool, slot: take(pools[pool], hex), ox: ox * sc, oy: oy * sc, oz: oz * sc, sx: sx * sc, sy: sy * sc, sz: sz * sc, end });
    const flesh = () => FLESH[(Math.random() * FLESH.length) | 0];

    // the pool of blood at the foot of the tree, spreading as the body tears
    part([item('blob', '#5e0a0e', 0, 0, 0, 0.001, 0.001, 0.001, [0.17, 0.003, 0.17])], [T.x, T.y + 0.0012, T.z], ground(0, 0, 0.0012),
      { t0: SWELL, t1: SWELL + 1.2, r1: [0, rnd(0, 6), 0], spin: [0, 0, 0] });
    // the clothes: the body's own trousers and shirt (with the flesh inside them) slump down into a
    // heap in the puddle at the foot of the tree, in the person's own colours
    let layer = 0;
    const heap = (lx, ly, hex, size, flat, fleshAt) => {
      const a = rnd(0, Math.PI * 2), r = rnd(0.025, 0.075) * sc, up = (0.003 + layer++ * 0.0035) * sc;
      part([item('box', hex, 0, 0, 0, ...size, flat), item('blob', flesh(), ...fleshAt, 0.012, 0.012, 0.014, [0.018 * sc, 0.003 * sc, 0.02 * sc])],
        L(lx, ly, 0), ground(a, r, up), { t0: SWELL + rnd(0, 0.1), t1: SWELL + rnd(0.35, 0.55), lift: rnd(0.02, 0.05), swell: true,
          r1: [rnd(-0.08, 0.08), rnd(0, 6), rnd(-0.08, 0.08)], spin: [rnd(-1, 1), rnd(-2, 2), rnd(-1, 1)] });
    };
    for (const side of [-1, 1]) heap(side * 0.0075, 0.024, colors.trousers, [0.014, 0.048, 0.018], [0.026 * sc, 0.004 * sc, 0.044 * sc], [0, 0.02, 0]);
    for (const sx of [-1, 1]) for (const sy of [0, 1]) heap(sx * 0.009, 0.0625 + sy * 0.027, colors.shirt, [0.018, 0.027, 0.024], [0.032 * sc, 0.004 * sc, 0.028 * sc], [-sx * 0.006, 0, 0]);
    // scraps of flesh that slap onto the ground
    for (let k = 0; k < 6; k++) {
      const a = rnd(0, Math.PI * 2), r = rnd(0.05, 0.22), s = rnd(0.006, 0.01);
      part([item('blob', flesh(), 0, 0, 0, s, s, s)], L(rnd(-0.01, 0.01), rnd(0.05, 0.09), 0), ground(a, r, 0.0015 * sc),
        { t0: SWELL, t1: SWELL + rnd(0.3, 0.6), lift: rnd(0.08, 0.18), r1: [0, rnd(0, 6), 0], scale: 1, trail: true, flat: true });
      T.parts[T.parts.length - 1].flat = true;
    }
    // the organs: into the tree, hanging from the tips of its branches like baubles
    ORGANS.forEach(([hex, sx, sy, sz, ox, oy, oz], k) => {
      const tier = k % 3, [y0, , rr] = TIERS[tier], a = (k / ORGANS.length) * Math.PI * 2 * 2.3 + rnd(-0.3, 0.3);
      const t0 = SWELL + rnd(0, 0.15);
      part([item('blob', hex, 0, 0, 0, sx, sy, sz)], L(ox, oy, oz), onTree(a, rr * 0.93, y0 - 0.004), {
        t0, t1: t0 + rnd(0.45, 0.7), lift: rnd(0.08, 0.16), r1: [0, rnd(0, 6), 0], trail: true, onTree: true });
    });
    // the bowels: a garland wound around the tree, pulled out bead by bead
    const a0 = rnd(0, Math.PI * 2), turns = 1.7;
    for (let k = 0; k < BEADS; k++) {
      const u = k / (BEADS - 1), y = 0.07 + u * 0.19, a = a0 + u * turns * Math.PI * 2, out = surfaceR(y) + 0.004;
      const t0 = SWELL + 0.05 + u * 0.55;
      const pt = part([item('blob', GUT[k % GUT.length], 0, 0, 0, 0.014, 0.0075, 0.0075)], L(0, 0.06, 0.005), onTree(a, out, y), {
        t0, t1: t0 + 0.35, lift: 0.05, r1: [0, -(a + T.spinTree) - Math.PI / 2, rnd(-0.25, 0.25)], spin: [0, 0, 0], onTree: true });
      pt.hideBefore = true;
    }
    // the head: up onto the top, stuck on the tip like a star
    const hd = 0.022, items = [item('box', colors.skin, 0, 0, 0, hd, hd, hd),
      item('box', '#1a1410', -0.005, 0.002, hd / 2, 0.003, 0.004, 0.002),           // eyes
      item('box', '#1a1410', 0.005, 0.002, hd / 2, 0.003, 0.004, 0.002),
      item('box', '#5a0d10', 0, -0.006, hd / 2, 0.008, 0.003, 0.002),               // mouth, open
      item('blob', '#8e0f14', 0, -hd / 2, 0, 0.014, 0.006, 0.014)];                 // the torn neck
    if (!colors.bald) items.push(item('box', colors.hair, 0, hd / 2, -0.002, hd + 0.002, 0.007, hd + 0.002));
    T.head = part(items, L(0, 0.116, 0), onTree(0, 0, TOP - 0.001 + 0.011 * sc / T.S), {
      t0: SWELL, t1: SWELL + 0.85, lift: rnd(0.18, 0.26), r1: [rnd(-0.15, 0.15), th + rnd(-0.6, 0.6), rnd(-0.2, 0.2)], trail: true, onTree: true });
    T.grow = 0;
    draw(T);
    trees.push(T);
    if (RES() && typeof RES().avoid === 'function') RES().avoid(T.x, T.z, AVOID, TREE_TIME + TREE_FADE + 1);
  }

  // where the tree's foot is: while it grows inside the body it hangs at chest height
  function treeBase(T) { return T.y + 0.07 * T.sc * (1 - Math.min(1, T.grow)); }

  function removeTree(T) {
    for (const p of T.parts) for (const it of p.items) give(pools[it.pool], it.slot);
    for (const s of T.tiers) give(pools.cone, s);
    give(pools.box, T.trunk);
    T.parts = []; T.tiers = []; T.trunk = -1; T.gone = true;
    const i = trees.indexOf(T);
    if (i >= 0) trees.splice(i, 1);
  }

  // the tree's size over time: a little inside the swelling body, then out with an overshoot
  function growth(t) {
    if (t <= 0) return 0;
    if (t < SWELL) return 0.17 * (t / SWELL);
    const u = Math.min(1, (t - SWELL) / GROW), b = 1.9;
    const e = 1 + (b + 1) * Math.pow(u - 1, 3) + b * Math.pow(u - 1, 2);   // ease out, overshooting
    return 0.17 + 0.83 * e;
  }

  function draw(T) {
    const s = T.grow * T.fadeK, base = treeBase(T), S = T.S;
    // trunk and branches
    put(pools.box, T.trunk, T.x, base + TRUNK[1] * S * s / 2, T.z, 0, T.spinTree, 0, TRUNK[0] * S * s, TRUNK[1] * S * s, TRUNK[0] * S * s);
    TIERS.forEach(([y0, h, r], k) => put(pools.cone, T.tiers[k], T.x, base + y0 * S * s, T.z, 0, T.spinTree + k * 0.7, 0, 2 * r * S * s, h * S * s, 2 * r * S * s));
    // the body and what becomes of it
    const swellQ = T.t > 0 ? Math.min(1, T.t / SWELL) : 0;
    for (const p of T.parts) {
      let pos, r, k = p.scale;
      if (T.t < p.t0) {
        if (p.hideBefore) { for (const it of p.items) put(pools[it.pool], it.slot, 0, 0, 0, 0, 0, 0, 0, 0, 0); continue; }
        pos = p.from.slice(); r = p.r0;
        if (p.swell && swellQ > 0) {                         // the body swells and shakes
          const j = 0.0025 * swellQ * T.sc;
          pos[0] += rnd(-j, j); pos[1] += rnd(-j, j) * 0.5; pos[2] += rnd(-j, j);
          k *= 1 + 0.18 * swellQ;
        }
      } else if (T.t < p.t1) {
        const u = (T.t - p.t0) / (p.t1 - p.t0), to = p.to();
        pos = [p.from[0] + (to[0] - p.from[0]) * u, p.from[1] + (to[1] - p.from[1]) * u + p.lift * 4 * u * (1 - u), p.from[2] + (to[2] - p.from[2]) * u];
        const sn = Math.sin(Math.PI * u);
        r = [p.r0[0] + (p.r1[0] - p.r0[0]) * u + p.spin[0] * sn, p.r0[1] + (p.r1[1] - p.r0[1]) * u + p.spin[1] * sn, p.r0[2] + (p.r1[2] - p.r0[2]) * u + p.spin[2] * sn];
        if (p.trail && Math.random() < 0.25) bleedAt(pos);
      } else {
        pos = p.to(); r = p.r1;
        if (!p.onTree) k *= T.fadeK;
        if (p.flat) k *= 1;                                  // scraps: flattened below
      }
      if (p.onTree && T.t >= p.t1) k *= T.fadeK;
      const u = T.t < p.t0 ? 0 : T.t < p.t1 ? (T.t - p.t0) / (p.t1 - p.t0) : 1;
      for (const it of p.items) {
        let sx = it.sx, sy = it.sy, sz = it.sz, off = 1;
        if (it.end) { sx += (it.end[0] - sx) * u; sy += (it.end[1] - sy) * u; sz += (it.end[2] - sz) * u; off = 1 - u; }
        const o = rot(r[0], r[1], r[2], [it.ox * k * off, it.oy * k * off, it.oz * k * off]);
        const flat = p.flat && T.t >= p.t1 ? 0.35 : 1;
        put(pools[it.pool], it.slot, pos[0] + o[0], pos[1] + o[1], pos[2] + o[2], r[0], r[1], r[2], sx * k, sy * k * flat, sz * k);
      }
    }
  }

  // a drop or two of blood from a flying piece
  function bleedAt(p) {
    const r = RES();
    if (r && typeof r.spatter === 'function') r.spatter(p[0], p[1], p[2], 0, 0, 0.6, 0.05, 0.02);
  }

  function burst(T) {
    T.burst = true;
    const r = RES();
    if (r && typeof r.spatter === 'function') {
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2 + rnd(-0.2, 0.2);
        r.spatter(T.x, T.y + 0.07 * T.sc, T.z, Math.cos(a), Math.sin(a), SPLAT, 0.75, 0.5);
      }
      r.spatter(T.x, T.y + 0.02, T.z, 0, 0, SPLAT * 2, 0.25, 0.15);   // and a pool at the foot of the tree
      if (typeof r.screamAt === 'function' && Math.random() < 0.5) r.screamAt(T.x, T.z, undefined, true);
    }
    crunch();
  }

  function step(dt) {
    dt = Math.min(dt || 0, 0.05);
    if (grenades.length) stepGrenades(dt);
    if (!ready) return;
    if (rings.length) stepRings(dt);
    for (const T of trees.slice()) {
      if (T.gone) continue;
      T.t += dt;
      if (T.t < 0) { if (!T.drawn) { draw(T); T.drawn = true; } continue; }
      if (!T.burst && T.t >= SWELL) burst(T);
      T.grow = growth(T.t);
      const end = SWELL + Math.max(GROW, 1.3);
      if (T.t < end) { draw(T); continue; }
      if (T.t < end + DRIP_TIME) {                           // the head on top keeps dripping
        T.dripT -= dt;
        if (T.dripT <= 0) { T.dripT = rnd(0.15, 0.4); const h = T.head.to(); bleedAt([h[0] + rnd(-0.004, 0.004), h[1] - 0.012 * T.sc, h[2] + rnd(-0.004, 0.004)]); }
      }
      if (!T.still) { T.grow = 1; draw(T); T.still = true; }
      if (T.t >= end + TREE_TIME) {
        T.fadeK = Math.max(0, 1 - (T.t - end - TREE_TIME) / TREE_FADE);
        draw(T);
        if (T.fadeK <= 0) removeTree(T);
      }
    }
    flush();
  }

  // ---------- sounds (through the core's output: follows the sound button) ----------
  function audio() { const c = C(); return c && c.audio && c.out ? c : null; }
  function whoosh() {
    const c = audio(); if (!c) return;
    try {
      const a = c.audio(), t = a.currentTime, n = noise(a, 0.35), f = a.createBiquadFilter(), g = a.createGain();
      f.type = 'bandpass'; f.Q.value = 1.5; f.frequency.setValueAtTime(600, t); f.frequency.exponentialRampToValueAtTime(1800, t + 0.3);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(VOLUME * 0.5, t + 0.08); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.33);
      n.connect(f); f.connect(g); g.connect(c.out(a)); n.start(t); n.stop(t + 0.35);
    } catch (e) { /* no sound */ }
  }
  let lastThud = 0;
  function thud() {
    const c = audio(), now = performance.now(); if (!c || now - lastThud < 80) return; lastThud = now;
    try {
      const a = c.audio(), t = a.currentTime, o = a.createOscillator(), g = a.createGain();
      o.type = 'triangle'; o.frequency.setValueAtTime(220, t); o.frequency.exponentialRampToValueAtTime(90, t + 0.08);
      g.gain.setValueAtTime(VOLUME * 0.6, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
      o.connect(g); g.connect(c.out(a)); o.start(t); o.stop(t + 0.12);
    } catch (e) { /* no sound */ }
  }
  function pop() {
    const c = audio(); if (!c) return;
    try {
      const a = c.audio(), t = a.currentTime, n = noise(a, 0.6), f = a.createBiquadFilter(), g = a.createGain();
      f.type = 'lowpass'; f.frequency.setValueAtTime(2500, t); f.frequency.exponentialRampToValueAtTime(200, t + 0.5);
      g.gain.setValueAtTime(VOLUME * 1.6, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
      n.connect(f); f.connect(g); g.connect(c.out(a)); n.start(t); n.stop(t + 0.6);
    } catch (e) { /* no sound */ }
  }
  // sleigh bells and the opening of a well-known (public domain) Christmas tune, on bells
  function jingle() {
    const c = audio(); if (!c) return;
    try {
      const a = c.audio(), t0 = a.currentTime + 0.15, out = c.out(a);
      const E = 659.3, G = 784, Cn = 523.3, D = 587.3;
      const tune = [[E, 0], [E, 0.16], [E, 0.32], [E, 0.64], [E, 0.8], [E, 0.96], [E, 1.28], [G, 1.44], [Cn, 1.6], [D, 1.8], [E, 1.96]];
      for (const [f, at] of tune) {
        for (const [mul, vol] of [[1, 1], [2.76, 0.3], [5.4, 0.12]]) {     // a bell: a few inharmonic partials
          const o = a.createOscillator(), g = a.createGain(), t = t0 + at;
          o.type = 'sine'; o.frequency.value = f * mul;
          g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(VOLUME * 0.35 * vol, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
          o.connect(g); g.connect(out); o.start(t); o.stop(t + 0.65);
        }
      }
      for (let k = 0; k < 10; k++) {                                       // sleigh bells
        const t = t0 + k * 0.2, n = noise(a, 0.12), f = a.createBiquadFilter(), g = a.createGain();
        f.type = 'highpass'; f.frequency.value = 6000;
        g.gain.setValueAtTime(VOLUME * 0.25, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
        n.connect(f); f.connect(g); g.connect(out); n.start(t); n.stop(t + 0.12);
      }
    } catch (e) { /* no sound */ }
  }
  let lastCrunch = 0;
  function crunch() {   // wet tearing: low noise with a rough tremble
    const c = audio(), now = performance.now(); if (!c || now - lastCrunch < 60) return; lastCrunch = now;
    try {
      const a = c.audio(), t = a.currentTime, n = noise(a, 0.45), f = a.createBiquadFilter(), g = a.createGain(), lfo = a.createOscillator(), lg = a.createGain();
      f.type = 'lowpass'; f.frequency.setValueAtTime(1400, t); f.frequency.exponentialRampToValueAtTime(250, t + 0.4);
      lfo.frequency.value = 38; lg.gain.value = VOLUME * 0.4; lfo.connect(lg); lg.connect(g.gain);
      g.gain.setValueAtTime(VOLUME * 0.8, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
      n.connect(f); f.connect(g); g.connect(c.out(a)); n.start(t); n.stop(t + 0.45); lfo.start(t); lfo.stop(t + 0.45);
    } catch (e) { /* no sound */ }
  }
  let noiseBuf = null;
  function noise(a, len) {
    if (!noiseBuf || noiseBuf.sampleRate !== a.sampleRate) {
      noiseBuf = a.createBuffer(1, a.sampleRate, a.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const s = a.createBufferSource(); s.buffer = noiseBuf; s.loop = len > 1; return s;
  }

  // test hooks (local/harness, by hand in the console): detonate(x, z) sets one off there at once;
  // throw(start, dir) throws one as the weapon does ({ x, y, z }, a unit direction)
  window.scYuletide = { detonate: (x, z) => { if (ensure()) detonate({ x, y: FLOOR, z }); }, throw: (start, d) => throwTree(start, d),
    get trees() { return trees.length; }, get flying() { return grenades.length; } };
})();
