// ==UserScript==
// @name         Savings City – black hole grenade (walk mode)
// @namespace    savings-city-tweaks
// @version      1.0
// @description  Adds a black hole grenade to walk mode (key 7, click to throw): a dark marble that rolls to a stop and opens into a black hole with a glowing accretion disk. It pulls in people, police officers, cars, trees, lamps, benches and building chunks on a growing spiral – people stretch into long strands as they cross the horizon – and after a few seconds it collapses and spits everything back out, mangled.
// @match        https://your-savings-city-host.example/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * Needs walk mode (1.35 or newer: plugin weapons, takeProp), the core (classes, frame loop, sound
 * output, smoke, the damage bus) and residents (skin(i, cause) with the person's colours,
 * spatter). Buildings (1.6 or newer: well) lets it eat buildings; cops lets it eat officers.
 *
 * - The throw: a dark marble with a violet glow leaves your hand along the crosshair, bounces off
 *   walls and rolls along the ground. FUSE seconds after the throw it rises to HOVER and opens.
 * - The hole: a black ball (the horizon) with a glowing rim and an accretion disk of hot streaks
 *   circling it (white near the middle, orange and red further out, faster inside). Dust and grit
 *   from the ground spiral into it. It grows for GROW seconds and lives LIFE seconds.
 * - Nobody notices it: people walk on as if nothing happens until the pull has them.
 * - The pull reaches further and further (up to REACH). Whatever it reaches is taken out of the
 *   city and moved by this script: residents and officers (their skin(i, 'blackhole'): they count
 *   as "blackhole" in the bodycount), traffic cars (held, hidden, drawn from their own batch's
 *   model; whoever was inside dies when it's swallowed), trees, street lamps, benches and
 *   fountains (walk mode's takeProp). Everything spirals in faster and faster, spinning, leaving
 *   a trail of blood; close to the horizon it stretches along the pull and goes thin
 *   (spaghettification), screaming lower and lower, and shrinks into the middle.
 * - Buildings: a gravity well in the buildings script (scBuildings.well) peels chunks off the
 *   side facing the hole and pulls them in on the same spiral; a building that has lost a third
 *   comes down towards the hole.
 * - You: within reach you're pulled towards it too (slowly; walls stop you).
 * - The end: it collapses (the disk falls in, a rising howl) and spits everything back out in one
 *   blast (the core's damage bus, residents' blast): building chunks, smaller and tumbling; people
 *   as mangled heaps (flesh, a shoe, rags of their clothes, now and then a head) that splat on the
 *   ground; cars as burnt, burning shells; trees and lamps thrown about.
 * - Everything is instanced where it can be (people, gore, the disk, dust): one InstancedMesh per
 *   shape with a slot pool. At most MAX_HOLES holes at a time.
 */
(function () {
  'use strict';

  // ---- settings (tiles; 1 tile ≈ 20 m; a person is 0.135 tall) ----
  const KEY = 'Digit7';            // select with 7 (or Q / the scroll wheel)
  const INTERVAL = 1.5;            // seconds between two throws
  const THROW_SPEED = 2.4;         // tiles/s along the crosshair…
  const THROW_UP = 0.5;            // …plus this much upwards
  const FUSE = 2.2;                // seconds after the throw the marble opens
  const HOVER = 0.24;              // tiles above the ground the hole hangs (≈ 5 m)
  const RISE = 0.6;                // seconds the marble takes to rise there
  const GROW = 1.0;                // seconds the hole takes to open to its full size
  const LIFE = 9;                  // seconds it pulls…
  const COLLAPSE = 0.8;            // …then it collapses this fast and spits everything out
  const HOLE_R = 0.09;             // tiles: the black ball's radius (≈ 2 m)
  const REACH = 1.7;               // tiles: how far it pulls at its strongest (≈ 34 m)…
  const REACH_TIME = 5.5;          // …reached after this many seconds (it grows)
  const PULL = 1.1;                // pull strength: acceleration = PULL / distance² (tiles/s², capped)
  const SWIRL = 0.75;              // sideways pull: the spiral
  const BUILDING_PEEL = 1.6;       // how fast it peels chunks off buildings (buildings' well)
  const PLAYER_PULL = 0.35;        // tiles/s you're dragged at near the hole (0: not at all)
  const PLAYER_STOP = 0.45;        // tiles: …but never closer than this (≈ 9 m)
  const SPIT_SPEED = 3.2;          // tiles/s things fly back out at (at most)
  const MAX_HOLES = 3;
  const MAX_BODIES = 180;          // people, cars and props in flight at once (all holes)
  const DISK_BITS = 260;           // streaks in an accretion disk
  const DUST_BITS = 110;           // bits of grit spiralling in per hole
  const GORE_TIME = 25;            // seconds the spat-out remains lie there…
  const GORE_FADE = 1.2;           // …then they shrink away this fast
  const WRECK_TIME = 90;           // seconds a spat-out car shell stays
  const BURN_TIME = 8;             // seconds it burns
  const SCREAM_GAP = 0.25;         // seconds between two screams at least
  const VOLUME = 0.3;
  const CAP_BOXES = 2600, CAP_BLOBS = 1600, CAP_DISK = DISK_BITS * MAX_HOLES, CAP_DUST = DUST_BITS * MAX_HOLES;
  // --------------------------------------------------------------

  const H_PERSON = 0.135, FLOOR = 0.038;
  const rnd = (a, b) => a + Math.random() * (b - a);
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const W = () => window.scWalk;
  const C = () => window.scCore;
  const RES = () => window.scResidents;
  const COPS = () => window.scCops;
  const BLD = () => window.scBuildings;

  const COP_COLORS = { shirt: '#2b4a8a', trousers: '#1f2a44', skin: '#eec4a2', hair: '#2b1d14', bald: false };
  const ANY_SHIRT = ['#e25d5d', '#4f8fd8', '#f0a24a', '#7bc77b', '#f2f2f2', '#9b6fd8'];
  const FLESH = ['#8e0f14', '#a8171c', '#6e0b10', '#c0262a', '#b3383b'];
  const DISK_COLORS = ['#fff6dc', '#ffe3a0', '#ffc061', '#ff9a3a', '#ff6a24', '#e8401c', '#b02a6a'];
  const DUST_COLORS = ['#8f857a', '#a89c8a', '#6e665e', '#5b5f66', '#7a6a55', '#3f3a36'];
  // the figure (person-local, feet at 0, z = front): [part, x, y, z, w, h, d]
  const FIGURE = [['legs', -0.0075, 0.024, 0, 0.014, 0.048, 0.018], ['legs', 0.0075, 0.024, 0, 0.014, 0.048, 0.018],
    ['shirt', 0, 0.076, 0, 0.036, 0.054, 0.024], ['skin', 0, 0.116, 0, 0.022, 0.022, 0.022], ['hair', 0, 0.1305, -0.001, 0.024, 0.007, 0.024]];
  const MID = 0.065;                // the figure's middle (what's pulled)

  // ---------- 3×3 rotations (row-major) ----------
  function rotM(x, y, z, a) {
    const c = Math.cos(a), s = Math.sin(a), t = 1 - c;
    return [t * x * x + c, t * x * y - s * z, t * x * z + s * y, t * x * y + s * z, t * y * y + c, t * y * z - s * x, t * x * z - s * y, t * y * z + s * x, t * z * z + c];
  }
  const mul = (A, B) => [
    A[0] * B[0] + A[1] * B[3] + A[2] * B[6], A[0] * B[1] + A[1] * B[4] + A[2] * B[7], A[0] * B[2] + A[1] * B[5] + A[2] * B[8],
    A[3] * B[0] + A[4] * B[3] + A[5] * B[6], A[3] * B[1] + A[4] * B[4] + A[5] * B[7], A[3] * B[2] + A[4] * B[5] + A[5] * B[8],
    A[6] * B[0] + A[7] * B[3] + A[8] * B[6], A[6] * B[1] + A[7] * B[4] + A[8] * B[7], A[6] * B[2] + A[7] * B[5] + A[8] * B[8]];
  const rotY = (a) => { const c = Math.cos(a), s = Math.sin(a); return [c, 0, s, 0, 1, 0, -s, 0, c]; };
  const apply = (M, v) => [M[0] * v[0] + M[1] * v[1] + M[2] * v[2], M[3] * v[0] + M[4] * v[1] + M[5] * v[2], M[6] * v[0] + M[7] * v[1] + M[8] * v[2]];
  // stretched along unit u by `along`, `across` the other ways, all × k
  function stretchM(u, along, across, k) {
    const d = along - across;
    return [(across + d * u[0] * u[0]) * k, d * u[0] * u[1] * k, d * u[0] * u[2] * k,
      d * u[1] * u[0] * k, (across + d * u[1] * u[1]) * k, d * u[1] * u[2] * k,
      d * u[2] * u[0] * k, d * u[2] * u[1] * k, (across + d * u[2] * u[2]) * k];
  }
  const I3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  // write matrix B (3×3, row-major) × size and translation t into a column-major array at o
  function writeM(e, o, B, t, sx = 1, sy = 1, sz = 1) {
    e[o] = B[0] * sx; e[o + 1] = B[3] * sx; e[o + 2] = B[6] * sx; e[o + 3] = 0;
    e[o + 4] = B[1] * sy; e[o + 5] = B[4] * sy; e[o + 6] = B[7] * sy; e[o + 7] = 0;
    e[o + 8] = B[2] * sz; e[o + 9] = B[5] * sz; e[o + 10] = B[8] * sz; e[o + 11] = 0;
    e[o + 12] = t[0]; e[o + 13] = t[1]; e[o + 14] = t[2]; e[o + 15] = 1;
  }

  // ---------- geometry (unit shapes; instances scale them) ----------
  function boxTris() {   // unit cube centred on the origin, outward winding
    const v = [[-.5, -.5, -.5], [.5, -.5, -.5], [.5, .5, -.5], [-.5, .5, -.5], [-.5, -.5, .5], [.5, -.5, .5], [.5, .5, .5], [-.5, .5, .5]];
    const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [2, 3, 7], [2, 7, 6], [1, 2, 6], [1, 6, 5], [0, 4, 7], [0, 7, 3]];
    const P = [];
    for (const t of f) for (const k of t) P.push(...v[k]);
    return P;
  }
  function sphereTris(seg = 18, rings = 12) {   // radius 1, outward winding
    const P = [], at = (i, j) => { const th = (j / rings) * Math.PI, ph = (i / seg) * Math.PI * 2; return [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)]; };
    for (let j = 0; j < rings; j++) for (let i = 0; i < seg; i++) {
      const a = at(i, j), b = at(i + 1, j), c = at(i + 1, j + 1), d = at(i, j + 1);
      if (j > 0) P.push(...a, ...b, ...c);
      if (j < rings - 1) P.push(...a, ...c, ...d);
    }
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

  // ---------- the weapon ----------
  // In your hand: a dark marble with a thin glowing disk around it.
  const def = {
    id: 'blackhole', name: 'Zwart gat', key: KEY, interval: INTERVAL, kick: 0.4,
    at: [0.2, -0.2, -0.45], aim: 1.2, roll: 0, muzzle: [0, 0.03, -0.02],
    build({ builder, mesh, colors }) {
      const { SKIN, SLEEVE } = colors;
      const b = builder(), K2 = C() && C().classes && C().classes();
      const col = K2 && K2.Color ? new K2.Color() : null;
      const L = [-0.35, 0.85, 0.4], ll = Math.hypot(...L);
      const tri = (a, c, d, hex, lit) => {
        if (!col) return;
        col.set(hex);
        const n = [(c[1] - a[1]) * (d[2] - a[2]) - (c[2] - a[2]) * (d[1] - a[1]), (c[2] - a[2]) * (d[0] - a[0]) - (c[0] - a[0]) * (d[2] - a[2]), (c[0] - a[0]) * (d[1] - a[1]) - (c[1] - a[1]) * (d[0] - a[0])];
        const nl = Math.hypot(...n) || 1, k = lit ? 1 : 0.35 + 0.65 * Math.abs((n[0] * L[0] + n[1] * L[1] + n[2] * L[2]) / nl / ll);
        for (const v of [a, c, d]) { b.P.push(...v); b.C.push(col.r * k, col.g * k, col.b * k); }
      };
      // the marble
      const S = sphereTris(10, 7), r = 0.028, cy = 0.03;
      for (let i = 0; i < S.length; i += 9) {
        const p = (k) => [S[i + k] * r, S[i + k + 1] * r + cy, S[i + k + 2] * r];
        tri(p(0), p(3), p(6), '#120c1a');
      }
      // the glowing disk around it (both sides), tilted a little
      const n = 20, r0 = 0.033, r1 = 0.05, tilt = 0.35;
      const T = (x, z) => [x, cy + z * Math.sin(tilt), z * Math.cos(tilt)];
      for (let i = 0; i < n; i++) {
        const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2, hex = i % 2 ? '#ffb347' : '#ff7a2a';
        const A = T(Math.cos(a0) * r0, Math.sin(a0) * r0), B = T(Math.cos(a1) * r0, Math.sin(a1) * r0), Cc = T(Math.cos(a1) * r1, Math.sin(a1) * r1), D = T(Math.cos(a0) * r1, Math.sin(a0) * r1);
        tri(A, B, Cc, hex, true); tri(A, Cc, D, hex, true); tri(A, Cc, B, hex, true); tri(A, D, Cc, hex, true);
      }
      b.box(0.002, -0.012, 0.01, 0.05, 0.04, 0.05, SKIN, -0.2);      // the hand under it
      b.box(0.01, -0.06, 0.09, 0.06, 0.065, 0.16, SLEEVE, 0.45);     // sleeve
      return { root: mesh(b), flash: mesh(builder()) };               // no muzzle flash
    },
    fire({ d, start }) { throwMarble(start, d); },
  };
  (window.scWalkWeapons = window.scWalkWeapons || []).push(def);

  // ---------- pools: one InstancedMesh per shape, slots handed out and given back ----------
  let K = null, scene = null, ready = false, sphereGeo = null;
  const pools = {};
  function noSnow(m) { m.defines = { ...(m.defines || {}), SNOW_COVER: '-0.50' }; return m; }   // (winter: no snow on our things)
  function makePool(name, tris, cap, lit, shadow) {
    const g = new K.Geometry();
    g.setAttribute('position', new K.Attr(new Float32Array(tris), 3));
    g.computeVertexNormals();
    const mat = lit && K.Lambert ? noSnow(new K.Lambert({ color: '#ffffff' })) : new K.Basic({ color: '#ffffff' });
    const mesh = new K.Instanced(g, mat, cap);
    mesh.frustumCulled = false; mesh.count = 0; mesh.name = 'sc-blackhole-' + name;
    mesh.castShadow = !!shadow; mesh.receiveShadow = !!lit;
    const w = new K.Color('#ffffff');
    for (let i = 0; i < cap; i++) mesh.setColorAt(i, w);
    mesh.instanceMatrix.array.fill(0);
    if (mesh.instanceMatrix.setUsage) mesh.instanceMatrix.setUsage(35048);
    scene.add(mesh);
    const free = [];
    for (let i = cap - 1; i >= 0; i--) free.push(i);
    return { mesh, cap, free, hi: 0, dirty: false, m: mesh.instanceMatrix.array, colors: new Map() };
  }
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
    pool.m.fill(0, i * 16, i * 16 + 16);
    pool.free.push(i);
    pool.dirty = true;
  }
  function put(pool, i, B, t, sx, sy, sz) { if (i < 0) return; writeM(pool.m, i * 16, B, t, sx, sy, sz); pool.dirty = true; }
  function hide(pool, i) { if (i < 0) return; pool.m.fill(0, i * 16, i * 16 + 16); pool.dirty = true; }
  function ensure() {
    if (ready) return true;
    const c = C();
    K = c && c.classes && c.classes();
    if (!K || !K.Instanced || !K.Geometry || !K.Attr || !K.Color || !K.Basic || !c.scene) return false;
    scene = c.scene;
    const box = boxTris();
    pools.box = makePool('box', box, CAP_BOXES, true, true);
    pools.blob = makePool('blob', blobTris(), CAP_BLOBS, true, false);
    pools.disk = makePool('disk', box, CAP_DISK, false, false);
    pools.dust = makePool('dust', box, CAP_DUST, true, false);
    sphereGeo = new K.Geometry();
    sphereGeo.setAttribute('position', new K.Attr(new Float32Array(sphereTris()), 3));
    sphereGeo.computeVertexNormals();
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
  // a ball: black, or a glowing shell (additive, back faces only: a rim around what's in front)
  function ball(hex, glow, opacity = 1) {
    const mat = new K.Basic({ color: hex });
    if (glow) { mat.transparent = true; mat.opacity = opacity; mat.blending = 2; mat.side = 1; mat.depthWrite = false; }
    const m = new K.Mesh(sphereGeo, mat);
    m.frustumCulled = false;
    if (glow) m.renderOrder = 2;
    return m;
  }

  // ---------- the thrown marble ----------
  const marbles = [];
  function throwMarble(start, d) {
    if (!ensure()) return;
    const core = ball('#140b1f'), rim = ball('#9b4dff', true, 0.9);
    core.scale.setScalar(0.012); rim.scale.setScalar(0.017);
    core.position.set(start.x, start.y, start.z); rim.position.copy(core.position);
    scene.add(core); scene.add(rim);
    marbles.push({ core, rim, p: { ...start }, v: { x: d.x * THROW_SPEED, y: d.y * THROW_SPEED + THROW_UP, z: d.z * THROW_SPEED }, t: 0 });
    whoosh();
  }
  function stepMarbles(dt) {
    const w = W();
    for (let k = marbles.length - 1; k >= 0; k--) {
      const g = marbles[k];
      g.t += dt;
      if (g.t >= FUSE) {
        g.core.removeFromParent(); g.rim.removeFromParent(); marbles.splice(k, 1);
        openHole(g.p);
        continue;
      }
      const onGround = g.p.y <= FLOOR + 0.0125;
      if (!onGround) g.v.y -= 3 * dt;
      else { const f = Math.exp(-1.8 * dt); g.v.x *= f; g.v.z *= f; }
      const len = Math.hypot(g.v.x, g.v.y, g.v.z) * dt;
      if (len > 1e-6 && w && w.rayBuildings) {                       // a wall in the way: bounce off it
        const d = { x: g.v.x * dt / len, y: g.v.y * dt / len, z: g.v.z * dt / len };
        const h = w.rayBuildings(g.p, d, len + 0.015);
        if (h && h.n) {
          const vn = g.v.x * h.n.x + g.v.y * h.n.y + g.v.z * h.n.z;
          if (vn < 0) { g.v.x -= 1.4 * vn * h.n.x; g.v.y -= 1.4 * vn * h.n.y; g.v.z -= 1.4 * vn * h.n.z; thud(); }
        }
      }
      g.p.x += g.v.x * dt; g.p.y += g.v.y * dt; g.p.z += g.v.z * dt;
      if (g.p.y < FLOOR + 0.012) {                                    // the ground: bounce, then roll
        g.p.y = FLOOR + 0.012;
        if (g.v.y < -0.3) thud();
        g.v.y = g.v.y < -0.3 ? -g.v.y * 0.35 : 0;
      }
      const pulse = 1 + 0.25 * Math.sin(g.t * (6 + g.t * 8));          // it pulses faster before it opens
      g.core.position.set(g.p.x, g.p.y, g.p.z); g.rim.position.copy(g.core.position);
      g.rim.scale.setScalar(0.017 * pulse);
    }
  }

  // ---------- the holes ----------
  const holes = [];
  function openHole(p) {
    while (holes.length >= MAX_HOLES) spit(holes[0]);
    const h = { x: p.x, z: p.z, y0: p.y, y: p.y, phase: 'rise', t: 0, r: 0, reach: 0, spin: rnd(0, Math.PI * 2), tilt: rnd(0.25, 0.45), tiltDir: rnd(0, Math.PI * 2),
      core: ball('#000000'), rim: ball('#c8561a', true, 0.75), halo: ball('#7a1f63', true, 0.3), disk: [], dust: [], swallowed: [], well: null, capAt: 0, sound: null };
    h.core.scale.setScalar(0.012);
    scene.add(h.core); scene.add(h.rim); scene.add(h.halo);
    // the accretion disk: streaks on circles in the disk's plane, faster further in
    for (let k = 0; k < DISK_BITS; k++) {
      const u = Math.pow(Math.random(), 1.6), rr = 1.35 + u * 3.4;
      const ci = Math.min(DISK_COLORS.length - 1, Math.floor(u * (DISK_COLORS.length - 0.2) + rnd(-0.6, 0.6)));
      h.disk.push({ slot: take(pools.disk, DISK_COLORS[Math.max(0, ci)]), rr, a: rnd(0, Math.PI * 2), y: rnd(-0.12, 0.12) * (0.3 + u), len: rnd(0.35, 0.8) * (0.6 + u * 0.6), thick: rnd(0.05, 0.11) });
    }
    holes.push(h);
    hum(h);
    crackle();
    return h;
  }
  // the disk's plane: tilted by h.tilt around a horizontal axis at h.tiltDir
  function diskBasis(h) { return mul(rotY(h.tiltDir), mul(rotM(1, 0, 0, h.tilt), rotY(-h.tiltDir))); }

  function stepHole(h, dt) {
    h.t += dt;
    if (h.phase === 'rise') {
      const u = clamp01(h.t / RISE), e = 1 - Math.pow(1 - u, 3);
      h.y = h.y0 + (HOVER - h.y0) * e;
      h.r = 0.012 * (1 + u * 0.5);
      if (u >= 1) { h.phase = 'live'; h.t = 0; startWell(h); }
    } else if (h.phase === 'live') {
      const g = clamp01(h.t / GROW);
      h.r = HOLE_R * (0.15 + 0.85 * (1 - Math.pow(1 - g, 3))) * (1 + 0.03 * Math.sin(h.t * 9));
      h.reach = REACH * Math.pow(clamp01(h.t / REACH_TIME), 0.8);
      if (h.t >= LIFE) { h.phase = 'collapse'; h.t = 0; howl(h); }
    } else if (h.phase === 'collapse') {
      const u = clamp01(h.t / COLLAPSE);
      h.r = HOLE_R * (1 - u * u) + 0.004;
      h.reach = REACH * (1 - u * 0.6);
      if (u >= 1) { spit(h); return; }
    }
    if (h.well) h.well.set({ x: h.x, y: h.y, z: h.z, radius: Math.max(0.3, h.reach), strength: PULL * (h.phase === 'collapse' ? 2.5 : 1), eat: Math.max(0.04, h.r * 0.8), peel: h.phase === 'live' ? BUILDING_PEEL : 0 });
    // the ball and its glow
    h.core.position.set(h.x, h.y, h.z); h.rim.position.copy(h.core.position); h.halo.position.copy(h.core.position);
    h.core.scale.setScalar(h.r); h.rim.scale.setScalar(h.r * 1.28); h.halo.scale.setScalar(h.r * (1.75 + 0.12 * Math.sin(h.t * 5)));
    drawDisk(h, dt);
    if (h.phase !== 'rise') { stepDust(h, dt); capture(h); dragPlayer(h, dt); }
    if (h.sound) h.sound.update(h);
  }
  function startWell(h) {
    const b = BLD();
    if (b && typeof b.well === 'function') h.well = b.well({ x: h.x, y: h.y, z: h.z, radius: 0.3, strength: PULL, eat: 0.05, peel: BUILDING_PEEL, swirl: SWIRL });
  }

  function drawDisk(h, dt) {
    const B = diskBasis(h), collapsing = h.phase === 'collapse' ? clamp01(h.t / COLLAPSE) : 0;
    const grow = h.phase === 'rise' ? 0 : clamp01(h.t / GROW + (h.phase === 'collapse' ? 1 : 0));
    for (const b of h.disk) {
      const rr = b.rr * (1 - collapsing * 0.75), R = Math.max(h.r, 0.02) * rr;
      b.a += dt * (2.6 / Math.pow(rr, 1.5)) * (1 + collapsing * 3);   // faster inside (and when it falls in)
      if (grow <= 0 || b.slot < 0) { hide(pools.disk, b.slot); continue; }
      const c = Math.cos(b.a), s = Math.sin(b.a);
      const p = apply(B, [c * R, b.y * Math.max(h.r, 0.02), s * R]);
      const orient = mul(B, rotY(-b.a));                                // the streak along its path
      const L = b.len * R * 0.6 * grow, T = b.thick * Math.max(h.r, 0.02) * 0.25 * grow;
      put(pools.disk, b.slot, orient, [h.x + p[0], h.y + p[1], h.z + p[2]], T, T * 0.6, L);
    }
  }

  // grit and dust from the ground, spiralling in (respawned while the hole lives)
  function stepDust(h, dt) {
    if (h.phase === 'live' && h.dust.length < DUST_BITS && h.reach > 0.2) {
      for (let n = 0; n < 3 && h.dust.length < DUST_BITS; n++) {
        const a = rnd(0, Math.PI * 2), r = h.reach * Math.sqrt(rnd(0.15, 1));
        const slot = take(pools.dust, DUST_COLORS[(Math.random() * DUST_COLORS.length) | 0]);
        if (slot < 0) break;
        h.dust.push({ slot, p: [h.x + Math.cos(a) * r, FLOOR + rnd(0, 0.02), h.z + Math.sin(a) * r], v: [0, rnd(0, 0.2), 0], s: rnd(0.004, 0.011), R: rotM(0, 1, 0, rnd(0, 6)), axis: [rnd(-1, 1), rnd(-1, 1), rnd(-1, 1)] });
      }
    }
    for (let k = h.dust.length - 1; k >= 0; k--) {
      const d = h.dust[k];
      const r = pullStep(h, d.p, d.v, dt, 1.4);
      if (r.eaten || r.d > h.reach * 1.3 + 0.3) { give(pools.dust, d.slot); h.dust.splice(k, 1); continue; }
      const al = Math.hypot(...d.axis) || 1;
      d.R = mul(rotM(d.axis[0] / al, d.axis[1] / al, d.axis[2] / al, dt * (3 + 10 * r.near)), d.R);
      const S = r.near > 0 ? stretchM(r.u, 1 + 3 * r.near, 1 / (1 + r.near), r.shrink) : null;
      put(pools.dust, d.slot, S ? mul(S, d.R) : d.R, d.p, d.s, d.s, d.s);
    }
  }

  // One step of the pull on a point p with velocity v (both changed): towards the hole, around it
  // (the spiral) and lifted to its height. Returns { d, u (unit towards the hole), near (0…1:
  // how stretched), shrink (size near the middle), eaten }.
  function pullStep(h, p, v, dt, mass = 1) {
    let dx = h.x - p[0], dy = h.y - p[1], dz = h.z - p[2], d = Math.hypot(dx, dy, dz) || 1e-6;
    const eat = Math.max(0.03, h.r * 0.75);
    const strength = PULL * (h.phase === 'collapse' ? 2.5 : 1) * mass;
    const a = Math.min(45, strength / Math.max(d * d, 0.004));
    const ux = dx / d, uy = dy / d, uz = dz / d, hh = Math.hypot(dx, dz) || 1, tx = -dz / hh, tz = dx / hh;
    // straight in: the pull; around: steered towards a speed below the orbit speed (√(a·d)), so
    // everything spirals in instead of being slung out
    v[0] += ux * a * dt; v[1] += uy * a * dt; v[2] += uz * a * dt;
    const vt = v[0] * tx + v[2] * tz, want = SWIRL * 0.7 * Math.sqrt(a * d), k = Math.min(1, 3 * dt) * (want - vt);
    v[0] += tx * k; v[2] += tz * k;
    const damp = Math.exp(-0.8 * dt); v[0] *= damp; v[1] *= damp; v[2] *= damp;
    const sp = Math.hypot(v[0], v[1], v[2]); if (sp > 7) { v[0] *= 7 / sp; v[1] *= 7 / sp; v[2] *= 7 / sp; }
    // passing through the middle in this step?
    const sx = v[0] * dt, sy = v[1] * dt, sz = v[2] * dt, ss = sx * sx + sy * sy + sz * sz;
    let eaten = d < eat;
    if (!eaten && ss > 1e-10) { const t = clamp01((dx * sx + dy * sy + dz * sz) / ss); eaten = Math.hypot(dx - sx * t, dy - sy * t, dz - sz * t) < eat; }
    p[0] += sx; p[1] += sy; p[2] += sz;
    if (p[1] < FLOOR + 0.004) { p[1] = FLOOR + 0.004; if (v[1] < 0) v[1] = 0; const f = Math.exp(-2 * dt); v[0] *= f; v[2] *= f; }
    dx = h.x - p[0]; dy = h.y - p[1]; dz = h.z - p[2]; d = Math.hypot(dx, dy, dz) || 1e-6;
    const near = clamp01(1 - d / 0.45);
    return { d, u: [dx / d, dy / d, dz / d], near: near * near, shrink: clamp01((d - eat * 0.5) / 0.2) * 0.85 + 0.15, eaten };
  }

  // ---------- taking things: people, officers, cars, props ----------
  const bodies = [];
  let lastScream = 0;
  function capture(h) {
    const now = performance.now();
    if (now - h.capAt < 100 || h.phase !== 'live') return;
    h.capAt = now;
    const res = RES(), w = W(), R = h.reach;
    // (nobody notices it: no alarm, people walk on until it has them)
    if (R < 0.05) return;
    let room = MAX_BODIES - bodies.length;
    // residents (also bodies lying in the street)
    if (res && res.people && room > 0) {
      const found = [];
      res.people.forEach((q) => {
        if (!q || q.state === 'inside' || q.state === 'gone') return;
        const d = Math.hypot(q.x - h.x, q.z - h.z);
        if (d <= R * rnd(0.85, 1)) found.push({ q, d });
      });
      found.sort((a, b) => a.d - b.d);
      for (const f of found.slice(0, Math.min(room, 8))) {
        const down = f.q.state === 'down';
        let info = null;
        try { info = res.skin(f.q, 'blackhole'); } catch (e) { console.warn('[blackhole] take', e); }
        if (info) { addPerson(h, info, down); room--; }
      }
    }
    // police officers
    const cops = COPS() && typeof COPS().officers === 'function' ? COPS().officers() : [];
    cops.forEach((c, i) => {
      if (room <= 0 || !c || c.state === 'gone') return;
      if (Math.hypot(c.x - h.x, c.z - h.z) > R) return;
      let info = null;
      try { info = COPS().skin(i, 'blackhole'); } catch (e) { /* not this one */ }
      if (info) { addPerson(h, info, false); room--; }
    });
    // traffic cars
    if (w && typeof w.trafficCars === 'function' && room > 0) {
      const list = w.trafficCars() || [];
      let proxies = null, batches = null;
      list.forEach((car, i) => {
        if (room <= 0 || !car || car.scTaken || car.scBurst || !Number.isFinite(car.x)) return;
        if (Math.hypot(car.x - h.x, car.z - h.z) > R * 0.85) return;
        if (!proxies) proxies = w.carObjects();
        const proxy = proxies.get(i); if (!proxy) return;
        if (!batches) { batches = []; w.scene.traverse((o) => { if (o.isInstancedMesh && Array.isArray(o.userData.cars)) batches.push(o); }); }
        const batch = batches.find((b) => b.userData.cars.includes(i)); if (!batch) return;
        addCar(h, car, proxy, batch); room--;
      });
    }
    // trees, lamps, benches, fountains
    if (w && typeof w.propsNear === 'function' && typeof w.takeProp === 'function' && room > 0) {
      for (const p of w.propsNear(h.x, h.z, R * 0.75)) {
        if (room <= 0) break;
        const t = w.takeProp(p);
        if (t) { addProp(h, t); room--; }
      }
    }
  }

  function addPerson(h, info, down) {
    const sc = (info.h || H_PERSON) / H_PERSON;
    const colors = info.colors || (info.cop ? COP_COLORS : { shirt: ANY_SHIRT[(Math.random() * ANY_SHIRT.length) | 0], trousers: '#2f4a7a', skin: '#eec4a2', hair: '#3d2a1c', bald: false });
    const th = typeof info.th === 'number' ? info.th : rnd(0, Math.PI * 2);
    const y = info.y || 0.036;
    const parts = [];
    for (const [kind, x, py, z, sx, sy, sz] of FIGURE) {
      if (kind === 'hair' && colors.bald) continue;
      const hex = kind === 'legs' ? colors.trousers : kind === 'shirt' ? colors.shirt : kind === 'skin' ? colors.skin : colors.hair;
      parts.push({ slot: take(pools.box, hex), o: [x * sc, (py - MID) * sc, z * sc], s: [sx * sc, sy * sc, sz * sc] });
    }
    let R0 = rotY(-th);
    let p = [info.x, y + MID * sc, info.z];
    if (down) { R0 = mul(R0, rotM(1, 0, 0, -Math.PI / 2)); p = [info.x, y + 0.012 * sc, info.z]; }
    const ax = [rnd(-1, 1), rnd(-0.4, 0.4), rnd(-1, 1)], al = Math.hypot(...ax) || 1;
    bodies.push({ kind: 'person', h, p, v: [0, 0.15, 0], R: R0, axis: ax.map((a) => a / al), w: rnd(0.5, 2), parts, sc, colors, mass: 1, screamed: false, cop: !!info.cop });
    if (Math.random() < 0.35 && performance.now() - lastScream > SCREAM_GAP * 1000) {
      lastScream = performance.now();
      const r = RES(); if (r && typeof r.screamAt === 'function') r.screamAt(info.x, info.z, undefined, false);
    }
  }

  const OFF_MAP = ['100000,100000', '100000,100001'];
  function addCar(h, car, proxy, batch) {
    car.scBurst = true; car.parked = Infinity; car.speed = 0;     // others leave it alone from now on
    proxy.updateWorldMatrix(true, false);
    const e = proxy.matrixWorld.elements;
    const sx = Math.hypot(e[0], e[1], e[2]) || 1, sy = Math.hypot(e[4], e[5], e[6]) || 1, sz = Math.hypot(e[8], e[9], e[10]) || 1;
    const R0 = [e[0] / sx, e[4] / sy, e[8] / sz, e[1] / sx, e[5] / sy, e[9] / sz, e[2] / sx, e[6] / sy, e[10] / sz];
    const obj = new K.Mesh(batch.geometry, batch.material);
    obj.matrixAutoUpdate = false; obj.castShadow = true; obj.frustumCulled = false;
    scene.add(obj);
    proxy.scale.setScalar(0.0001);                                // the app's car: gone
    const occupied = !car.scAbandoned && !car.isStatic;
    const c = [0, 0.03, 0], t = [e[12], e[13], e[14]], pc = apply(R0, c);
    // the traffic car itself leaves the roads (nothing queues behind an invisible car)
    Object.assign(car, { from: OFF_MAP[0], to: OFF_MAP[1], s: 0, lane: 1, prev: undefined, next: undefined, route: undefined, dest: undefined, side: undefined, passing: false, x: 100000, z: 100000 });
    bodies.push({ kind: 'car', h, p: [t[0] + pc[0], t[1] + pc[1], t[2] + pc[2]], v: [0, 0.1, 0], R: R0, axis: [rnd(-1, 1), rnd(-0.3, 0.3), rnd(-1, 1)].map((a, _, A) => a / (Math.hypot(...A) || 1)), w: rnd(0.3, 1), obj, c, sc: 1, mass: 0.55, occupied, police: !!(proxy.userData.car && proxy.userData.car.kind === 'police') });
    if (W() && W().sound) W().sound('thud');
  }
  function addProp(h, t) {
    const obj = t.obj;
    obj.updateMatrix(); obj.matrixAutoUpdate = false;
    const e = obj.matrix.elements;
    const R0 = [e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]];
    const c = [0, (t.h || 0.1) * 0.5, 0], pc = apply(R0, c);
    const ax = [rnd(-1, 1), rnd(-0.3, 0.3), rnd(-1, 1)], al = Math.hypot(...ax) || 1;
    bodies.push({ kind: 'prop', h, p: [e[12] + pc[0], e[13] + pc[1], e[14] + pc[2]], v: [0, 0.05, 0], R: R0, axis: ax.map((a) => a / al), w: rnd(0.2, 0.8), obj, c, sc: 1, mass: t.kind === 'bench' || t.kind === 'lamp' ? 0.8 : 0.6, prop: t.kind });
    if (W() && W().sound) W().sound('crack');
  }

  // every body: pulled in, tumbling faster, stretched near the middle; swallowed at the middle
  function stepBodies(dt) {
    const res = RES();
    for (let k = bodies.length - 1; k >= 0; k--) {
      const b = bodies[k], h = b.h;
      if (!holes.includes(h)) { bodies.splice(k, 1); continue; }   // (spat out already)
      const r = pullStep(h, b.p, b.v, dt, b.mass);
      if (r.eaten) { swallow(b); bodies.splice(k, 1); continue; }
      b.w = Math.min(22, b.w + dt * (1 + 8 * r.near));
      b.R = mul(rotM(b.axis[0], b.axis[1], b.axis[2], b.w * dt), b.R);
      const S = r.near > 0 || r.shrink < 1 ? stretchM(r.u, 1 + 6 * r.near, 1 / Math.sqrt(1 + 6 * r.near), r.shrink) : I3;
      const B = mul(S, b.R);
      if (b.kind === 'person') {
        for (const part of b.parts) {
          const o = apply(B, part.o);
          put(pools.box, part.slot, B, [b.p[0] + o[0], b.p[1] + o[1], b.p[2] + o[2]], part.s[0], part.s[1], part.s[2]);
        }
        if (res && typeof res.spatter === 'function' && Math.random() < 0.08 + 0.3 * r.near) res.spatter(b.p[0], b.p[1], b.p[2], b.v[0] * 0.2, b.v[2] * 0.2, 0.7, 0.15, 0.05);
        if (!b.screamed && r.near > 0.15) { b.screamed = true; if (performance.now() - lastScream > SCREAM_GAP * 1000) { lastScream = performance.now(); fallingScream(b.cop); } }
      } else {
        const off = apply(B, b.c);
        writeM(b.obj.matrix.elements, 0, B, [b.p[0] - off[0], b.p[1] - off[1], b.p[2] - off[2]]);
        b.obj.matrixWorldNeedsUpdate = true;
        if (b.kind === 'car' && Math.random() < 0.05) { const w = W(); if (w && w.spawn) w.spawn('spark', b.p[0], b.p[1], b.p[2], { vx: rnd(-0.3, 0.3), vy: rnd(-0.1, 0.3), vz: rnd(-0.3, 0.3), g: 1, size: 0.004, life: 0.3 }); }
      }
    }
  }
  // gone into the hole: hidden, remembered for the spit
  function swallow(b) {
    const h = b.h;
    if (b.kind === 'person') { for (const part of b.parts) give(pools.box, part.slot); b.parts = []; }
    else b.obj.visible = false;
    if (b.kind === 'car' && b.occupied) {
      const n = 1 + (Math.random() < 0.5 ? 1 : 0);
      for (let i = 0; i < n; i++) window.dispatchEvent(new CustomEvent('sc:kill', { detail: { x: h.x, z: h.z, cause: 'blackhole', who: 'occupant' } }));
    }
    h.swallowed.push(b);
    if (Math.random() < 0.5) slurp();
  }

  // you: dragged towards it while you're in reach (walls stop you; never right into it)
  function dragPlayer(h, dt) {
    const w = W();
    if (!PLAYER_PULL || !w || !w.walking || w.driving || h.phase === 'rise') return;
    const pl = w.player, dx = h.x - pl.x, dz = h.z - pl.z, d = Math.hypot(dx, dz);
    if (d > h.reach || d < PLAYER_STOP) return;
    const sp = PLAYER_PULL * Math.pow(1 - d / h.reach, 0.7) * dt, nx = pl.x + dx / d * sp, nz = pl.z + dz / d * sp;
    if (!w.blocked || !w.blocked(nx, nz)) w.moveTo(nx, nz);
  }

  // ---------- the end: everything back out ----------
  const gore = [];      // { items: [{ pool, slot, s }], p, v, R, axis, w, rest, t, flat }
  const flung = [];     // cars and props thrown out: { obj, p, v, R, axis, w, c, rest, t, burn, kind }
  function spit(h) {
    const i = holes.indexOf(h);
    if (i < 0) return;
    holes.splice(i, 1);
    const w = W(), res = RES(), c = C();
    // whatever was still on its way in goes out with the rest
    for (let k = bodies.length - 1; k >= 0; k--) if (bodies[k].h === h) { swallow(bodies[k]); bodies.splice(k, 1); }
    // the ball and its disk
    for (const m of [h.core, h.rim, h.halo]) m.removeFromParent();
    for (const b of h.disk) give(pools.disk, b.slot);
    for (const d of h.dust) give(pools.dust, d.slot);
    if (h.sound) h.sound.stop();
    // the buildings' chunks
    if (h.well) { try { h.well.spit(SPIT_SPEED); h.well.close(); } catch (e) { console.warn('[blackhole] well', e); } }
    // the blast
    bang();
    if (w && w.spawn) {
      w.spawn('flash', h.x, h.y, h.z, { size: 0.7, life: 0.35, grow: 2.5 });
      for (let k = 0; k < 40; k++) { const a = rnd(0, Math.PI * 2), sp = rnd(0.8, 2.6), up = rnd(-0.3, 1); w.spawn('spark', h.x, h.y, h.z, { color: k % 3 ? '#ffb347' : '#c98bff', vx: Math.cos(a) * sp, vy: up * sp, vz: Math.sin(a) * sp, g: 1.5, size: 0.006, life: rnd(0.4, 0.9) }); }
      for (let k = 0; k < 30; k++) { const a = rnd(0, Math.PI * 2), sp = rnd(0.6, 1.8); w.spawn('fire', h.x, h.y, h.z, { vx: Math.cos(a) * sp, vy: rnd(-0.2, 0.8), vz: Math.sin(a) * sp, g: 0.8, size: rnd(0.03, 0.06), life: rnd(0.3, 0.6) }); }
      if (w.startEffects) w.startEffects();
    }
    if (c && c.smoke) for (let k = 0; k < 36; k++) {                // a ring of dust rolling out over the ground
      const a = (k / 36) * Math.PI * 2 + rnd(-0.08, 0.08), sp = rnd(1, 2);
      c.smoke('dust', h.x + Math.cos(a) * 0.1, FLOOR + 0.03, h.z + Math.sin(a) * 0.1, { vx: Math.cos(a) * sp, vy: rnd(0, 0.1), vz: Math.sin(a) * sp, rise: 0.02, drag: 1.2, flat: 1.8, size: rnd(0.08, 0.14), grow: 5, life: rnd(3, 5), alpha: 0.7 });
    }
    if (c && typeof c.damage === 'function') { try { c.damage({ kind: 'blast', x: h.x, y: h.y, z: h.z, radius: 0.35, n: null, source: 'blackhole' }); } catch (e) { /* nothing to break */ } }
    if (w && typeof w.blastResidents === 'function') w.blastResidents(h.x, h.z, 0.25, h.y);
    else if (res && res.blast) res.blast(h.x, h.z, 0.6, 2.5, 10, 0.25);
    // what it swallowed
    for (const b of h.swallowed) {
      if (b.kind === 'person') goreOut(h, b);
      else fling(h, b);
    }
    h.swallowed = [];
  }
  function outward(speed) {   // a direction on the upper side of a sphere, mostly outwards, × speed
    const a = rnd(0, Math.PI * 2), up = rnd(-0.1, 0.8), r = Math.sqrt(1 - up * up), sp = speed * rnd(0.35, 1);
    return [Math.cos(a) * r * sp, up * sp + rnd(0.3, 0.9), Math.sin(a) * r * sp];
  }
  // a person comes back as a mangled heap: flesh, a shoe, rags of their clothes, now and then a head
  function goreOut(h, b) {
    const sc = b.sc || 1, col = b.colors, pieces = [];
    const add = (pool, hex, s) => { const slot = take(pools[pool], hex); if (slot >= 0) pieces.push({ pool, slot, s: s.map((x) => x * sc) }); };
    for (let n = 0; n < 3; n++) { const s = rnd(0.012, 0.024); add('blob', FLESH[(Math.random() * FLESH.length) | 0], [s, s * rnd(0.6, 1), s * rnd(0.7, 1.3)]); }
    add('box', '#1d1a18', [0.011, 0.007, 0.02]);                        // one shoe
    add('box', col.shirt, [rnd(0.02, 0.03), 0.004, rnd(0.015, 0.025)]);  // rags
    add('box', col.trousers, [rnd(0.012, 0.02), 0.004, rnd(0.025, 0.035)]);
    if (Math.random() < 0.3) add('box', col.skin, [0.022, 0.022, 0.022]);  // a head
    for (const piece of pieces) {
      const ax = [rnd(-1, 1), rnd(-1, 1), rnd(-1, 1)], al = Math.hypot(...ax) || 1;
      gore.push({ ...piece, p: [h.x + rnd(-0.02, 0.02), h.y + rnd(-0.02, 0.02), h.z + rnd(-0.02, 0.02)], v: outward(SPIT_SPEED), R: rotY(rnd(0, 6)), axis: ax.map((a) => a / al), w: rnd(6, 16), rest: false, t: 0, delay: rnd(0, 0.12) });
    }
  }
  // a car or prop comes back: thrown out, tumbling; cars burnt and burning
  function fling(h, b) {
    const obj = b.obj;
    obj.visible = true;
    if (b.kind === 'car') {
      const mat = Array.isArray(obj.material) ? obj.material[0] : obj.material;
      if (mat && mat.clone) { const m = mat.clone(); if (m.color) m.color.set('#3a3431'); obj.material = m; }
      window.dispatchEvent(new CustomEvent('sc:car-exploded', { detail: { x: h.x, z: h.z, police: !!b.police } }));
    }
    const ax = [rnd(-1, 1), rnd(-1, 1), rnd(-1, 1)], al = Math.hypot(...ax) || 1;
    flung.push({ kind: b.kind, obj, c: b.c, p: [h.x, h.y, h.z], v: outward(SPIT_SPEED * (b.kind === 'car' ? 0.7 : 0.85)), R: b.R, axis: ax.map((a) => a / al), w: rnd(4, 10),
      k: b.kind === 'car' ? rnd(0.7, 0.9) : rnd(0.75, 1), rest: false, t: 0, burn: b.kind === 'car' ? BURN_TIME : 0, fireAt: 0 });
  }
  function stepGore(dt) {
    const res = RES();
    for (let k = gore.length - 1; k >= 0; k--) {
      const g = gore[k];
      if (g.delay > 0) { g.delay -= dt; hide(pools[g.pool], g.slot); continue; }
      g.t += dt;
      if (!g.rest) {
        g.v[1] -= 3 * dt;
        for (let a = 0; a < 3; a++) g.p[a] += g.v[a] * dt;
        g.R = mul(rotM(g.axis[0], g.axis[1], g.axis[2], g.w * dt), g.R);
        if (Math.random() < 0.15 && res && res.spatter) res.spatter(g.p[0], g.p[1], g.p[2], 0, 0, 0.5, 0.05, 0);
        const floor = FLOOR + g.s[1] * 0.3;
        if (g.p[1] <= floor) {                                       // splat
          g.p[1] = floor; g.rest = true;
          g.R = rotY(rnd(0, 6));
          if (res && res.spatter) res.spatter(g.p[0], g.p[1] + 0.01, g.p[2], g.v[0], g.v[2], 3, 0.3, 0.15);
          if (Math.random() < 0.3) splat();
        }
      }
      const fade = g.t > GORE_TIME ? clamp01(1 - (g.t - GORE_TIME) / GORE_FADE) : 1;
      const flat = g.rest && g.pool === 'blob' ? 0.4 : 1;
      put(pools[g.pool], g.slot, g.R, g.p, g.s[0] * fade, g.s[1] * fade * flat, g.s[2] * fade);
      if (fade <= 0) { give(pools[g.pool], g.slot); gore.splice(k, 1); }
    }
  }
  function stepFlung(dt) {
    const w = W();
    for (let k = flung.length - 1; k >= 0; k--) {
      const f = flung[k];
      f.t += dt;
      if (!f.rest) {
        f.v[1] -= 3 * dt;
        for (let a = 0; a < 3; a++) f.p[a] += f.v[a] * dt;
        f.R = mul(rotM(f.axis[0], f.axis[1], f.axis[2], f.w * dt), f.R);
        const floor = FLOOR + (f.c[1] || 0.03) * f.k * 0.6;
        if (f.p[1] <= floor) {
          f.p[1] = floor;
          if (f.v[1] < -0.6) { f.v[1] = -f.v[1] * 0.25; f.v[0] *= 0.5; f.v[2] *= 0.5; f.w *= 0.4; if (w && w.sound) w.sound(f.kind === 'car' ? 'boom' : 'thud'); }
          else { f.rest = true; }
        }
      }
      const B = f.k === 1 ? f.R : mul([f.k, 0, 0, 0, f.k, 0, 0, 0, f.k], f.R), off = apply(B, f.c);
      writeM(f.obj.matrix.elements, 0, B, [f.p[0] - off[0], f.p[1] - off[1], f.p[2] - off[2]]);
      f.obj.matrixWorldNeedsUpdate = true;
      if (f.burn > 0 && w && w.spawn) {                               // a burning shell
        f.burn -= dt; f.fireAt -= dt;
        if (f.fireAt <= 0) {
          f.fireAt = 0.08;
          w.spawn('fire', f.p[0] + rnd(-0.05, 0.05), f.p[1] + 0.03, f.p[2] + rnd(-0.05, 0.05), { vx: rnd(-0.1, 0.1), vy: rnd(0.3, 0.7), vz: rnd(-0.1, 0.1), g: -0.2, size: rnd(0.02, 0.045), life: rnd(0.3, 0.6) });
          if (Math.random() < 0.35 && w.blackSmoke) w.blackSmoke(f.p[0], f.p[1] + 0.06, f.p[2], { vy: rnd(0.3, 0.6), rise: rnd(0.3, 0.5), size: rnd(0.05, 0.09), life: rnd(3, 6) });
          if (w.startEffects) w.startEffects();
        }
      }
      if (f.kind === 'car' && f.t > WRECK_TIME) { f.obj.removeFromParent(); flung.splice(k, 1); continue; }
      if (f.rest && f.burn <= 0 && f.kind !== 'car') flung.splice(k, 1);   // props just lie there now
    }
  }

  // ---------- the frame ----------
  function step(dt) {
    dt = Math.min(dt || 0, 0.05);
    if (!ready) return;
    if (marbles.length) stepMarbles(dt);
    for (const h of holes.slice()) stepHole(h, dt);
    if (bodies.length) stepBodies(dt);
    if (gore.length) stepGore(dt);
    if (flung.length) stepFlung(dt);
    flush();
  }

  // ---------- sounds (through the core's output: follows the sound button) ----------
  function audio() { const c = C(); return c && c.audio && c.out ? c : null; }
  let noiseBuf = null;
  function noise(a, loop) {
    if (!noiseBuf || noiseBuf.sampleRate !== a.sampleRate) {
      noiseBuf = a.createBuffer(1, a.sampleRate, a.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const s = a.createBufferSource(); s.buffer = noiseBuf; s.loop = !!loop; return s;
  }
  function whoosh() {
    const c = audio(); if (!c) return;
    try {
      const a = c.audio(), t = a.currentTime, n = noise(a), f = a.createBiquadFilter(), g = a.createGain();
      f.type = 'bandpass'; f.Q.value = 1.5; f.frequency.setValueAtTime(500, t); f.frequency.exponentialRampToValueAtTime(1500, t + 0.3);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(VOLUME * 0.5, t + 0.08); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.33);
      n.connect(f); f.connect(g); g.connect(c.out(a)); n.start(t); n.stop(t + 0.35);
    } catch (e) { /* no sound */ }
  }
  let lastThud = 0;
  function thud() {
    const c = audio(), now = performance.now(); if (!c || now - lastThud < 80) return; lastThud = now;
    try {
      const a = c.audio(), t = a.currentTime, o = a.createOscillator(), g = a.createGain();
      o.type = 'sine'; o.frequency.setValueAtTime(300, t); o.frequency.exponentialRampToValueAtTime(120, t + 0.06);
      g.gain.setValueAtTime(VOLUME * 0.5, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
      o.connect(g); g.connect(c.out(a)); o.start(t); o.stop(t + 0.1);
    } catch (e) { /* no sound */ }
  }
  function crackle() {   // the marble opening: an electric crackle and a falling sweep
    const c = audio(); if (!c) return;
    try {
      const a = c.audio(), t = a.currentTime, n = noise(a), f = a.createBiquadFilter(), g = a.createGain(), o = a.createOscillator(), og = a.createGain();
      f.type = 'highpass'; f.frequency.value = 2500;
      g.gain.setValueAtTime(VOLUME * 0.5, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
      n.connect(f); f.connect(g); g.connect(c.out(a)); n.start(t); n.stop(t + 0.5);
      o.type = 'sawtooth'; o.frequency.setValueAtTime(900, t); o.frequency.exponentialRampToValueAtTime(40, t + 1.2);
      og.gain.setValueAtTime(VOLUME * 0.3, t); og.gain.exponentialRampToValueAtTime(0.0001, t + 1.2);
      o.connect(og); og.connect(c.out(a)); o.start(t); o.stop(t + 1.25);
    } catch (e) { /* no sound */ }
  }
  // the hole's drone: two low detuned saws and roaring noise, louder and higher as it grows
  function hum(h) {
    const c = audio(); if (!c) return;
    try {
      const a = c.audio(), t = a.currentTime, out = c.out(a), g = a.createGain(), f = a.createBiquadFilter();
      const o1 = a.createOscillator(), o2 = a.createOscillator(), n = noise(a, true), nf = a.createBiquadFilter(), ng = a.createGain();
      o1.type = 'sawtooth'; o2.type = 'sawtooth'; o1.frequency.value = 36; o2.frequency.value = 36 * 1.51;
      f.type = 'lowpass'; f.frequency.value = 180; f.Q.value = 4;
      nf.type = 'bandpass'; nf.frequency.value = 300; nf.Q.value = 0.8; ng.gain.value = 0.6;
      o1.connect(f); o2.connect(f); n.connect(nf); nf.connect(ng); ng.connect(f); f.connect(g); g.connect(out);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(VOLUME * 0.9, t + RISE + GROW);
      for (const s of [o1, o2, n]) s.start(t);
      h.sound = {
        update(hh) {
          const u = hh.phase === 'live' ? clamp01(hh.t / LIFE) : hh.phase === 'collapse' ? 1 : 0, now = a.currentTime;
          f.frequency.setTargetAtTime(180 + 500 * u + (hh.phase === 'collapse' ? 2500 * clamp01(hh.t / COLLAPSE) : 0), now, 0.1);
          o1.frequency.setTargetAtTime(36 + 30 * u, now, 0.2); o2.frequency.setTargetAtTime((36 + 30 * u) * 1.51, now, 0.2);
          nf.frequency.setTargetAtTime(300 + 1200 * u, now, 0.2);
        },
        stop() { const now = a.currentTime; g.gain.cancelScheduledValues(now); g.gain.setValueAtTime(Math.max(0.0001, g.gain.value), now); g.gain.exponentialRampToValueAtTime(0.0001, now + 0.08); for (const s of [o1, o2, n]) s.stop(now + 0.1); },
      };
    } catch (e) { h.sound = null; }
  }
  function howl(h) {   // collapsing: a rising, sucking howl
    const c = audio(); if (!c) return;
    try {
      const a = c.audio(), t = a.currentTime, n = noise(a), f = a.createBiquadFilter(), g = a.createGain();
      f.type = 'bandpass'; f.Q.value = 3; f.frequency.setValueAtTime(200, t); f.frequency.exponentialRampToValueAtTime(4000, t + COLLAPSE);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(VOLUME * 1.2, t + COLLAPSE * 0.95); g.gain.exponentialRampToValueAtTime(0.0001, t + COLLAPSE + 0.05);
      n.connect(f); f.connect(g); g.connect(c.out(a)); n.start(t); n.stop(t + COLLAPSE + 0.1);
    } catch (e) { /* no sound */ }
    void h;
  }
  function bang() {
    const w = W(); if (w && w.sound) w.sound('boom');
    const c = audio(); if (!c) return;
    try {
      const a = c.audio(), t = a.currentTime, n = noise(a), f = a.createBiquadFilter(), g = a.createGain(), o = a.createOscillator(), og = a.createGain();
      f.type = 'lowpass'; f.frequency.setValueAtTime(3000, t); f.frequency.exponentialRampToValueAtTime(80, t + 1.6);
      g.gain.setValueAtTime(VOLUME * 2, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.8);
      n.connect(f); f.connect(g); g.connect(c.out(a)); n.start(t); n.stop(t + 1.8);
      o.type = 'sine'; o.frequency.setValueAtTime(90, t); o.frequency.exponentialRampToValueAtTime(28, t + 0.9);
      og.gain.setValueAtTime(VOLUME * 2, t); og.gain.exponentialRampToValueAtTime(0.0001, t + 1);
      o.connect(og); og.connect(c.out(a)); o.start(t); o.stop(t + 1.05);
    } catch (e) { /* no sound */ }
  }
  // someone near the horizon: a scream that drops lower and lower as they're stretched
  function fallingScream(cop) {
    const c = audio(); if (!c) return;
    try {
      const a = c.audio(), t = a.currentTime, o = a.createOscillator(), f = a.createBiquadFilter(), g = a.createGain(), lfo = a.createOscillator(), lg = a.createGain();
      const f0 = (cop ? 380 : 520) * rnd(0.85, 1.25), len = rnd(0.8, 1.3);
      o.type = 'sawtooth'; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f0 * 0.18, t + len);
      lfo.frequency.value = 7; lg.gain.value = f0 * 0.03; lfo.connect(lg); lg.connect(o.frequency);
      f.type = 'bandpass'; f.frequency.setValueAtTime(1600, t); f.frequency.exponentialRampToValueAtTime(400, t + len); f.Q.value = 2;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(VOLUME * 0.45, t + 0.05); g.gain.exponentialRampToValueAtTime(0.0001, t + len);
      o.connect(f); f.connect(g); g.connect(c.out(a)); o.start(t); o.stop(t + len + 0.05); lfo.start(t); lfo.stop(t + len + 0.05);
    } catch (e) { /* no sound */ }
  }
  let lastSlurp = 0;
  function slurp() {
    const c = audio(), now = performance.now(); if (!c || now - lastSlurp < 120) return; lastSlurp = now;
    try {
      const a = c.audio(), t = a.currentTime, o = a.createOscillator(), g = a.createGain();
      o.type = 'sine'; o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(900, t + 0.12);
      g.gain.setValueAtTime(VOLUME * 0.35, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
      o.connect(g); g.connect(c.out(a)); o.start(t); o.stop(t + 0.15);
    } catch (e) { /* no sound */ }
  }
  let lastSplat = 0;
  function splat() {
    const c = audio(), now = performance.now(); if (!c || now - lastSplat < 70) return; lastSplat = now;
    try {
      const a = c.audio(), t = a.currentTime, n = noise(a), f = a.createBiquadFilter(), g = a.createGain();
      f.type = 'lowpass'; f.frequency.setValueAtTime(1200, t); f.frequency.exponentialRampToValueAtTime(200, t + 0.15);
      g.gain.setValueAtTime(VOLUME * 0.6, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      n.connect(f); f.connect(g); g.connect(c.out(a)); n.start(t); n.stop(t + 0.2);
    } catch (e) { /* no sound */ }
  }

  // test hooks (by hand in the console, headless runs): open(x, z) opens a hole there at once;
  // throw(start, dir) throws a marble as the weapon does; collapse() ends the oldest hole now
  window.scBlackhole = {
    open: (x, z) => (ensure() ? !!openHole({ x, y: FLOOR + 0.012, z }) : false),
    throw: (start, d) => throwMarble(start, d),
    collapse() { const h = holes[0]; if (h && h.phase !== 'collapse') { h.phase = 'collapse'; h.t = 0; howl(h); } },
    get holes() { return holes.map((h) => ({ x: h.x, y: h.y, z: h.z, phase: h.phase, t: h.t, r: h.r, reach: h.reach, swallowed: h.swallowed.length, chunks: h.well ? h.well.eaten : 0 })); },
    get bodies() { return bodies.length; },
    bodyInfo: () => bodies.map((b) => ({ kind: b.kind, d: +Math.hypot(b.p[0] - b.h.x, b.p[1] - b.h.y, b.p[2] - b.h.z).toFixed(3), y: +b.p[1].toFixed(3), v: +Math.hypot(...b.v).toFixed(2) })), get gore() { return gore.length; }, get flung() { return flung.length; },
  };
})();
