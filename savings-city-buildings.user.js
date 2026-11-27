// ==UserScript==
// @name         Savings City – solid buildings
// @namespace    savings-city-tweaks
// @version      1.9
// @description  Shared building destruction for the Savings City scripts: buildings turn into solid chunks (facade outside, concrete inside) that can be blasted into craters, collapse from an impact or be pushed over. Used by the rocket launcher, the monster and the nuke. Needs the core script.
// @match        https://your-savings-city-host.example/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * Needs savings-city-core (window.scCore): the scene, three.js classes, the frame loop, dust
 * (scCore.smoke) and the damage bus. Uses walk mode (window.scWalk) when it's there, for its sounds.
 *
 * How a building breaks
 * ---------------------
 * - Every building is a group with userData.projectId holding one indexed facade mesh: boxes
 *   ("masses", one per tier: four walls and a flat top). readMasses() reads them back, with the
 *   facade's texture mapping (windows) and colours per wall.
 * - prepare(building) cuts every box into convex chunks about CHUNK_SIZE big, bigger for big
 *   buildings so there are never many more than MAX_CHUNKS (random, slightly tilted planes; in
 *   slabs). The cutting runs in a Web Worker made from this script's own code (cutterCore), so the
 *   page never waits for it; the page only gets the finished arrays and makes one mesh of them.
 *   Where no worker can be made, the same code runs on the page in slices of a few ms. A hit or
 *   collapse that arrives before the cut is done waits for it (the building stays as it is until
 *   then; the cut is moved to the front). Outside faces keep the facade, inside faces are broken
 *   grey concrete (concreteOf: a hint of the wall's colour). All chunks go into one mesh with the facade material; every
 *   chunk keeps its own range of vertices.
 * - swapIn: the chunks are shown and the building's own triangles are hidden (collapsed to a point
 *   in the city-block meshes the app draws, kept hidden when the app redraws a block).
 * - expect(point, radius, { dir, prio }): a hit is coming (the rocket launcher calls it when it
 *   fires, and while you aim). The building is cut (if it wasn't yet) and the chunks around the aim
 *   point are cut again, much smaller (FINE_SIZE): only within FINE_REACH crater radii, only on the
 *   side facing the shooter (FINE_DEPTH deep) and at most FINE_MAX pieces (× detail), nearest
 *   first – a crater of many small pieces, the rest stays light. The fine pieces go into a mesh of
 *   their own; the coarse chunks they replace are collapsed. A spot is cut finer once. A hit only
 *   waits for the coarse cut, never for the finer one: if that's not back yet, the crater is made of
 *   the coarse chunks (and the finer pieces of chunks that already flew are dropped).
 * - crater(): chunks near a point fly out. hit() = a crater that counts; after HITS_TO_COLLAPSE
 *   the building comes down.
 * - Local collapse (settle, after every crater): what isn't held up any more falls. The pieces form
 *   a graph (boxes that touch); a piece's cost is the cheapest path of still pieces to the ground,
 *   each step costing how far it goes sideways. A piece whose cost grew by more than SUPPORT_SPAN
 *   since the building was intact (or that has no path left) falls, onto the floor below if that
 *   still stands: the facade above a wide hole comes down in a V, slabs around a shot-away core
 *   drop. With less than a third left standing, the rest comes down too.
 * - ray(o, d, maxT): the nearest still chunk along a ray; walk mode uses it for buildings shown as
 *   chunks (covers(id)), so shots and rockets go through holes and hit what's inside.
 * - collapse(building, opts) in two styles:
 *     from an impact (opts.at, opts.out): the floor there fails first, the failure spreads, what's
 *       above drops and leans towards the hole, the floors below pancake;
 *     pushed (opts.push = direction, opts.force, opts.spread): a crack runs from opts.at through the
 *       building and the chunks are thrown the push's way (upper floors more) – a monster's punch.
 *   Either way a jagged stump stays, dust rolls out, people inside and right next to it die
 *   (residents' crush, sc:crush), and walk mode rebuilds its walls (sc:geometry-changed).
 * - Chunk physics: gravity, tumbling, landing on the ground, tipping onto the largest face, rest.
 *
 * - Two building models (the setting "Gebouwen bij vernielen", read when a building is first cut):
 *     solid ("Massief"): every box is one solid block, cut into chunks (as above);
 *     shell ("Vloeren en muren"): every box is built of storeys (SHELL_STOREY, the app's floor
 *       height): four outer walls (SHELL_WALL thick; facade outside, white-grey plaster inside, a
 *       ceiling and a floor of wood, concrete or tiles: insides()) standing on a
 *       floor slab (SHELL_SLAB) that spans the whole footprint (its edge shows on the facade),
 *       and a concrete core in wide buildings. Only these plates are cut, so a building is hollow:
 *       a crater shows the floors inside, and the rubble is broken slabs and wall panels. Pieces
 *       follow the plates' area, not the volume (budget MAX_CHUNKS, like the solid model).
 *       Rubble of shell buildings piles up: a piece lands on the pieces that already lie still
 *       (a height grid of PILE_CELL), at most PILE_MAX (5 m) high, and what lay on a piece that's
 *       taken away drops. When it comes down, the storeys give way from the top as the rubble
 *       reaches them, and jagged wall stumps (up to SHELL_STUMP) stay standing.
 *
 * - Gravity wells (the black hole): well({ x, y, z, radius, strength, eat, peel }) pulls every
 *   flying chunk within `radius` towards its middle on a swirl (lifted against gravity, stretched
 *   along the pull and shrinking near the middle), and peels chunks off the buildings in reach –
 *   the near side first – until a building has lost PEEL_COLLAPSE of them and the rest comes down
 *   towards the well. Chunks that reach `eat` are swallowed (hidden, kept); spit(speed) throws
 *   them all back out, smaller and tumbling, and close() ends the pull.
 *
 * For other scripts: window.scBuildings (see the end of this file), and the damage bus:
 *   scCore.damage({ kind: 'blast', x, y, z, n, radius }) → crater + a hit on the building there
 *   scCore.damage({ kind: 'push', x, y, z, dir, power }) → the building there is pushed over
 * The nuke uses the low-level parts (geometry, chunkSet, launch) for its own planning, and
 * blastWave() for buildings that were already broken into chunks before it went off.
 */
(function () {
  'use strict';

  // ---- settings (tiles; 1 tile ≈ 20 m) ----
  const CHUNK_SIZE = 0.2;          // buildings are cut into chunks about this big (smaller = finer holes, but much heavier)…
  const MAX_CHUNKS = 800;          // …but never into more than about this many: big buildings get bigger chunks
  const CUT_SLICE_MS = 8;          // without a worker: cutting runs on the page in slices this long, between frames
  const USE_WORKER = true;         // cut in a Web Worker (off the page's thread); falls back to slices if one can't be made
  const FINE_SIZE = 0.1;           // where a rocket is about to hit, chunks are cut again this small (÷ ∛detail factor)…
  const FINE_REACH = 1.4;          // …within this many crater radii of the aim point…
  const FINE_DEPTH = 0.9;          // …only on the side facing the shooter: at most this many crater radii deep…
  const FINE_MAX = 200;            // …and at most this many fine pieces per spot (× detail factor), the nearest chunks first
  const RUBBLE_AVOID_SECONDS = 120;// residents stay away from a collapsed building this long
  const HITS_TO_COLLAPSE = 7;      // blasts (rockets) a building takes before it comes down
  const HOLE_RADIUS = 0.16;        // default crater radius
  const STUMP = 0.12;              // a jagged stump up to this high stays
  const COLLAPSE_SPREAD = 2.5;     // tiles per second: how fast the failure spreads from the impact
  const COLLAPSE_LEAN = 0.6;       // how hard the part above the impact tips over towards the hole
  const DUST = 1;                  // amount of dust when a building comes down
  const GROUND = 0.04;             // chunks come to rest on this height
  const PEEL_COLLAPSE = 0.3;       // a well that has peeled this share of a building's chunks brings the rest down
  // the shell model (setting "Gebouwen bij vernielen" → "Vloeren en muren")
  const SHELL_STOREY = 0.22;       // storey height (the app's floor height: the window rows)
  const SHELL_WALL = 0.025;        // outer wall thickness (≈ 0.5 m: thicker than real, so it shows)
  const SHELL_SLAB = 0.025;        // floor slab thickness
  const SHELL_CORE = 0.6;          // footprints at least this wide (both ways) get a concrete core (stairs, lifts)…
  const SHELL_CORE_SIZE = 0.16;    // …this wide (at most a quarter of the footprint)
  const SHELL_CHUNK = 0.16;        // shell pieces are about this big (the plates are thin: more of them fit the budget)…
  const SHELL_PIECES_PER_AREA = 2.8; // …measured: shatter makes about this × area ÷ size² pieces of the plates (2.2–3)
  const SHELL_STUMP = 0.3;         // a collapse leaves jagged wall stumps up to this high
  const PILE_CELL = 0.04;          // rubble piles: grid cell (tiles)
  const PILE_MAX = 0.25;           // rubble heaps rise to at most this high (≈ 5 m; 1 tile ≈ 20 m): the more rubble, the nearer
  const SUPPORT_SPAN = 0.2;        // local collapse: a part holds this much further (tiles) from what carries it than before the hit (≈ 4 m)…
  const SUPPORT_SLACK = 0.06;      // …and a piece on top of another may sit this far off its middle for free
  // -------------------------------------------

  const rnd = (a, b) => a + Math.random() * (b - a);
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const C = () => window.scCore;
  const W = () => window.scWalk;
  const JF = [0.04, 0.96];         // the facade texture's plain spot
  let K = null;
  const classes = () => K || (K = C() && C().classes());
  const scene = () => C() && C().scene;
  const isFacade = (m) => !!(m && m.map && typeof m.customProgramCacheKey === 'function' && m.customProgramCacheKey() === 'facade');

  // ---------- sound and dust (the core's solid puffs; walk mode's sounds) ----------
  function sound(kind) { const w = W(); if (w && w.sound) w.sound(kind); }
  // opts as the core's smoke: vx, vy, vz, size, life, rise, drag, flat, grow, alpha, delay
  function dust(x, y, z, o) {
    const c = C(); if (!c) return;
    if (c.smoke) { c.smoke('dust', x, y, z, o); return; }
    c.puff(x, y, z, { vx: o.vx, vy: o.vy, vz: o.vz, size: (o.size || 0.1) * 2.2, life: Math.min(6, o.life || 3), delay: o.delay });   // (core older than 1.3)
  }

  // ---------- chunk sets: many pieces in one mesh, each moving on its own ----------
  // pieces: [{ tris: [[{p, n, c, uv} ×3], …], normal?: largest face's normal, …extra }]; the extra
  // fields are kept on the chunk (the nuke uses d, still, dark). Returns { mesh, g, pos, nor, col, frs }.
  const sets = new Set();
  function* buildSet(pieces, material, opts = {}) {
    if (!classes()) throw new Error('[buildings] the scene is not ready yet');
    const total = pieces.reduce((s, p) => s + p.tris.length * 3, 0);
    const g = new K.Geometry();
    const attr = (w) => { const at = new K.Attr(new Float32Array(Math.max(3, total) * w), w); if (at.setUsage) at.setUsage(35048); return at; };
    g.setAttribute('position', attr(3)); g.setAttribute('normal', attr(3)); g.setAttribute('color', attr(3)); g.setAttribute('uv', attr(2));
    const P = g.attributes.position, N = g.attributes.normal, Co = g.attributes.color, U = g.attributes.uv;
    const frs = [];
    let k = 0;
    for (const pc of pieces) {
      let px = 0, py = 0, pz = 0, m = 0;
      for (const t of pc.tris) for (const v of t) { px += v.p[0]; py += v.p[1]; pz += v.p[2]; m++; }
      const pivot = [px / m, py / m, pz / m];
      const { tris, normal, ...extra } = pc;
      const fr = { ...extra, start: k, count: m, pivot, normal: normal || [0, -1, 0], orig: new Float32Array(m * 3), n0: new Float32Array(m * 3), state: 'still' };
      let q = 0;
      for (const t of tris) for (const v of t) {
        P.setXYZ(k, v.p[0], v.p[1], v.p[2]); N.setXYZ(k, v.n[0], v.n[1], v.n[2]); Co.setXYZ(k, v.c[0], v.c[1], v.c[2]); U.setXY(k, v.uv[0], v.uv[1]);
        fr.orig.set([v.p[0] - pivot[0], v.p[1] - pivot[1], v.p[2] - pivot[2]], q * 3); fr.n0.set(v.n, q * 3);
        k++; q++;
      }
      frs.push(fr);
      if (opts.release) pc.tris = null;                            // big sets (the nuke): free the triangles as we go
      if (frs.length % 200 === 0) yield;
    }
    g.setDrawRange(0, total);
    return addSet(g, frs, material, opts);
  }
  function addSet(g, frs, material, opts) {
    const mesh = new K.Mesh(g, material);
    mesh.castShadow = mesh.receiveShadow = true; mesh.frustumCulled = false; mesh.userData.scSolid = true;
    mesh.visible = !opts.hidden;
    (opts.parent || scene()).add(mesh);
    const set = { mesh, g, pos: g.attributes.position, nor: g.attributes.normal, col: g.attributes.color, frs, active: false, dusty: !!opts.dusty, piles: !!opts.piles, center: opts.center || null, st: opts.st || null };
    sets.add(set);
    return set;
  }
  function chunkSet(pieces, material, opts) { const gen = buildSet(pieces, material, opts); let r; do { r = gen.next(); } while (!r.done); return r.value; }
  // A chunk set from the cutter's flat arrays (see pack() in cutterCore): no work per vertex here.
  // A hidden one is drawn with nothing (draw range 0) instead of being invisible, so its buffers
  // already go to the GPU now and not in the frame of the first hit.
  function packedSet(d, material, opts = {}) {
    const g = new K.Geometry();
    const attr = (a, w) => { const at = new K.Attr(a, w); if (at.setUsage) at.setUsage(35048); return at; };
    g.setAttribute('position', attr(d.pos, 3)); g.setAttribute('normal', attr(d.nor, 3)); g.setAttribute('color', new K.Attr(d.col, 3)); g.setAttribute('uv', new K.Attr(d.uv, 2));
    const frs = [], M = d.meta;
    for (let i = 0; i < d.P; i++) {
      const o = i * 14, start = M[o], count = M[o + 1];
      frs.push({ start, count, pivot: [M[o + 2], M[o + 3], M[o + 4]], normal: [M[o + 5], M[o + 6], M[o + 7]], lo: [M[o + 8], M[o + 9], M[o + 10]], hi: [M[o + 11], M[o + 12], M[o + 13]],
        orig: d.orig.subarray(start * 3, (start + count) * 3), n0: d.n0.subarray(start * 3, (start + count) * 3), state: 'still', idx: d.src ? d.src[i] : i, fine: !!d.src,
        kind: d.kind ? d.kind[i] : 0 });
    }
    const total = d.pos.length / 3;
    g.setDrawRange(0, opts.hidden ? 0 : total);
    const set = addSet(g, frs, material, { ...opts, hidden: false });
    set.total = total;
    return set;
  }
  function showSet(set) { if (set.total !== undefined) set.g.setDrawRange(0, set.total); set.mesh.visible = true; }
  // a chunk starts moving: velocity v, after `delay` seconds, tumbling at `spin` rad/s; `slide`:
  // it keeps more of its speed when it lands and slides on (a blast wave)
  function launch(set, fr, v, delay = 0, spin = rnd(1, 5), slide = false) {
    if (fr.stamp) unstamp(fr);                                     // rubble that's taken away: what lay on it drops
    fr.floorY = undefined; fr.holder = null;
    if (fr.carried) {                                              // a piece that goes: what lay on it drops too
      const list = fr.carried; fr.carried = null;
      for (const c of list) if (c.fr.holder === fr && (c.fr.state === 'rest' || c.fr.state === 'flying')) drop(c.set, c.fr);
    }
    let ax = rnd(-1, 1), ay = rnd(-0.5, 0.5), az = rnd(-1, 1); const al = Math.hypot(ax, ay, az) || 1;
    Object.assign(fr, { state: 'flying', v, delay, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], off: [0, 0, 0], axis: [ax / al, ay / al, az / al], w: spin, landed: false, age: 0, slide });
    set.active = true;
  }
  // a piece that loses what it lay on falls from where it is (no push)
  function drop(set, fr) {
    const lying = { off: fr.off, R: fr.R };
    launch(set, fr, [0, 0, 0], 0, 0.5);
    Object.assign(fr, lying);
    if (set.st) landOn(set.st, set, fr);
  }
  function stepSets(dt) {
    if (!dt) return;
    for (const set of sets) {
      if (!set.active) continue;
      let lo = Infinity, hi = -1, busy = false;
      for (const fr of set.frs) {
        if (fr.state !== 'flying') continue;
        busy = true;
        if (fr.delay > 0) { fr.delay -= dt; continue; }
        fr.age += dt;
        if (wells.size && pull(fr, dt)) { lo = Math.min(lo, fr.start); hi = Math.max(hi, fr.start + fr.count); continue; }
        fr.v[1] -= 6 * dt * (fr.lift ? 1 - fr.lift : 1);             // gravity (less inside a well)
        for (let a = 0; a < 3; a++) fr.off[a] += fr.v[a] * dt;
        if (!fr.landed) fr.R = mul(rot(...fr.axis, fr.w * dt), fr.R);   // tumbling through the air
        else {
          // on the ground: tip over until it lies on its largest face
          const [x, y, z] = fr.normal, R = fr.R;
          const n = [R[0] * x + R[1] * y + R[2] * z, R[3] * x + R[4] * y + R[5] * z, R[6] * x + R[7] * y + R[8] * z];
          const tilt = Math.acos(Math.min(1, Math.max(-1, -n[1])));
          fr.flat = tilt < 0.35;
          if (tilt > 0.01) { let ax = n[2], az = -n[0]; let l = Math.hypot(ax, az); if (l < 1e-6) { ax = 1; az = 0; l = 1; } fr.R = mul(rot(ax / l, 0, az / l, Math.min(tilt, 6 * dt)), R); }
          const f = Math.exp(-(fr.slide ? 2 : 5) * dt); fr.v[0] *= f; fr.v[2] *= f;
          if ((tilt <= 0.01 && Math.hypot(fr.v[0], fr.v[2]) < 0.05) || fr.age > 12) fr.state = 'rest';
        }
        const before = fr.bb ? fr.bb[4] : Infinity;                 // its lowest point last step
        let minY = writeChunk(set, fr);
        let floor = set.piles ? pileHeight(fr) : GROUND;            // the shell model's rubble piles up
        if (fr.floorY > floor) floor = fr.floorY;                   // it falls onto a floor that still stands (local collapse)
        // already below the heap's surface (the heap grew around it, or it tipped into it): it stays
        // in the heap where it is instead of jumping up out of it
        if (minY < floor && before < floor - 0.02) floor = Math.max(fr.floorY ?? GROUND, Math.min(floor, before));
        if (minY < floor) {
          fr.off[1] += floor - minY;
          if (!fr.landed) {
            fr.landed = true;
            // a puff of dust where debris of a collapsing building hits the ground, pushed outwards
            if (set.dusty && set.down && DUST > 0 && Math.random() < 0.3 * DUST) {
              const x = fr.pivot[0] + fr.off[0], z = fr.pivot[2] + fr.off[2], c = set.center || [x, z];
              let dx = x - c[0], dz = z - c[1]; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
              dust(x, 0.06, z, { vx: dx * rnd(0.3, 0.9) + fr.v[0] * 0.3, vy: rnd(0.02, 0.15), vz: dz * rnd(0.3, 0.9) + fr.v[2] * 0.3, rise: 0.03, drag: 0.6, flat: 1.5, size: rnd(0.08, 0.16), grow: rnd(4, 7), life: rnd(6, 10), alpha: 0.7 });
            }
            const keep = fr.slide ? 0.7 : 0.4; fr.v[0] *= keep; fr.v[2] *= keep;
          }
          fr.v[1] = Math.max(0, fr.v[1]) * 0.1;
          minY = writeChunk(set, fr);
        }
        // lying (nearly) still and (nearly) flat: other rubble lands on it from now on
        if (set.piles && fr.landed && !fr.stamp && !(fr.floorY > GROUND + 0.01) && (fr.state === 'rest' || (fr.flat && Math.hypot(fr.v[0], fr.v[2]) < 0.25))) stamp(set, fr);
        lo = Math.min(lo, fr.start); hi = Math.max(hi, fr.start + fr.count);
      }
      // upload only the part that moved (add ranges; never clear them first – see CONTEXT.md)
      if (hi > 0) for (const a of [set.pos, set.nor]) { if (a.addUpdateRange) a.addUpdateRange(lo * 3, (hi - lo) * 3); a.needsUpdate = true; }
      if (!busy) set.active = false;
    }
  }
  // returns the lowest point; fr.bb = [x0, z0, x1, z1, y0, y1] (where it is now)
  function writeChunk(set, fr) {
    const { orig, n0, R, pivot, off } = fr, pos = set.pos, nor = set.nor;
    // a chunk in a well: smaller (fr.scale) and stretched along the pull (fr.stretch: [dx, dy, dz, along, across])
    const sc = fr.scale ?? 1, st = fr.stretch;
    let minY = Infinity, maxY = -Infinity, x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let n = 0, k = fr.start; n < fr.count; n++, k++) {
      const a = orig[n * 3] * sc, b = orig[n * 3 + 1] * sc, c = orig[n * 3 + 2] * sc;
      let rx = R[0] * a + R[1] * b + R[2] * c, ry = R[3] * a + R[4] * b + R[5] * c, rz = R[6] * a + R[7] * b + R[8] * c;
      if (st) { const u = (rx * st[0] + ry * st[1] + rz * st[2]) * (st[3] - st[4]); rx = rx * st[4] + st[0] * u; ry = ry * st[4] + st[1] * u; rz = rz * st[4] + st[2] * u; }
      const px = pivot[0] + off[0] + rx, py = pivot[1] + off[1] + ry, pz = pivot[2] + off[2] + rz;
      pos.setXYZ(k, px, py, pz);
      const p = n0[n * 3], q = n0[n * 3 + 1], r = n0[n * 3 + 2];
      nor.setXYZ(k, R[0] * p + R[1] * q + R[2] * r, R[3] * p + R[4] * q + R[5] * r, R[6] * p + R[7] * q + R[8] * r);
      if (py < minY) minY = py; if (py > maxY) maxY = py;
      if (px < x0) x0 = px; if (px > x1) x1 = px; if (pz < z0) z0 = pz; if (pz > z1) z1 = pz;
    }
    const bb = fr.bb || (fr.bb = [0, 0, 0, 0, 0, 0]);
    bb[0] = x0; bb[1] = z0; bb[2] = x1; bb[3] = z1; bb[4] = minY; bb[5] = maxY;
    return minY;
  }

  // ---------- rubble piles (shell model) ----------
  // A height grid of PILE_CELL cells. A piece that lies (nearly) still adds its thickness × PILE_BULK
  // (the gaps between pieces) to the cells under the middle of its footprint; a falling piece
  // lands on the cells under it: halfway between their average and the highest (not counting its
  // own share; on the highest alone, heaps grew like towers), flattened by heap(): it rises with
  // the amount of rubble towards PILE_MAX (5 m) but never above it. A piece that's already below
  // the surface (the heap grew around it) stays where it is instead of jumping up out of it. A piece that's taken away again (launch,
  // a well) takes its share out of the grid, and what lay on it drops.
  const pile = new Map();          // cell → { h (height above GROUND), list: [{ fr, set, add, bottom }] }
  const PILE_INSET = 0.2;          // only the middle of a piece's footprint counts (corners of tilted pieces would make spikes)
  const PILE_BULK = 1.2;           // a heap is this much higher than its pieces' thickness added up
  function pileCells(bb, fn) {
    const ix = (bb[2] - bb[0]) * PILE_INSET, iz = (bb[3] - bb[1]) * PILE_INSET;
    const i0 = Math.floor((bb[0] + ix) / PILE_CELL), i1 = Math.floor((bb[2] - ix) / PILE_CELL);
    const j0 = Math.floor((bb[1] + iz) / PILE_CELL), j1 = Math.floor((bb[3] - iz) / PILE_CELL);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) fn((i + 50000) * 100000 + (j + 50000));
  }
  // a heap's height from the rubble added up: it rises with the amount but never above PILE_MAX
  const heap = (h) => PILE_MAX * (1 - Math.exp(-Math.max(0, h) / PILE_MAX));
  function pileHeight(fr) {
    if (!pile.size || !fr.bb) return GROUND;
    let hi = 0, sum = 0, n = 0;
    pileCells(fr.bb, (key) => {
      n++;
      const c = pile.get(key); if (!c) return;
      const t = fr.stamp && fr.stamp.has(key) ? c.h - fr.stampAdd : c.h;   // without its own share
      sum += t; if (t > hi) hi = t;
    });
    return GROUND + (n ? heap((hi + sum / n) / 2) : 0);
  }
  // a piece's thickness: its thinnest side (the plates: the wall or slab thickness)
  const thickness = (fr) => (fr.lo ? Math.max(0.01, Math.min(fr.hi[0] - fr.lo[0], fr.hi[1] - fr.lo[1], fr.hi[2] - fr.lo[2])) : 0.03);
  function stamp(set, fr) {
    const bb = fr.bb; if (!bb) return;
    const add = thickness(fr) * PILE_BULK, e = { fr, set, bottom: bb[4] };
    fr.stamp = new Set(); fr.stampAdd = add;
    pileCells(bb, (key) => {
      let c = pile.get(key); if (!c) pile.set(key, (c = { h: 0, list: [] }));
      c.h += add; c.list.push(e); fr.stamp.add(key);
    });
  }
  function unstamp(fr) {
    const keys = fr.stamp; fr.stamp = null;
    const drop = new Set();
    for (const key of keys) {
      const c = pile.get(key); if (!c) continue;
      c.list = c.list.filter((e) => e.fr !== fr); c.h -= fr.stampAdd;
      if (!c.list.length || c.h < 1e-4) { pile.delete(key); c.h = 0; }
      // what lay on it (higher up than what's left here) loses its footing
      for (const e of c.list) if (e.bottom > GROUND + heap(c.h - e.fr.stampAdd) + 0.01) drop.add(e);
    }
    for (const e of drop) if (e.fr.stamp) { const lying = { off: e.fr.off, R: e.fr.R }; launch(e.set, e.fr, [0, 0, 0], 0, 0.5); Object.assign(e.fr, lying); }
  }

  // ---------- gravity wells (the black hole) ----------
  // A well pulls flying chunks in (and lifts them), peels chunks off buildings in reach, swallows
  // what reaches its middle and can spit it all back out.
  const wells = new Set();
  function well(o = {}) {
    const w = { x: o.x || 0, y: o.y ?? 0.2, z: o.z || 0, radius: o.radius ?? 1, strength: o.strength ?? 1.2, eat: o.eat ?? 0.04, peel: o.peel ?? 1.5,
      swirl: o.swirl ?? 0.7, eaten: [], near: [], nearAt: -1, open: true };
    wells.add(w);
    return {
      get x() { return w.x; }, get eaten() { return w.eaten.length; },
      set(p) { for (const k of ['x', 'y', 'z', 'radius', 'strength', 'eat', 'peel', 'swirl']) if (p[k] !== undefined) w[k] = p[k]; },
      // everything it swallowed flies back out from its middle (speed: tiles/s); returns how many
      spit(speed = 3) { return spitOut(w, speed); },
      close() { w.open = false; wells.delete(w); for (const set of sets) for (const fr of set.frs) if (fr.well === w && fr.state === 'flying') { fr.lift = 0; fr.stretch = null; fr.well = null; } },
    };
  }
  // one chunk's step in the wells' pull; true when it was swallowed
  function pull(fr, dt) {
    const sc = fr.scale ?? 1, x = fr.pivot[0] + fr.off[0], y = fr.pivot[1] + fr.off[1], z = fr.pivot[2] + fr.off[2];
    let caught = false;
    for (const w of wells) {
      const dx = w.x - x, dy = w.y - y, dz = w.z - z, d = Math.hypot(dx, dy, dz);
      if (d > w.radius * 1.2) continue;
      caught = true; fr.well = w; fr.landed = false;
      if (fr.stamp) unstamp(fr);
      if (d < w.eat + 0.02 * sc) { swallow(fr, w); return true; }
      const a = Math.min(40, w.strength / Math.max(d * d, 0.004)), ux = dx / d, uy = dy / d, uz = dz / d;
      const h = Math.hypot(dx, dz) || 1, tx = -dz / h, tz = dx / h;     // around the well (one way)
      // straight in: the pull; around: steered towards a speed below the orbit speed (√(a·d)), so
      // chunks spiral in instead of being slung out
      fr.v[0] += ux * a * dt; fr.v[1] += uy * a * dt; fr.v[2] += uz * a * dt;
      const vt = fr.v[0] * tx + fr.v[2] * tz, k = Math.min(1, 3 * dt) * (w.swirl * 0.7 * Math.sqrt(a * d) - vt);
      fr.v[0] += tx * k; fr.v[2] += tz * k;
      const damp = Math.exp(-0.8 * dt); fr.v[0] *= damp; fr.v[1] *= damp; fr.v[2] *= damp;
      const sp = Math.hypot(...fr.v); if (sp > 7) for (let k = 0; k < 3; k++) fr.v[k] *= 7 / sp;
      fr.lift = clamp01(1.4 - d / w.radius);
      fr.w = Math.min(25, (fr.w || 2) + dt * 6);                            // spinning faster on the way in
      // spaghetti: stretched along the pull, thinner across, and smaller near the middle
      const near = clamp01(1 - d / 0.4);
      fr.stretch = near > 0 ? [ux, uy, uz, 1 + 4 * near * near, 1 / Math.sqrt(1 + 4 * near * near)] : null;
      fr.scale = Math.min(fr.scale ?? 1, clamp01(d / 0.15) * 0.9 + 0.1);
      // does this step pass through the middle? (fast chunks)
      const vx = fr.v[0] * dt, vy = fr.v[1] * dt, vz = fr.v[2] * dt, vv = vx * vx + vy * vy + vz * vz;
      if (vv > 1e-9) { const t = clamp01((dx * vx + dy * vy + dz * vz) / vv); if (Math.hypot(dx - vx * t, dy - vy * t, dz - vz * t) < w.eat) { swallow(fr, w); return true; } }
      break;
    }
    if (!caught && fr.lift) { fr.lift = 0; fr.stretch = null; }
    return false;
  }
  function swallow(fr, w) {
    fr.state = 'eaten'; fr.well = w; fr.stretch = null; fr.scale = 0;
    fr.off = [w.x - fr.pivot[0], w.y - fr.pivot[1], w.z - fr.pivot[2]];
    for (const set of sets) if (set.frs.includes(fr)) { writeChunk(set, fr); w.eaten.push({ set, fr }); break; }
  }
  function spitOut(w, speed) {
    const list = w.eaten; w.eaten = [];
    for (const { set, fr } of list) {
      if (fr.state !== 'eaten') continue;
      // a direction on the upper side of a sphere, mostly outwards
      const a = Math.random() * Math.PI * 2, up = rnd(-0.15, 0.85), r = Math.sqrt(1 - up * up), sp = speed * rnd(0.35, 1.1);
      launch(set, fr, [Math.cos(a) * r * sp, up * sp + rnd(0.3, 1), Math.sin(a) * r * sp], rnd(0, 0.15), rnd(4, 14), true);
      fr.off = [w.x - fr.pivot[0], w.y - fr.pivot[1], w.z - fr.pivot[2]];
      fr.scale = rnd(0.45, 0.95); fr.stretch = null; fr.lift = 0; fr.well = null;
      const t = rnd(0, Math.PI * 2), c = Math.cos(t), s = Math.sin(t);
      fr.R = mul(rot(...fr.axis, rnd(0, 6)), [c, 0, s, 0, 1, 0, -s, 0, c]);
    }
    return list.length;
  }
  // every frame: wells peel chunks off the buildings in reach (near side first)
  function stepWells(dt) {
    const now = performance.now();
    for (const w of wells) {
      if (!w.open || !(w.peel > 0)) continue;
      if (now - w.nearAt > 400) {                                    // buildings in reach (cut them as soon as they are)
        w.nearAt = now;
        w.near = list().filter((bd) => Math.hypot(Math.max(bd.x0 - w.x, 0, w.x - bd.x1), Math.max(bd.z0 - w.z, 0, w.z - bd.z1)) < w.radius);
        for (const bd of w.near) { const st = prepare(bd, PRIO.fire); if (st) hurry(st); }
        // rubble lying around in reach goes too
        for (const st of solids.values()) if (st.down && st.sets && st.bd && !w.near.includes(st.bd)
          && Math.hypot(Math.max(st.bd.x0 - w.x, 0, w.x - st.bd.x1), Math.max(st.bd.z0 - w.z, 0, w.z - st.bd.z1)) < w.radius) w.near.push(st.bd);
      }
      for (const bd of w.near) {
        const st = solids.get(bd.id);
        if (!st || st.claimed || !st.ready) continue;
        let peeled = 0, total = 0;
        for (const set of st.sets) for (const fr of set.frs) {
          if (fr.state === 'gone') continue;
          total++;
          if (fr.state !== 'still' && fr.state !== 'rest') { peeled++; continue; }
          const cx = fr.pivot[0] + (fr.off ? fr.off[0] : 0), cy = fr.pivot[1] + (fr.off ? fr.off[1] : 0), cz = fr.pivot[2] + (fr.off ? fr.off[2] : 0);
          const d = Math.hypot(cx - w.x, (cy - w.y) * 0.7, cz - w.z);
          if (d > w.radius) continue;
          const f = 1 - d / w.radius;
          if (Math.random() > w.peel * dt * f * f * (fr.state === 'rest' ? 3 : 1)) continue;
          if (!st.shown) swapIn(st);
          const l = d || 1, lying = fr.state === 'rest' ? { off: fr.off, R: fr.R } : null;
          launch(set, fr, [(w.x - cx) / l * 0.3 + rnd(-0.1, 0.1), rnd(0.1, 0.4), (w.z - cz) / l * 0.3 + rnd(-0.1, 0.1)], 0, rnd(1, 4));
          if (lying) Object.assign(fr, lying);                       // rubble starts from where it lies
          if (fr.state === 'flying' && st.down) set.down = true;
          peeled++;
        }
        if (!st.down && total && peeled / total >= PEEL_COLLAPSE) {
          // what's left comes down towards the well
          const px = Math.max(bd.x0, Math.min(bd.x1, w.x)), pz = Math.max(bd.z0, Math.min(bd.z1, w.z));
          collapse(bd, { at: { x: px, y: Math.min(bd.top, w.y), z: pz }, push: { x: w.x - bd.cx, z: w.z - bd.cz }, force: 1.2, spread: 3 });
        }
      }
    }
  }

  // ---------- the buildings ----------
  // bd = { id, grp, mesh, boxes, x0, x1, z0, z1, top, cx, cz } (world coordinates)
  const solids = new Map();        // projectId → { bd, hits, ready, gen, set, shown, down, wave } (or { claimed: true } – the nuke's)
  const outlines = [];
  let outlinesAt = -1e9;
  function intact() {
    const now = performance.now();
    if (now - outlinesAt < 2000) return outlines;
    outlinesAt = now; outlines.length = 0;
    const sc = scene(); if (!sc) return outlines;
    sc.traverse((o) => {
      if (!o.isMesh || o.isInstancedMesh || !o.geometry || !o.geometry.index) return;
      if (!isFacade(Array.isArray(o.material) ? o.material[0] : o.material)) return;
      let grp = null; for (let p = o; p && !grp; p = p.parent) if (p.userData && p.userData.projectId !== undefined) grp = p;
      if (!grp || solids.has(grp.userData.projectId)) return;
      const boxes = massesOf(o); if (!boxes.length) return;
      const x0 = Math.min(...boxes.map((b) => b.x0)), x1 = Math.max(...boxes.map((b) => b.x1)), z0 = Math.min(...boxes.map((b) => b.z0)), z1 = Math.max(...boxes.map((b) => b.z1));
      outlines.push({ id: grp.userData.projectId, grp, mesh: o, boxes, x0, x1, z0, z1, top: Math.max(...boxes.map((b) => b.y1)), cx: (x0 + x1) / 2, cz: (z0 + z1) / 2 });
    });
    return outlines;
  }
  const massCache = new WeakMap();
  function massesOf(mesh) { if (!massCache.has(mesh)) massCache.set(mesh, readMasses(mesh)); return massCache.get(mesh); }
  // every building still standing: intact ones and ones in chunks that haven't come down
  function list() {
    const out = intact().filter((bd) => !solids.has(bd.id));
    for (const st of solids.values()) if (st.bd && !st.down) out.push(st.bd);
    return out;
  }
  const byId = (x) => (x && typeof x === 'object' ? x : list().find((bd) => bd.id === x) || (solids.get(x) && solids.get(x).bd) || null);
  // the building at point p (on or in it; `slack` tiles of room)
  function at(p, slack = 0.03) {
    const e = slack;
    for (const st of solids.values()) { const bd = st.bd; if (bd && !st.down && p.x >= bd.x0 - e && p.x <= bd.x1 + e && p.z >= bd.z0 - e && p.z <= bd.z1 + e && p.y <= bd.top + e) return bd; }
    for (const bd of intact()) if (bd.boxes.some((b) => p.x >= b.x0 - e && p.x <= b.x1 + e && p.z >= b.z0 - e && p.z <= b.z1 + e && p.y >= b.y0 - e && p.y <= b.y1 + e)) return bd;
    return null;
  }
  // buildings standing within r of (x, z) (footprint distance)
  function near(x, z, r) {
    return list().filter((bd) => Math.hypot(Math.max(bd.x0 - x, 0, x - bd.x1), Math.max(bd.z0 - z, 0, z - bd.z1)) <= r);
  }

  // ---- cutting a building into chunks: in a Web Worker, or in time slices on the page ----
  // Chunk size for a building: CHUNK_SIZE, or bigger so there are about MAX_CHUNKS at most
  // (measured: shatter makes about 7.7 × volume / size³ pieces – it cuts until every side is short).
  // The detail setting (core: 1 … 5) multiplies the number of chunks by 1, 2, 4, 8, 16.
  // The shell model cuts plates: about SHELL_PIECES_PER_AREA × area ÷ size² pieces (walls, slabs,
  // core), so its size follows the area (and the detail factor divides it by √factor).
  function chunkSizeFor(bd, shell = false) {
    const f = C() && C().detail ? C().detail().factor : 1;
    if (shell) {
      const area = bd.boxes.reduce((a, b) => a + shellArea(b), 0);
      return Math.max(SHELL_CHUNK / Math.sqrt(f), Math.sqrt((SHELL_PIECES_PER_AREA * area) / (MAX_CHUNKS * f)));
    }
    const volume = bd.boxes.reduce((v, b) => v + (b.x1 - b.x0) * (b.y1 - b.y0) * (b.z1 - b.z0), 0);
    return Math.max(CHUNK_SIZE / Math.cbrt(f), Math.cbrt((7.7 * volume) / (MAX_CHUNKS * f)));
  }
  // the plates of one box in the shell model (one side of each): walls, slabs, core
  function shellArea(b) {
    const w = b.x1 - b.x0, d = b.z1 - b.z0, h = b.y1 - b.y0, storeys = Math.max(1, Math.round(h / SHELL_STOREY));
    const core = w >= SHELL_CORE && d >= SHELL_CORE ? 4 * Math.min(SHELL_CORE_SIZE, w / 4, d / 4) * h : 0;
    return 2 * (w + d) * h + storeys * w * d + core;
  }
  const shellSpec = () => ({ kind: 'shell', storey: SHELL_STOREY, wall: SHELL_WALL, slab: SHELL_SLAB, core: SHELL_CORE, coreSize: SHELL_CORE_SIZE, piecesPerArea: SHELL_PIECES_PER_AREA });
  // the building model the setting asks for: true = shell (floors and walls)
  const shellModel = () => !!(C() && C().settings && C().settings.get('buildingModel') === 1);
  // The cutter: cutterCore (at the end of this file) runs in a worker made from its own source
  // text; the page only sends the boxes and gets finished arrays back. If no worker can be made
  // (or it fails), the same code runs here, in slices between frames. send(msg) → Promise(reply).
  let cutter = null;
  function getCutter() {
    if (cutter) return cutter;
    const waiting = new Map();                                     // job → { msg, resolve }
    let seq = 0, port = null, mode = '';
    const receive = (m) => { if (m && m.op === 'ready') return; const w = waiting.get(m.job); if (w) { waiting.delete(m.job); w.resolve(m); } };
    const local = () => {
      mode = 'page';
      const fake = { postMessage: (m) => receive(m) };
      cutterCore(fake, CUT_SLICE_MS);
      return { postMessage: (m) => fake.onmessage({ data: m }) };
    };
    const fallBack = (why) => {
      if (mode === 'page') return;
      console.warn('[buildings] no worker for cutting (' + why + '): cutting on the page instead');
      try { port && port.terminate && port.terminate(); } catch {}
      port = local();
      for (const w of [...waiting.values()].sort((x, y) => x.msg.job - y.msg.job)) port.postMessage(w.msg);   // again, in order
    };
    if (USE_WORKER && typeof Worker === 'function') {
      try {
        const src = '(' + cutterCore.toString() + ')(self, 40);';
        const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
        mode = 'worker'; port = w;
        let alive = false;
        w.onmessage = (e) => { alive = true; receive(e.data); };
        w.onerror = (e) => { e.preventDefault && e.preventDefault(); fallBack(e.message || 'error'); };
        setTimeout(() => { if (!alive) fallBack('no answer'); }, 4000);
      } catch (e) { port = null; }
    }
    if (!port) port = local();
    cutter = {
      get mode() { return mode; },
      send(msg) { msg.job = ++seq; return new Promise((resolve) => { waiting.set(msg.job, { msg, resolve }); port.postMessage(msg); }); },
      post(msg) { port.postMessage(msg); },                         // no answer expected
    };
    return cutter;
  }
  // the boxes as plain data (no functions, no links between them) for the worker
  const plainBoxes = (boxes) => boxes.map((b) => ({ x0: b.x0, x1: b.x1, y0: b.y0, y1: b.y1, z0: b.z0, z1: b.z1, roof: b.roof, wallColor: b.wallColor,
    walls: b.walls.map((w) => ({ ax: w.ax, along: w.along, sign: w.sign, at: w.at, s0: w.s0, s1: w.s1, y0: w.y0, y1: w.y1, c: w.c, ua: w.ua, sa: w.sa, du: w.du, va: w.va, ya: w.ya, dv: w.dv })) }));
  const PRIO = { aim: 1, fire: 2 };                                // what the cutter does first: what a rocket is about to hit
  const facadeMat = (bd) => (Array.isArray(bd.mesh.material) ? bd.mesh.material[0] : bd.mesh.material);
  // hits and collapses that waited for the cut
  function runPending(st) {
    const todo = st.pending; st.pending = [];
    for (const fn of todo) { try { fn(); } catch (e) { console.warn('[buildings] pending', e); } }
  }
  // The coarse cut isn't there yet: what's waiting for it goes first.
  const busy = (st) => !st.ready;
  function hurry(st) { if (!st.hurried && !st.ready) { st.hurried = true; getCutter().post({ op: 'prio', b: st.bd.id, prio: PRIO.fire }); } }

  // start cutting a building (in the background); returns its state
  function prepare(x, prio = PRIO.aim) {
    const bd = byId(x);
    if (!bd || !classes()) return null;
    if (solids.has(bd.id)) return solids.get(bd.id);
    const shell = shellModel();
    const st = { bd, hits: 0, ready: false, set: null, sets: [], shown: false, down: false, wave: null, pending: [], spots: [], refining: 0, shell, size: chunkSizeFor(bd, shell), t0: performance.now() };
    solids.set(bd.id, st);
    const model = shell ? shellSpec() : null;
    getCutter().send({ op: 'cut', b: bd.id, boxes: plainBoxes(bd.boxes), size: st.size, model, prio }).then((m) => {
      try {
        st.set = packedSet(m.data, facadeMat(bd), { hidden: true, dusty: true, piles: shell, center: [bd.cx, bd.cz], st });
        st.sets.push(st.set);
        graphOf(st);                                               // what holds what in the intact building (local collapse)
      } catch (e) { console.warn('[buildings] cut', e); }
      st.ready = true; st.cutMs = performance.now() - st.t0;
      runPending(st);
    });
    return st;
  }
  // A hit is coming at p: cut the building (if it isn't yet) and, finer, the chunks around p.
  // opts: { dir: the shot's direction (only the side facing the shooter is cut finer), prio:
  // 'fire' (a rocket is on its way: first) | 'aim' (the crosshair rests here: in the background) }.
  // The same spot twice is cut once.
  function expect(p, radius = HOLE_RADIUS, opts = {}) {
    const bd = at(p, 0.05); if (!bd) return false;
    const prio = PRIO[opts.prio] || PRIO.fire;
    const st = prepare(bd, prio); if (!st || st.claimed || st.down) return false;
    if (prio === PRIO.fire) hurry(st);
    if (st.spots.some((q) => Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z) < radius * 0.6)) return true;
    st.spots.push({ x: p.x, y: p.y, z: p.z });
    const f = C() && C().detail ? C().detail().factor : 1;
    const d = opts.dir, dl = d ? Math.hypot(d.x, d.y, d.z) || 1 : 1;
    const exclude = st.set ? st.set.frs.filter((fr) => fr.state !== 'still').map((fr) => fr.idx) : [];
    st.refining++;
    getCutter().send({ op: 'refine', b: bd.id, p: [p.x, p.y, p.z], reach: radius * FINE_REACH, size: FINE_SIZE / Math.cbrt(f), cap: Math.round(FINE_MAX * f),
      dir: d ? [d.x / dl, d.y / dl, d.z / dl] : null, depth: radius * FINE_DEPTH, exclude, prio }).then((m) => {
      st.refining--;
      try { applyRefine(st, m); } catch (e) { console.warn('[buildings] refine', e); }
    });
    return true;
  }
  // the finer pieces are back: swap them in for the coarse chunks they came from – those that are
  // still standing (a hit that came first used the coarse ones)
  function applyRefine(st, m) {
    const d = m.data; if (!d || !d.P || !st.set || st.claimed) return;
    const coarse = st.set.frs, still = (i) => coarse[i] && coarse[i].state === 'still';
    if (!m.victims.some(still)) return;
    const set = packedSet(d, facadeMat(st.bd), { hidden: !st.shown, dusty: true, piles: st.shell, center: [st.bd.cx, st.bd.cz], st });
    st.sets.push(set);
    set.down = st.down;
    if (st.down) lightsOut(st);
    const collapse = (owner, fr) => {
      fr.state = 'gone';
      for (let k = fr.start; k < fr.start + fr.count; k++) owner.pos.setXYZ(k, fr.pivot[0], fr.pivot[1], fr.pivot[2]);
      if (owner.pos.addUpdateRange) owner.pos.addUpdateRange(fr.start * 3, fr.count * 3);
      owner.pos.needsUpdate = true;
    };
    for (const fr of set.frs) if (!still(fr.idx)) collapse(set, fr);   // its coarse chunk is already gone
    for (const i of m.victims) if (still(i)) collapse(st.set, coarse[i]);
    st.graph = null;                                               // new pieces: the support graph is made again
  }
  // the chunks in, the building's own triangles out
  function swapIn(st) {
    if (st.shown || st.claimed || !st.ready) return;
    for (const set of st.sets) showSet(set);
    hideBuilding(st.bd);
    st.shown = true;
  }
  // hide the building's own triangles: everything above the lot within its footprint in the city
  // block meshes (roof rims stick out a little), also after the app redraws a block
  const hidden = [];
  function hideBuilding(bd) {
    const f = { x0: bd.x0 - 0.08, x1: bd.x1 + 0.08, z0: bd.z0 - 0.08, z1: bd.z1 + 0.08 };
    hidden.push(f);
    removeIn([f]);
  }
  const cleaned = new WeakMap();
  function removeIn(foot) {
    const sc = scene(); if (!sc) return;
    sc.traverse((o) => {
      if (!o.isMesh || o.isInstancedMesh || !o.geometry || o.geometry.index || o.userData.scSolid) return;
      if (!isFacade(Array.isArray(o.material) ? o.material[0] : o.material)) return;
      const g = o.geometry, pos = g.attributes.position; if (!pos) return;
      const done = cleaned.get(g) || []; const todo = foot.filter((f) => !done.includes(f)); if (!todo.length) return;
      cleaned.set(g, done.concat(todo));
      if (!g.boundingBox) g.computeBoundingBox();
      o.updateWorldMatrix(true, false);
      const e = o.matrixWorld.elements, bb = g.boundingBox;
      const nearF = todo.filter((f) => bb.max.x + e[12] >= f.x0 && bb.min.x + e[12] <= f.x1 && bb.max.z + e[14] >= f.z0 && bb.min.z + e[14] <= f.z1);
      if (!nearF.length) return;
      const a = pos.array, tx = e[12], ty = e[13], tz = e[14];      // city block meshes are only moved, not turned
      let lo = Infinity, hi = -1;
      for (let i = 0; i + 8 < a.length; i += 9) {
        // the triangle's middle inside the footprint, and above the lot
        const x = (a[i] + a[i + 3] + a[i + 6]) / 3 + tx, y = Math.max(a[i + 1], a[i + 4], a[i + 7]) + ty, z = (a[i + 2] + a[i + 5] + a[i + 8]) / 3 + tz;
        if (y <= 0.036) continue;
        let inside = false; for (const f of nearF) if (x >= f.x0 && x <= f.x1 && z >= f.z0 && z <= f.z1) { inside = true; break; }
        if (!inside) continue;
        for (let v = 3; v < 9; v++) a[i + v] = a[i + (v % 3)];
        lo = Math.min(lo, i); hi = Math.max(hi, i + 9);
      }
      if (hi > 0) { if (pos.addUpdateRange) pos.addUpdateRange(lo, hi - lo); pos.needsUpdate = true; }
    });
  }
  setInterval(() => { if (hidden.length && scene()) try { removeIn(hidden); } catch (e) { /* next time */ } }, 1500);

  // ---- breaking ----
  // chunks within `radius` of p fly out (n: out of the surface there); returns how many
  function crater(x, p, n, radius = HOLE_RADIUS) {
    const st = prepare(x); if (!st || st.claimed) return 0;
    if (busy(st)) { hurry(st); st.pending.push(() => crater(st.bd, p, n, radius)); return 0; }
    swapIn(st);
    // with big chunks (a big building) the crater is at least the chunk the blast hit
    // refined around an aim point: small pieces there, a crater of the normal size; elsewhere at
    // least the (big) chunk the blast hit
    const fine = st.sets.length > 1 && st.sets.some((set) => set.frs.some((fr) => fr.fine && fr.state === 'still' && Math.hypot(fr.pivot[0] - p.x, fr.pivot[1] - p.y, fr.pivot[2] - p.z) < radius * 1.5));
    const R = Math.max(radius, fine ? 0 : st.size * 0.8) * rnd(0.85, 1.15), out = n || { x: 0, y: 0, z: 0 };
    // the hole is already there (an earlier hit at the same spot): the blast digs deeper, inwards
    const standing = (c) => { let k = 0; for (const set of st.sets) for (const fr of set.frs) if (fr.state === 'still' && Math.hypot(fr.pivot[0] - c.x, fr.pivot[1] - c.y, fr.pivot[2] - c.z) < R) k++; return k; };
    // (a shell building is hollow: only through a hole that's already empty)
    const few = st.shell ? 1 : 6;
    for (let step = 0; step < 4 && n && standing(p) < few; step++) p = { x: p.x - out.x * R * 0.8, y: p.y - (out.y || 0) * R * 0.8, z: p.z - out.z * R * 0.8 };
    let count = 0;
    for (const set of st.sets) for (const fr of set.frs) {
      if (fr.state !== 'still') continue;
      const dx = fr.pivot[0] - p.x, dy = fr.pivot[1] - p.y, dz = fr.pivot[2] - p.z, d = Math.hypot(dx, dy, dz);
      if (d > R * rnd(0.85, 1.15)) continue;
      const l = d || 1, sp = rnd(0.6, 2.2) * (1 - d / (R * 1.2) * 0.5);
      launch(set, fr, [(dx / l) * 0.5 * sp + out.x * sp + rnd(-0.3, 0.3), (dy / l) * 0.4 * sp + rnd(0.2, 1), (dz / l) * 0.5 * sp + out.z * sp + rnd(-0.3, 0.3)], 0, rnd(4, 12));
      count++;
    }
    if (count) settle(st, p);
    return count;
  }

  // ---------- local collapse: what's no longer held up falls ----------
  // A building's pieces form a graph: pieces whose boxes touch. A piece is held when a path of
  // still pieces leads from it to the ground; each step costs the distance it goes sideways (a
  // span, an overhang; straight up is free, a staircase isn't), hanging from the piece above more. The costs of
  // the intact building are each piece's baseline (c0: the middle of a slab is a span already);
  // after a hit, a piece whose cost grew by more than SUPPORT_SPAN, or that has no path left, falls:
  // the wall above a wide hole, the slabs around a core that was shot away, a corner that lost
  // both its walls. What falls lands on the floor below if that still stands.
  function graphOf(st) {
    if (st.graph) return st.graph;
    const nodes = [];
    for (const set of st.sets) for (const fr of set.frs) if (fr.state !== 'gone') nodes.push({ fr, set });
    const E = 0.012, cell = Math.max(0.1, st.size), grid = new Map(), nb = nodes.map(() => []);
    const touch = (a, b) => a.lo[0] <= b.hi[0] + E && b.lo[0] <= a.hi[0] + E && a.lo[1] <= b.hi[1] + E && b.lo[1] <= a.hi[1] + E && a.lo[2] <= b.hi[2] + E && b.lo[2] <= a.hi[2] + E;
    let base = Infinity;
    nodes.forEach((n, a) => {
      const { lo, hi } = n.fr;
      if (lo[1] < base) base = lo[1];
      for (let i = Math.floor((lo[0] - E) / cell); i <= Math.floor((hi[0] + E) / cell); i++)
        for (let j = Math.floor((lo[1] - E) / cell); j <= Math.floor((hi[1] + E) / cell); j++)
          for (let k = Math.floor((lo[2] - E) / cell); k <= Math.floor((hi[2] + E) / cell); k++) {
            const key = ((i + 2000) * 4096 + (j + 2000)) * 4096 + (k + 2000);
            let c = grid.get(key); if (!c) grid.set(key, (c = []));
            for (const b of c) if (!nb[a].includes(b) && touch(n.fr, nodes[b].fr)) { nb[a].push(b); nb[b].push(a); }
            c.push(a);
          }
    });
    const g = st.graph = { nodes, nb, base };
    // pieces without a baseline: the intact building's costs; pieces cut finer later take their
    // coarse chunk's (plus half its size: they lie anywhere in it)
    if (nodes.some((n) => n.fr.c0 === undefined)) {
      const cost = holdCosts(g);
      nodes.forEach((n, i) => {
        const fr = n.fr; if (fr.c0 !== undefined) return;
        const src = fr.fine && st.set ? st.set.frs[fr.idx] : null;
        fr.c0 = src && src.c0 !== undefined ? src.c0 + 0.5 * Math.max(src.hi[0] - src.lo[0], src.hi[2] - src.lo[2]) : cost[i];
      });
    }
    return g;
  }
  // Dijkstra from the ground over the still pieces: what each costs to hold up
  function holdCosts(g) {
    const N = g.nodes.length, cost = new Float64Array(N).fill(Infinity), hc = [], hi = [];
    const push = (c, i) => { let k = hc.length; hc.push(c); hi.push(i); while (k) { const p = (k - 1) >> 1; if (hc[p] <= c) break; hc[k] = hc[p]; hi[k] = hi[p]; k = p; } hc[k] = c; hi[k] = i; };
    const pop = () => {
      const c = hc[0], i = hi[0], lc = hc.pop(), li = hi.pop();
      if (hc.length) { let k = 0; for (;;) { let m = 2 * k + 1; if (m >= hc.length) break; if (m + 1 < hc.length && hc[m + 1] < hc[m]) m++; if (hc[m] >= lc) break; hc[k] = hc[m]; hi[k] = hi[m]; k = m; } hc[k] = lc; hi[k] = li; }
      return [c, i];
    };
    const still = (i) => g.nodes[i].fr.state === 'still';
    for (let i = 0; i < N; i++) if (still(i) && g.nodes[i].fr.lo[1] < g.base + 0.02) { cost[i] = 0; push(0, i); }
    while (hc.length) {
      const [c, a] = pop();
      if (c > cost[a] || c > 4) continue;
      const A = g.nodes[a].fr.pivot;
      for (const b of g.nb[a]) {
        if (!still(b)) continue;
        const B = g.nodes[b].fr.pivot, dy = B[1] - A[1], dh = Math.hypot(B[0] - A[0], B[2] - A[2]);
        // the way sideways (on top of it: a little offset is free – pieces of storeys cut one by one
        // don't line up); hanging from it costs more
        const w = dy > 0.5 * dh ? Math.max(0, dh - SUPPORT_SLACK) : dy < -0.5 * dh ? dh - 2 * dy : dh;
        if (c + w < cost[b]) { cost[b] = c + w; push(c + w, b); }
      }
    }
    return cost;
  }
  // after a hit: what isn't held any more falls (onto the floor below, if that stands)
  function settle(st, p) {
    if (st.down || st.claimed || !st.ready) return 0;
    const g = graphOf(st), cost = holdCosts(g), fallers = [];
    g.nodes.forEach((n, i) => { if (n.fr.state === 'still' && cost[i] > n.fr.c0 + SUPPORT_SPAN) fallers.push(n); });
    if (!fallers.length) return 0;
    let mx = 0, my = Infinity, mz = 0;
    for (const { fr, set } of fallers) {
      launch(set, fr, [rnd(-0.08, 0.08), rnd(-0.25, 0), rnd(-0.08, 0.08)], rnd(0.05, 0.3), rnd(0.3, 2));
      mx += fr.pivot[0] / fallers.length; mz += fr.pivot[2] / fallers.length; my = Math.min(my, fr.pivot[1]);
    }
    for (const { fr, set } of fallers) landOn(st, set, fr);
    if (fallers.length > 8) {
      sound('crack'); setTimeout(() => sound('boom'), 600);
      if (DUST > 0) for (let k = 0; k < Math.min(14, fallers.length / 4) * DUST; k++) dust(mx + rnd(-0.15, 0.15), Math.max(0.06, my), mz + rnd(-0.15, 0.15),
        { vx: rnd(-0.3, 0.3), vy: rnd(-0.1, 0.1), vz: rnd(-0.3, 0.3), rise: 0.03, drag: 0.8, size: rnd(0.06, 0.12), grow: 5, life: rnd(4, 7), alpha: 0.6, delay: rnd(0.3, 1) });
    }
    // so little left standing: the rest comes down too
    let left = 0, all = 0; for (const n of g.nodes) { if (n.fr.state === 'gone') continue; all++; if (n.fr.state === 'still') left++; }
    if (all && left / all < 0.35) collapse(st.bd, { at: p });
    return fallers.length;
  }
  // the highest still piece of the building right under fr: it lands on that (and drops when that goes)
  function landOn(st, set, fr) {
    const x = fr.pivot[0] + (fr.off ? fr.off[0] : 0), z = fr.pivot[2] + (fr.off ? fr.off[2] : 0), bottom = fr.bb ? fr.bb[4] : fr.lo[1];
    let y = -Infinity, holder = null;
    for (const s of st.sets) for (const o of s.frs) {
      if (o.state !== 'still' || o.hi[1] > bottom + 0.02 || o.hi[1] <= y) continue;
      if (x < o.lo[0] || x > o.hi[0] || z < o.lo[2] || z > o.hi[2]) continue;
      y = o.hi[1]; holder = o;
    }
    if (!holder || y < GROUND + 0.02) return;
    fr.floorY = y; fr.holder = holder;
    (holder.carried || (holder.carried = [])).push({ set, fr });
  }

  // The nearest still chunk along a ray o + t·d, t ≤ maxT, in buildings shown as chunks:
  // { t, n (facing the shooter), id } or null. Shots and rockets go through holes this way.
  function ray(o, d, maxT = Infinity) {
    let best = null;
    const O = [o.x, o.y, o.z], D = [d.x, d.y, d.z];
    const box = (lo, hi, tmax) => {
      let t0 = 0, t1 = tmax;
      for (let k = 0; k < 3; k++) {
        if (Math.abs(D[k]) < 1e-12) { if (O[k] < lo[k] - 1e-3 || O[k] > hi[k] + 1e-3) return false; continue; }
        let a = (lo[k] - 1e-3 - O[k]) / D[k], b = (hi[k] + 1e-3 - O[k]) / D[k]; if (a > b) { const s = a; a = b; b = s; }
        if (a > t0) t0 = a; if (b < t1) t1 = b; if (t0 > t1) return false;
      }
      return true;
    };
    for (const st of solids.values()) {
      if (!st.shown || st.claimed || !st.sets) continue;
      const bd = st.bd;
      if (!box([bd.x0 - 0.1, 0, bd.z0 - 0.1], [bd.x1 + 0.1, bd.top + 0.1, bd.z1 + 0.1], best ? best.t : maxT)) continue;
      for (const set of st.sets) {
        const a = set.pos.array;
        for (const fr of set.frs) {
          if (fr.state !== 'still' || !box(fr.lo, fr.hi, best ? best.t : maxT)) continue;
          for (let v = fr.start * 3, end = (fr.start + fr.count) * 3; v + 8 < end; v += 9) {
            const e1x = a[v + 3] - a[v], e1y = a[v + 4] - a[v + 1], e1z = a[v + 5] - a[v + 2], e2x = a[v + 6] - a[v], e2y = a[v + 7] - a[v + 1], e2z = a[v + 8] - a[v + 2];
            const px = d.y * e2z - d.z * e2y, py = d.z * e2x - d.x * e2z, pz = d.x * e2y - d.y * e2x;
            const det = e1x * px + e1y * py + e1z * pz; if (Math.abs(det) < 1e-12) continue;
            const inv = 1 / det, sx = o.x - a[v], sy = o.y - a[v + 1], sz = o.z - a[v + 2];
            const u = (sx * px + sy * py + sz * pz) * inv; if (u < 0 || u > 1) continue;
            const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
            const w = (d.x * qx + d.y * qy + d.z * qz) * inv; if (w < 0 || u + w > 1) continue;
            const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
            if (t <= 1e-4 || t >= (best ? best.t : maxT)) continue;
            let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
            const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
            if (nx * d.x + ny * d.y + nz * d.z > 0) { nx = -nx; ny = -ny; nz = -nz; }
            best = { t, n: { x: nx, y: ny, z: nz }, id: bd.id };
          }
        }
      }
    }
    return best;
  }
  // a crater that counts: after HITS_TO_COLLAPSE of them the building comes down from this impact
  function hit(x, p, n, opts = {}) {
    const st = prepare(x); if (!st || st.claimed || st.down) return false;
    if (busy(st)) { hurry(st); st.hits += opts.count ?? 1; st.pending.push(() => { st.hits -= opts.count ?? 1; hit(st.bd, p, n, opts); }); return true; }
    crater(st.bd, p, n, opts.radius || HOLE_RADIUS);
    st.hits += opts.count ?? 1;
    const hitsNeeded = opts.collapseAt || (C() && C().settings ? C().settings.get('hitsToCollapse') : 0) || HITS_TO_COLLAPSE;
    if (st.hits >= hitsNeeded) collapse(st.bd, { at: p, out: n });
    return true;
  }
  // the building comes down; opts: { at: {x,y,z} | [x,y,z], out: {x,z} } or { at, push: [x,0,z] | {x,z}, force, spread }
  function collapse(x, opts = {}) {
    const st = prepare(x); if (!st || st.claimed || st.down) return false;
    st.down = true;                                                // down from now on (also while the cutting finishes)
    lightsOut(st);
    avoidRubble(st.bd);
    if (busy(st)) { hurry(st); st.pending.push(() => fall(st, opts)); return true; }
    fall(st, opts);
    return true;
  }
  // people keep away from the rubble for a while (residents)
  function avoidRubble(bd) {
    const res = window.scResidents;
    if (res && res.avoid) res.avoid(bd.cx, bd.cz, Math.hypot(bd.x1 - bd.x0, bd.z1 - bd.z0) / 2 + 0.4, RUBBLE_AVOID_SECONDS);
  }
  // What stays standing when a building comes down: a jagged stump. In the shell model the walls
  // (and the core) stay up to a height that goes up and down along them – the same for pieces
  // above each other, so nothing floats – and the slabs fall.
  function stumpOf(st) {
    const plain = (fr) => fr.pivot[1] < 0.03 + Math.random() * STUMP;
    if (!st.shell) return plain;
    const a = rnd(0, 6.3), b = rnd(0, 6.3), k1 = rnd(6, 11), k2 = rnd(6, 11);
    return (fr) => {
      if (fr.kind !== 1 && fr.kind !== 3) return plain(fr);
      const x = fr.pivot[0], z = fr.pivot[2];
      return fr.pivot[1] < 0.03 + SHELL_STUMP * clamp01(0.35 + 0.65 * Math.sin(k1 * x + a) * Math.sin(k2 * z + b) + 0.3 * Math.sin(k1 * 2.3 * (x + z) + b));
    };
  }
  function fall(st, opts) {
    swapIn(st);
    lightsOut(st);
    const stays = stumpOf(st);
    for (const set of st.sets) set.down = true;
    const bd = st.bd, cx = bd.cx, cz = bd.cz;
    const P = (v) => (Array.isArray(v) ? { x: v[0], y: v[1], z: v[2] } : v);
    const p = P(opts.at) || { x: cx, y: bd.top / 2, z: cz };
    let last = 0;
    if (opts.push) {
      // pushed over: a crack runs from p through the building, chunks are thrown the push's way
      const dv = P(opts.push), dl = Math.hypot(dv.x, dv.z) || 1, dir = [dv.x / dl, 0, dv.z / dl];
      const force = opts.force ?? 3, spread = opts.spread ?? COLLAPSE_SPREAD, H = bd.top;
      for (const set of st.sets) for (const fr of set.frs) {
        if (fr.state !== 'still' || stays(fr)) continue;
        const d = Math.hypot(fr.pivot[0] - p.x, (fr.pivot[1] - p.y) * 0.6, fr.pivot[2] - p.z);
        const up = clamp01((fr.pivot[1] - 0.03) / Math.max(0.1, H - 0.03)), nearHit = clamp01(1 - d / 0.8);
        const push = force * (0.25 + 0.75 * up + nearHit) * rnd(0.6, 1.2), side = rnd(-0.35, 0.35);
        const delay = d / spread + rnd(0, 0.15) * (1 - nearHit);
        last = Math.max(last, delay);
        launch(set, fr, [dir[0] * push - dir[2] * side * push * 0.5, rnd(-0.2, 0.6) + nearHit * 0.8, dir[2] * push + dir[0] * side * push * 0.5], delay, rnd(1, 5) * (0.5 + up));
      }
      // dust rolling out from the foot of the building, more on the far side
      if (DUST > 0) for (let k = 0; k < 18 * DUST; k++) {
        const a = Math.random() * Math.PI * 2, r = rnd(0, 0.5);
        dust(cx + Math.cos(a) * r + dir[0] * 0.3, 0.06, cz + Math.sin(a) * r + dir[2] * 0.3, { vx: Math.cos(a) * rnd(0.2, 0.6) + dir[0] * 0.5, vy: rnd(0.05, 0.25), vz: Math.sin(a) * rnd(0.2, 0.6) + dir[2] * 0.5,
          rise: 0.05, drag: 0.8, size: rnd(0.08, 0.16), grow: 6, life: rnd(4, 7), alpha: 0.75, delay: rnd(0.2, 1.2) });
      }
    } else {
      // from an impact: the floor at p fails first and the failure spreads outwards; what's above
      // drops and tips towards the hole, the floors below go one after the other
      const n = opts.out || null;
      let nx = n ? n.x : 0, nz = n ? n.z : 0;
      if (Math.hypot(nx, nz) < 0.3) { nx = p.x - cx; nz = p.z - cz; } const l2 = Math.hypot(nx, nz) || 1; nx /= l2; nz /= l2;
      const H = Math.max(0.1, bd.top - p.y);
      for (const set of st.sets) for (const fr of set.frs) {
        if (fr.state !== 'still' || stays(fr)) continue;
        const dh = Math.hypot(fr.pivot[0] - p.x, fr.pivot[2] - p.z), dy = fr.pivot[1] - p.y;
        let delay, v;
        if (dy > -0.06) {
          const up = Math.min(1, Math.max(0, dy) / H);
          delay = 0.12 + dh / COLLAPSE_SPREAD * 0.6 + rnd(0, 0.08);
          const lean = COLLAPSE_LEAN * (0.25 + up) * rnd(0.7, 1.2);
          v = [nx * lean + (fr.pivot[0] - cx) * rnd(0, 0.3) + rnd(-0.08, 0.08), rnd(-0.3, 0), nz * lean + (fr.pivot[2] - cz) * rnd(0, 0.3) + rnd(-0.08, 0.08)];
        } else {
          // (shell: a storey gives way when what falls from above reaches it, so nothing falls
          // through floors that still stand and lands under them)
          delay = st.shell ? 0.12 + dh / COLLAPSE_SPREAD * 0.6 + Math.sqrt(-dy / 3) + rnd(0, 0.1) : 0.35 + dh / COLLAPSE_SPREAD + (-dy) * 1.8 + rnd(0, 0.15);
          v = [(fr.pivot[0] - cx) * rnd(0, 0.5) + rnd(-0.1, 0.1), rnd(-0.2, 0.05), (fr.pivot[2] - cz) * rnd(0, 0.5) + rnd(-0.1, 0.1)];
        }
        last = Math.max(last, delay);
        launch(set, fr, v, delay, rnd(0.5, 3));
      }
      if (opts.sound !== false) { sound('crack'); setTimeout(() => sound('boom'), 250); setTimeout(() => sound('boom'), 900 + last * 400); }
      // a burst of dust and concrete out of the hole
      if (DUST > 0) for (let k = 0; k < 18 * DUST; k++) dust(p.x + nx * 0.05, p.y + rnd(-0.05, 0.1), p.z + nz * 0.05, { vx: nx * rnd(0.3, 1) + rnd(-0.3, 0.3), vy: rnd(-0.1, 0.4), vz: nz * rnd(0.3, 1) + rnd(-0.3, 0.3), rise: 0.05, drag: 0.9, size: rnd(0.06, 0.12), grow: 6, life: rnd(5, 9), alpha: 0.75 });
    }
    st.wave = { t: 0, until: 1.5 + last, at: 0.3 };               // the dust wave rolling out over the ground
    goneAfter(st, 600, 1500 + last * 1000);
  }
  // casualties (everyone inside and right next to it) after `ms`; walk mode's walls go
  function goneAfter(st, ms, wallsMs) {
    const bd = st.bd;
    setTimeout(() => {
      const res = window.scResidents;
      if (res && res.crush) res.crush(bd.x0, bd.z0, bd.x1, bd.z1);
      window.dispatchEvent(new CustomEvent('sc:crush', { detail: { x0: bd.x0, z0: bd.z0, x1: bd.x1, z1: bd.z1, margin: 0.3 } }));
    }, ms);
    if (classes()) bd.grp.traverse((o) => { if (o.isMesh && o.geometry && !o.userData.scSolid) o.geometry = new K.Geometry(); });
    setTimeout(() => window.dispatchEvent(new Event('sc:geometry-changed')), wallsMs);
  }
  // dust rolling out over the ground from a collapsing building
  function stepWave(st, dt) {
    const wv = st.wave; if (!wv || DUST <= 0) return;
    wv.t += dt;
    if (wv.t > wv.until) { st.wave = null; return; }
    const bd = st.bd, cx = bd.cx, cz = bd.cz, wx = bd.x1 - bd.x0, wz = bd.z1 - bd.z0, per = 2 * (wx + wz);
    wv.at -= dt;
    while (wv.at <= 0) {
      wv.at += 1 / (12 * DUST * Math.min(3, 0.5 + per));
      // a point on the footprint's edge, moving out from the middle
      let u = Math.random() * per, x, z;
      if (u < wx) { x = bd.x0 + u; z = bd.z0; } else if ((u -= wx) < wz) { x = bd.x1; z = bd.z0 + u; } else if ((u -= wz) < wx) { x = bd.x1 - u; z = bd.z1; } else { u -= wx; x = bd.x0; z = bd.z1 - u; }
      let dx = x - cx, dz = z - cz; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
      const sp = rnd(0.5, 1.4), high = Math.random() < 0.3;
      dust(x, rnd(0.05, 0.15), z, { vx: dx * sp + rnd(-0.15, 0.15), vy: high ? rnd(0.2, 0.6) : rnd(0, 0.05), vz: dz * sp + rnd(-0.15, 0.15),
        rise: high ? rnd(0.08, 0.2) : 0.01, drag: high ? 0.7 : 0.45, flat: high ? 1 : 1.8, size: rnd(0.1, 0.2), grow: rnd(5, 8), life: rnd(7, 12), alpha: rnd(0.6, 0.85) });
    }
  }

  // The nuke's shockwave over buildings that were already in chunks before it went off: every
  // still chunk within `front` of (cx, cz) asks fn(chunk, distance) → { v, spin } (it flies) or
  // null (it stays: the ruin). Such a building counts as down from then on.
  function blastWave(cx, cz, front, fn) {
    for (const st of solids.values()) {
      if (st.claimed || !st.set || busy(st)) continue;
      const bd = st.bd;
      if (Math.hypot(Math.max(bd.x0 - cx, 0, cx - bd.x1), Math.max(bd.z0 - cz, 0, cz - bd.z1)) > front) continue;
      swapIn(st);
      for (const set of st.sets) for (const fr of set.frs) {
        if (fr.state !== 'still' || fr.waved) continue;
        const d = Math.hypot(fr.pivot[0] - cx, fr.pivot[2] - cz);
        if (d > front) continue;
        fr.waved = true;
        const r = fn(fr, d);
        if (r) launch(set, fr, r.v, 0, r.spin ?? rnd(1, 5), true);
      }
      if (!st.down) { st.down = true; goneAfter(st, 200, 3000); }
      lightsOut(st);
    }
  }
  // a building another script takes care of (the nuke's own pieces): left alone from now on
  function claim(id) { if (!solids.has(id)) solids.set(id, { claimed: true, down: true, bd: null }); if (C() && C().lightsOut) C().lightsOut(id); }
  // a building that's down has no power: its night glow and Christmas lights go out (core) and
  // its chunks get the facade without lit windows
  function lightsOut(st) {
    const c = C(); if (!c || !c.lightsOut) return;
    c.lightsOut(st.bd.id);
    for (const set of st.sets) set.mesh.material = c.darkFacade(set.mesh.material);
  }

  // ---------- the frame loop and the damage bus (as soon as the core is there) ----------
  function step(dt) {
    dt = Math.min(dt, 0.05);                                       // (bigger steps make chunks jump)
    if (wells.size) stepWells(dt);
    stepSets(dt);
    for (const st of solids.values()) if (st.wave) stepWave(st, dt);
  }
  function onDamage(ev) {
    if (!ev || ev.x === undefined) return null;
    const p = { x: ev.x, y: ev.y ?? 0.1, z: ev.z };
    if (ev.kind === 'blast' || ev.kind === 'impact') {
      const R = ev.radius || HOLE_RADIUS, bd = at(p, Math.max(0.03, R * 0.5));
      if (!bd) return null;
      return hit(bd, p, ev.n, { radius: R, count: ev.hits ?? 1 }) ? { building: bd.id } : null;
    }
    if (ev.kind === 'push') {
      const bd = at(p, ev.radius ?? 0.3); if (!bd) return null;
      const d = ev.dir || { x: bd.cx - p.x, z: bd.cz - p.z };
      return collapse(bd, { at: p, push: d, force: ev.power ?? 3, spread: ev.spread }) ? { building: bd.id } : null;
    }
    return null;
  }
  (function attach() {
    const c = C();
    if (!c) { if ((attach.n = (attach.n || 0) + 1) < 240) setTimeout(attach, 250); else console.warn('[buildings] savings-city-core is missing'); return; }
    c.onFrame(step);
    c.onDamage(onDamage);
    if (c.settings) c.settings.define({ id: 'hitsToCollapse', label: 'Raketten tot een gebouw instort', min: 1, max: 20, step: 1, value: HITS_TO_COLLAPSE,
      format: (v) => (v === 1 ? '1 raket' : `${v} raketten`) });
    if (c.settings) c.settings.define({ id: 'buildingModel', label: 'Gebouwen bij vernielen', options: ['Massief', 'Vloeren en muren'], value: 0,
      help: 'Massief: een gebouw breekt in blokken. Vloeren en muren: gebouwen zijn hol, met verdiepingen; in een gat zie je de vloeren en het puin stapelt zich op. Geldt voor gebouwen die daarna geraakt worden.' });
  })();

  const geo = cutterCore(null);   // the geometry functions, here on the page (the nuke uses them)
  window.scBuildings = {
    list, at, near, prepare: (x) => !!prepare(x), expect,
    isSolid: (id) => solids.has(id),
    isDown: (id) => !!(solids.get(id) && solids.get(id).down),
    alive: (x) => { const bd = byId(x); if (!bd) return false; const st = solids.get(bd.id); return !(st && st.down) && !!(bd.grp && bd.grp.parent); },
    // how a building is doing: { solid, down, hits, chunks, standing } (null: not in chunks yet)
    state(x) { const id = x && typeof x === 'object' ? x.id : x, st = solids.get(id); if (!st || st.claimed) return st ? { claimed: true } : null;
      const all = st.sets.flatMap((x) => x.frs).filter((f) => f.state !== 'gone');
      return { solid: true, model: st.shell ? 'shell' : 'solid', ready: st.ready, cutMs: st.cutMs && Math.round(st.cutMs), down: st.down, hits: st.hits, fine: all.filter((f) => f.fine).length, chunks: all.length, standing: all.filter((f) => f.state === 'still').length,
        flying: all.filter((f) => f.state === 'flying').length, pile: st.shell ? Math.round(Math.max(0, ...all.filter((f) => f.stamp).map((f) => f.bb[4])) * 1000) / 1000 : undefined }; },
    crater, hit, collapse, blastWave, claim, well,
    // shots against buildings in chunks: ray(o, d, maxT) → { t, n, id } | null; covers(id): the
    // building is shown as chunks (rays should use ray(), not its own meshes)
    ray, covers: (id) => { const st = solids.get(id); return !!(st && !st.claimed && st.shown); },
    get cutter() { return cutter ? cutter.mode : null; },        // 'worker' or 'page' (no worker could be made)
    // low-level, for scripts with their own plans (the nuke)
    geometry: { readMasses, boxPoly: geo.boxPoly, shatter: geo.shatter, pieceTriangles: geo.pieceTriangles, newell: geo.newell, bounds: geo.bounds, shellPlates: geo.shellPlates, concreteOf: geo.concreteOf, isFacade, JF },
    // the building model the setting asks for now: null (solid) or the shell's measures for
    // geometry.shellPlates { kind: 'shell', storey, wall, slab, core, coreSize, piecesPerArea }
    shellModel: () => (shellModel() ? shellSpec() : null),
    chunkSet, buildSet, launch,
    get chunkSize() { return CHUNK_SIZE; },
    chunkSizeFor: (x) => { const bd = byId(x); return bd ? chunkSizeFor(bd) : CHUNK_SIZE; },
  };

  // ---------- geometry (the app's facade boxes, convex pieces, rotations) ----------
  // Read the boxes of one building's facade mesh (world coordinates).
  function readMasses(mesh) {
    const g = mesh.geometry, pos = g.attributes.position, nor = g.attributes.normal, uv = g.attributes.uv, col = g.attributes.color;
    if (!pos || !nor || !uv || !col || pos.count % 4) return [];
    mesh.updateWorldMatrix(true, false);
    const e = mesh.matrixWorld.elements;
    const W = (i) => [e[0] * pos.getX(i) + e[4] * pos.getY(i) + e[8] * pos.getZ(i) + e[12], e[1] * pos.getX(i) + e[5] * pos.getY(i) + e[9] * pos.getZ(i) + e[13], e[2] * pos.getX(i) + e[6] * pos.getY(i) + e[10] * pos.getZ(i) + e[14]];
    const tops = [], walls = [];
    for (let q = 0; q < pos.count; q += 4) {
      const nx = nor.getX(q), ny = nor.getY(q), nz = nor.getZ(q);
      const wn = [e[0] * nx + e[4] * ny + e[8] * nz, e[1] * nx + e[5] * ny + e[9] * nz, e[2] * nx + e[6] * ny + e[10] * nz];
      const P = [0, 1, 2, 3].map((k) => W(q + k)), c = [col.getX(q), col.getY(q), col.getZ(q)];
      if (wn[1] > 0.9) {
        tops.push({ x0: Math.min(...P.map((p) => p[0])), x1: Math.max(...P.map((p) => p[0])), z0: Math.min(...P.map((p) => p[2])), z1: Math.max(...P.map((p) => p[2])), y1: P[0][1], roof: c });
      } else if (Math.abs(wn[0]) > 0.9 || Math.abs(wn[2]) > 0.9) {
        const ax = Math.abs(wn[0]) > 0.9 ? 0 : 2, along = ax === 0 ? 2 : 0, sign = Math.sign(wn[ax]);
        // u depends on the position along the wall, v on the height: read both lines off the quad
        const U = [0, 1, 2, 3].map((k) => [uv.getX(q + k), uv.getY(q + k)]);
        let a = 0, b = 1; for (let k = 1; k < 4; k++) if (Math.abs(P[k][along] - P[0][along]) > 1e-5) { b = k; break; }
        let c2 = 1; for (let k = 1; k < 4; k++) if (Math.abs(P[k][1] - P[0][1]) > 1e-5) { c2 = k; break; }
        const du = (U[b][0] - U[a][0]) / (P[b][along] - P[a][along]), dv = (U[c2][1] - U[0][1]) / (P[c2][1] - P[0][1]);
        // texture mapping as numbers (ua + (s − sa)·du, va + (y − ya)·dv), so it can go to the worker
        const ua = U[a][0], sa = P[a][along], va = U[0][1], ya = P[0][1];
        walls.push({ ax, along, sign, at: P[0][ax], s0: Math.min(...P.map((p) => p[along])), s1: Math.max(...P.map((p) => p[along])),
          y0: Math.min(...P.map((p) => p[1])), y1: Math.max(...P.map((p) => p[1])), c, ua, sa, du, va, ya, dv,
          u: (s) => ua + (s - sa) * du, v: (y) => va + (y - ya) * dv });
      }
    }
    const near = (a, b) => Math.abs(a - b) < 1e-3;
    const boxes = [];
    for (const t of tops) {
      const lim = { x: [t.x0, t.x1], z: [t.z0, t.z1] };
      const own = walls.filter((w) => near(w.y1, t.y1) && near(w.at, w.ax === 0 ? (w.sign > 0 ? t.x1 : t.x0) : (w.sign > 0 ? t.z1 : t.z0)) &&
        w.s0 >= (w.along === 0 ? lim.x[0] : lim.z[0]) - 1e-3 && w.s1 <= (w.along === 0 ? lim.x[1] : lim.z[1]) + 1e-3);
      if (own.length < 1) continue;
      const y0 = Math.min(...own.map((w) => w.y0));
      if (t.y1 - y0 < 0.005 || t.x1 - t.x0 < 0.01 || t.z1 - t.z0 < 0.01) continue;
      boxes.push({ x0: t.x0, x1: t.x1, z0: t.z0, z1: t.z1, y0, y1: t.y1, roof: t.roof, walls: own, wallColor: own[0].c });
    }
    for (const b of boxes) b.siblings = boxes;
    return boxes;
  }

  // rotation of `angle` around a unit axis, as a 3×3 matrix (row-major)
  function rot(x, y, z, angle) {
    const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
    return [t * x * x + c, t * x * y - s * z, t * x * z + s * y, t * x * y + s * z, t * y * y + c, t * y * z - s * x, t * x * z - s * y, t * y * z + s * x, t * z * z + c];
  }
  const mul = (A, B) => [
    A[0] * B[0] + A[1] * B[3] + A[2] * B[6], A[0] * B[1] + A[1] * B[4] + A[2] * B[7], A[0] * B[2] + A[1] * B[5] + A[2] * B[8],
    A[3] * B[0] + A[4] * B[3] + A[5] * B[6], A[3] * B[1] + A[4] * B[4] + A[5] * B[7], A[3] * B[2] + A[4] * B[5] + A[5] * B[8],
    A[6] * B[0] + A[7] * B[3] + A[8] * B[6], A[6] * B[1] + A[7] * B[4] + A[8] * B[7], A[6] * B[2] + A[7] * B[5] + A[8] * B[8]];

  // ---------- the cutter: pure geometry, also runs in a worker ----------
  // cutterCore(port, sliceMs) works on messages from `port` (a worker's `self`, or a stand-in on
  // the page) and answers through port.postMessage. It must stay self-contained: in the worker it
  // is rebuilt from its source text, so it can't use anything from outside this function.
  // Messages:
  //   { op: 'cut', job, b, boxes, size, prio } → { op, job, b, data } (the chunks of building b; kept
  //       here, for cutting finer later)
  //   { op: 'refine', job, b, p, reach, size, cap, dir, depth, exclude, prio } → { op, job, b, data,
  //       victims } (finer pieces of the coarse chunks near p that face the shooter, nearest first,
  //       at most `cap`; victims = the coarse chunks they replace)
  //   { op: 'prio', b, prio } (a hit is waiting for building b), { op: 'drop', b }
  // data = flat arrays (transferred, not copied): pos, nor, n0 (normals at rest), col, uv, orig
  // (positions relative to each piece's pivot), meta (14 per piece: start, count, pivot, normal of
  // its largest face, bounds lo, hi), src (refine: the coarse chunk of every piece), P (pieces).
  // Jobs run in slices of sliceMs, the most urgent first (a building's cut before its refinements).
  // With port null it only returns the geometry functions.
  function cutterCore(port, sliceMs) {
    const rnd = (a, b) => a + Math.random() * (b - a);
    const JF = [0.04, 0.96];       // the facade texture's plain spot
    const insideBox = (b, p, eps = 1e-4) => p[0] > b.x0 + eps && p[0] < b.x1 - eps && p[1] > b.y0 + eps && p[1] < b.y1 - eps && p[2] > b.z0 + eps && p[2] < b.z1 - eps;

    // ---- convex polyhedra: a list of faces { v: [[x, y, z], …] counter-clockwise seen from outside, n, tag } ----
    const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    function newell(v) {
      let x = 0, y = 0, z = 0;
      for (let i = 0; i < v.length; i++) { const a = v[i], b = v[(i + 1) % v.length]; x += (a[1] - b[1]) * (a[2] + b[2]); y += (a[2] - b[2]) * (a[0] + b[0]); z += (a[0] - b[0]) * (a[1] + b[1]); }
      return [x, y, z];   // length = 2 × area
    }
    function face(v, n, tag) { if (dot(newell(v), n) < 0) v = v.slice().reverse(); return { v, n, tag }; }
    function boxPoly(x0, y0, z0, x1, y1, z1, tags) {
      return [
        face([[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], [1, 0, 0], tags['+x']),
        face([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [-1, 0, 0], tags['-x']),
        face([[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]], [0, 1, 0], tags['+y']),
        face([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [0, -1, 0], tags['-y']),
        face([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1], tags['+z']),
        face([[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]], [0, 0, -1], tags['-z']),
      ];
    }
    // cut a convex polyhedron by the plane n·p = d: [part behind, part in front]
    function split(poly, n, d) {
      const back = [], front = [], cut = [];
      const EPS = 1e-9;
      for (const f of poly) {
        const b = [], fr = [], m = f.v.length;
        for (let i = 0; i < m; i++) {
          const a = f.v[i], c = f.v[(i + 1) % m];
          let da = dot(n, a) - d, dc = dot(n, c) - d;
          if (Math.abs(da) < EPS) da = 0; if (Math.abs(dc) < EPS) dc = 0;
          if (da <= 0) b.push(a);
          if (da >= 0) fr.push(a);
          if (da === 0) cut.push(a);
          if ((da < 0 && dc > 0) || (da > 0 && dc < 0)) {
            const t = da / (da - dc), p = [a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t, a[2] + (c[2] - a[2]) * t];
            b.push(p); fr.push(p); cut.push(p);
          }
        }
        if (b.length >= 3 && Math.hypot(...newell(b)) > 1e-10) back.push({ v: b, n: f.n, tag: f.tag });
        if (fr.length >= 3 && Math.hypot(...newell(fr)) > 1e-10) front.push({ v: fr, n: f.n, tag: f.tag });
      }
      // the new face where the cut went through: the cut points, in order around their middle
      const seen = new Set(), pts = [];
      for (const p of cut) { const k = p.map((x) => Math.round(x * 1e6)).join(','); if (!seen.has(k)) { seen.add(k); pts.push(p); } }
      if (pts.length >= 3 && back.length && front.length) {
        const c = pts.reduce((s, p) => [s[0] + p[0] / pts.length, s[1] + p[1] / pts.length, s[2] + p[2] / pts.length], [0, 0, 0]);
        let u = cross(n, Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]); const ul = Math.hypot(...u); u = u.map((x) => x / ul);
        const w = cross(n, u);
        pts.sort((p, q) => Math.atan2(dot(sub(p, c), w), dot(sub(p, c), u)) - Math.atan2(dot(sub(q, c), w), dot(sub(q, c), u)));
        back.push(face(pts, n, 'cut'));
        front.push(face(pts.slice(), [-n[0], -n[1], -n[2]], 'cut'));
      }
      return [back, front];
    }
    function bounds(poly) {
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (const f of poly) for (const p of f.v) for (let k = 0; k < 3; k++) { if (p[k] < lo[k]) lo[k] = p[k]; if (p[k] > hi[k]) hi[k] = p[k]; }
      return { lo, hi };
    }
    // keep cutting the largest direction with a slightly tilted plane until pieces are about `size`
    function shatter(poly, size, out, depth = 0) {
      const { lo, hi } = bounds(poly), ext = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
      const k = ext[0] >= ext[1] && ext[0] >= ext[2] ? 0 : ext[1] >= ext[2] ? 1 : 2, L = ext[k];
      if (L <= size * rnd(0.8, 1.25) || depth > 40) { out.push(poly); return; }
      for (let attempt = 0; attempt < 6; attempt++) {
        const tilt = attempt < 3 ? 0.5 : 0.1;                       // a cut that failed: try again, straighter
        const n = [rnd(-tilt, tilt), rnd(-tilt, tilt), rnd(-tilt, tilt)]; n[k] = 1;
        const nl = Math.hypot(...n); for (let a = 0; a < 3; a++) n[a] /= nl;
        const c = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2]; c[k] += L * rnd(-0.18, 0.18);
        const [a, b] = split(poly, n, dot(n, c));
        if (a.length >= 4 && b.length >= 4) { shatter(a, size, out, depth + 1); shatter(b, size, out, depth + 1); return; }
      }
      out.push(poly);
    }

    // Triangles (with colour and facade texture coordinates) for one piece.
    function pieceTriangles(poly, box, concrete) {
      const tris = [];
      for (const f of poly) {
        let c = concrete, uvOf = () => JF;
        const t = f.tag;
        if (t && t.inner && box.inner) c = box.inner[t.inner];       // the shell model's insides: floor, ceiling, plaster
        if (t && t !== 'cut' && t.ext) {
          const mid = f.v.reduce((s, p) => [s[0] + p[0] / f.v.length, s[1] + p[1] / f.v.length, s[2] + p[2] / f.v.length], [0, 0, 0]);
          const out = [mid[0] + f.n[0] * 0.004, mid[1] + f.n[1] * 0.004, mid[2] + f.n[2] * 0.004];
          if (!box.siblings.some((b) => insideBox(b, out, -1e-4))) {    // really on the outside of the building
            if (t.side === '+y') c = box.roof;
            else {
              const ax = t.side[1] === 'x' ? 0 : 2, sign = t.side[0] === '+' ? 1 : -1;
              const w = box.walls.find((w) => w.ax === ax && w.sign === sign && mid[1] >= w.y0 - 1e-3 && mid[1] <= w.y1 + 1e-3 && mid[w.along] >= w.s0 - 1e-3 && mid[w.along] <= w.s1 + 1e-3);
              if (w) { c = w.c; uvOf = (p) => wallUV(w, p); }
            }
          }
        }
        const vs = f.v.map((p) => ({ p, n: f.n, c, uv: uvOf(p) }));
        for (let i = 1; i + 1 < vs.length; i++) tris.push([vs[0], vs[i], vs[i + 1]]);
      }
      return tris;
    }


    // The shell model's plates of box b (m: { storey, wall, slab, core, coreSize }) within the
    // rectangle r = { x0, x1, z0, z1 } (part of the box's footprint: walls only where r reaches the
    // box's sides) between heights ya and yb, with k storeys to a plate (one wall over k storeys, a
    // slab only on top of every k-th: coarser, fewer pieces). Each storey: four outer walls on the
    // slab below, the slab on top over the whole footprint (its edge is part of the facade; the
    // top one is the roof), and a concrete core in wide buildings. Faces cut off by r, ya or yb are
    // breaks (concrete). whole: walls and core in one plate from ya to yb and the slabs between
    // the walls (for parts that never move – the nuke's ruins: far fewer plates, the same facade).
    // Sets b.inner (inside colours for pieceTriangles). Pushes { poly, kind } onto out (kind: 1
    // wall, 2 slab, 3 core).
    function shellPlates(b, m, r, ya, yb, k, out, whole = false) {
      const W = b.x1 - b.x0, D = b.z1 - b.z0, H = b.y1 - b.y0, E = 1e-6;
      const T = Math.min(m.wall, W / 4, D / 4), n = Math.max(1, Math.round(H / m.storey)), S = Math.min(m.slab, H / n / 3);
      if (!b.inner) b.inner = insides(b);
      const ext = (side) => ({ side, ext: true }), IN = (kk) => ({ inner: kk });
      const sx0 = Math.abs(r.x0 - b.x0) < E, sx1 = Math.abs(r.x1 - b.x1) < E, sz0 = Math.abs(r.z0 - b.z0) < E, sz1 = Math.abs(r.z1 - b.z1) < E;
      const add = (x0, y0, z0, x1, y1, z1, tags, kind) => {
        const c0 = Math.max(y0, ya), c1 = Math.min(y1, yb);
        if (x1 - x0 < 1e-4 || c1 - c0 < 1e-4 || z1 - z0 < 1e-4) return;
        const t = { ...tags };
        if (c1 < y1 - E) t['+y'] = undefined;
        if (c0 > y0 + E) t['-y'] = undefined;
        out.push({ poly: boxPoly(x0, c0, z0, x1, c1, z1, t), kind });
      };
      const side = (on, s) => (on ? ext(s) : undefined);
      const core = W >= m.core && D >= m.core ? Math.min(m.coreSize, W / 4, D / 4) / 2 : 0, cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
      if (whole) {
        const top = yb >= b.y1 - E ? ext('+y') : undefined, za = Math.max(r.z0, b.z0 + T), zb = Math.min(r.z1, b.z1 - T);
        if (sz0) add(r.x0, ya, b.z0, r.x1, yb, b.z0 + T, { '-z': ext('-z'), '+z': IN('wall'), '+x': side(sx1, '+x'), '-x': side(sx0, '-x'), '+y': top }, 1);
        if (sz1) add(r.x0, ya, b.z1 - T, r.x1, yb, b.z1, { '+z': ext('+z'), '-z': IN('wall'), '+x': side(sx1, '+x'), '-x': side(sx0, '-x'), '+y': top }, 1);
        if (sx0) add(b.x0, ya, za, b.x0 + T, yb, zb, { '-x': ext('-x'), '+x': IN('wall'), '+y': top }, 1);
        if (sx1) add(b.x1 - T, ya, za, b.x1, yb, zb, { '+x': ext('+x'), '-x': IN('wall'), '+y': top }, 1);
        if (core) add(Math.max(r.x0, cx - core), ya, Math.max(r.z0, cz - core), Math.min(r.x1, cx + core), yb, Math.min(r.z1, cz + core), { '+x': IN('wall'), '-x': IN('wall'), '+z': IN('wall'), '-z': IN('wall') }, 3);
        const x0 = sx0 ? r.x0 + T : r.x0, x1 = sx1 ? r.x1 - T : r.x1, z0 = sz0 ? r.z0 + T : r.z0, z1 = sz1 ? r.z1 - T : r.z1;
        for (let i = 1; i <= n; i++) {
          const hi = b.y0 + (H * i) / n;
          if (hi - S < yb - E && hi > ya + E) add(x0, hi - S, z0, x1, hi, z1, { '+y': i === n ? ext('+y') : IN('floor'), '-y': IN('ceil') }, 2);
        }
        return out;
      }
      for (let i = 0; i < n; i += Math.max(1, k)) {
        const g = Math.min(n, i + Math.max(1, k)), lo = b.y0 + (H * i) / n, hi = b.y0 + (H * g) / n, yw = hi - S;
        if (hi <= ya + E || lo >= yb - E) continue;
        // walls: the ±z ones over the whole width (their ends are the corners), the ±x ones between them
        if (sz0) add(r.x0, lo, b.z0, r.x1, yw, b.z0 + T, { '-z': ext('-z'), '+z': IN('wall'), '+x': side(sx1, '+x'), '-x': side(sx0, '-x') }, 1);
        if (sz1) add(r.x0, lo, b.z1 - T, r.x1, yw, b.z1, { '+z': ext('+z'), '-z': IN('wall'), '+x': side(sx1, '+x'), '-x': side(sx0, '-x') }, 1);
        const za = Math.max(r.z0, b.z0 + T), zb = Math.min(r.z1, b.z1 - T);
        if (sx0) add(b.x0, lo, za, b.x0 + T, yw, zb, { '-x': ext('-x'), '+x': IN('wall') }, 1);
        if (sx1) add(b.x1 - T, lo, za, b.x1, yw, zb, { '+x': ext('+x'), '-x': IN('wall') }, 1);
        if (core) {
          const x0 = Math.max(r.x0, cx - core), x1 = Math.min(r.x1, cx + core), z0 = Math.max(r.z0, cz - core), z1 = Math.min(r.z1, cz + core);
          add(x0, lo, z0, x1, yw, z1, { '+x': IN('wall'), '-x': IN('wall'), '+z': IN('wall'), '-z': IN('wall') }, 3);
        }
        // the slab on top: the roof (outside) or the next storey's floor; underneath, the ceiling
        add(r.x0, yw, r.z0, r.x1, hi, r.z1, { '+x': side(sx1, '+x'), '-x': side(sx0, '-x'), '+z': side(sz1, '+z'), '-z': side(sz0, '-z'),
          '+y': g === n ? ext('+y') : IN('floor'), '-y': IN('ceil') }, 2);
      }
      return out;
    }
    // Broken concrete: grey, a hint of the facade's colour (not the facade's colour itself).
    const concreteOf = (w) => [w[0] * 0.1 + 0.5, w[1] * 0.1 + 0.49, w[2] * 0.1 + 0.47];
    // The inside colours of a building (the same for all its boxes): plaster walls (white to light
    // grey), a white-grey ceiling, and floors of wood (brown), concrete (grey) or tiles (beige). The
    // ceiling is a little pink: it faces down and the app's sky light is grey-green from below.
    const INSIDE_FLOORS = [[0.5, 0.36, 0.23], [0.4, 0.29, 0.19], [0.6, 0.59, 0.56], [0.7, 0.63, 0.53]];
    function insides(b) {
      const s0 = (b.siblings && b.siblings[0]) || b, h = Math.abs(Math.sin(s0.x0 * 12.9898 + s0.z0 * 78.233) * 43758.5453) % 1;
      const p = 0.9 - (h * 7 % 1) * 0.12, warm = (h * 13 % 1) * 0.04;
      return { wall: [p, p - 0.01 - warm * 0.5, p - 0.03 - warm], ceil: [0.88, 0.83, 0.91], floor: INSIDE_FLOORS[Math.floor(h * INSIDE_FLOORS.length)] };
    }
    // the texture mapping of a wall at point p (the numbers from readMasses)
    function wallUV(w, p) { return [w.ua + (p[w.along] - w.sa) * w.du, w.va + (p[1] - w.ya) * w.dv]; }
    const lib = { boxPoly, split, shatter, pieceTriangles, newell, bounds, shellPlates, concreteOf, JF };
    if (!port) return lib;

    // ---- pieces → flat arrays ----
    function largest(poly) { let big = null, area = -1; for (const f of poly) { const a = Math.hypot(...newell(f.v)); if (a > area) { area = a; big = f.n; } } return big; }
    function pack(pieces, withSrc) {
      let V = 0;
      const tris = pieces.map((pc) => { const t = pieceTriangles(pc.poly, pc.box, pc.tint); V += t.length * 3; return t; });
      const P = pieces.length, pos = new Float32Array(V * 3), nor = new Float32Array(V * 3), col = new Float32Array(V * 3), uv = new Float32Array(V * 2), orig = new Float32Array(V * 3);
      const meta = new Float32Array(P * 14), src = withSrc ? new Int32Array(P) : null, kind = new Uint8Array(P);
      let k = 0;
      for (let i = 0; i < P; i++) {
        const pc = pieces[i], start = k;
        let px = 0, py = 0, pz = 0, m = 0;
        for (const t of tris[i]) for (const v of t) { px += v.p[0]; py += v.p[1]; pz += v.p[2]; m++; }
        px /= m || 1; py /= m || 1; pz /= m || 1;
        for (const t of tris[i]) for (const v of t) {
          pos[k * 3] = v.p[0]; pos[k * 3 + 1] = v.p[1]; pos[k * 3 + 2] = v.p[2];
          orig[k * 3] = v.p[0] - px; orig[k * 3 + 1] = v.p[1] - py; orig[k * 3 + 2] = v.p[2] - pz;
          nor[k * 3] = v.n[0]; nor[k * 3 + 1] = v.n[1]; nor[k * 3 + 2] = v.n[2];
          col[k * 3] = v.c[0]; col[k * 3 + 1] = v.c[1]; col[k * 3 + 2] = v.c[2];
          uv[k * 2] = v.uv[0]; uv[k * 2 + 1] = v.uv[1];
          k++;
        }
        const n = pc.normal || [0, -1, 0], o = i * 14;
        meta[o] = start; meta[o + 1] = k - start; meta[o + 2] = px; meta[o + 3] = py; meta[o + 4] = pz;
        meta[o + 5] = n[0]; meta[o + 6] = n[1]; meta[o + 7] = n[2];
        meta[o + 8] = pc.lo[0]; meta[o + 9] = pc.lo[1]; meta[o + 10] = pc.lo[2]; meta[o + 11] = pc.hi[0]; meta[o + 12] = pc.hi[1]; meta[o + 13] = pc.hi[2];
        if (src) src[i] = pc.src;
        kind[i] = pc.kind || 0;
      }
      const data = { pos, nor, n0: nor.slice(), col, uv, orig, meta, src, kind, P };
      return { data, transfer: [pos.buffer, nor.buffer, data.n0.buffer, col.buffer, uv.buffer, orig.buffer, meta.buffer, kind.buffer].concat(src ? [src.buffer] : []) };
    }
    function piece(poly, box, tint, extra) { const { lo, hi } = bounds(poly); return { poly, box, tint, normal: largest(poly), lo, hi, ...extra }; }

    // ---- the jobs ----
    const buildings = new Map();   // b → { pieces, done }
    function* cut(msg) {
      const boxes = msg.boxes, size = msg.size, pieces = [];
      const bld = { pieces, done: false };
      buildings.set(msg.b, bld);
      for (const b of boxes) b.siblings = boxes;
      for (const b of boxes) {
        const concrete0 = concreteOf(b.wallColor);
        if (msg.model && msg.model.kind === 'shell') { yield* shell(b, size, msg.model, concrete0, pieces); continue; }
        const tags = { '+x': { side: '+x', ext: true }, '-x': { side: '-x', ext: true }, '+z': { side: '+z', ext: true }, '-z': { side: '-z', ext: true } };
        // in slabs of about two chunk heights, so one cut never has to deal with a whole tower
        const layers = Math.max(1, Math.round((b.y1 - b.y0) / (size * 2)));
        for (let l = 0; l < layers; l++) {
          const ya = b.y0 + (b.y1 - b.y0) * l / layers, yb = b.y0 + (b.y1 - b.y0) * (l + 1) / layers;
          const t = { ...tags, '+y': { side: '+y', ext: l === layers - 1 }, '-y': { side: '-y', ext: false } };
          const chunks = [];
          shatter(boxPoly(b.x0, ya, b.z0, b.x1, yb, b.z1, t), size, chunks);
          for (const ch of chunks) { const s2 = rnd(0.88, 1.1); pieces.push(piece(ch, b, concrete0.map((v) => v * s2))); }
          yield;
        }
      }
      const out = pack(pieces, false);
      bld.done = true;
      return { msg: { op: 'cut', job: msg.job, b: msg.b, data: out.data }, transfer: out.transfer };
    }
    // The shell model: a box as storeys of four outer walls on a floor slab (the slab spans the whole
    // footprint, so its edge is part of the facade), with a concrete core in wide buildings. Every
    // plate is cut on its own; kind: 1 wall, 2 slab, 3 core.
    function* shell(b, size, m, concrete, pieces) {
      const n = Math.max(1, Math.round((b.y1 - b.y0) / m.storey)), r = { x0: b.x0, x1: b.x1, z0: b.z0, z1: b.z1 };
      for (let i = 0; i < n; i++) {
        const plates = [];
        shellPlates(b, m, r, b.y0 + ((b.y1 - b.y0) * i) / n, b.y0 + ((b.y1 - b.y0) * (i + 1)) / n, 1, plates);
        for (const pl of plates) { const out = []; shatter(pl.poly, size, out); for (const ch of out) pieces.push(piece(ch, b, concrete.map((v) => v * rnd(0.88, 1.1)), { kind: pl.kind })); }
        yield;
      }
    }
    function* refine(msg) {
      const bld = buildings.get(msg.b), empty = { msg: { op: 'refine', job: msg.job, b: msg.b, data: null, victims: [] }, transfer: [] };
      if (!bld) return empty;
      const [px, py, pz] = msg.p, dir = msg.dir, skip = new Set(msg.exclude || []), cand = [];
      bld.pieces.forEach((pc, i) => {
        if (pc.refined || skip.has(i)) return;
        const { lo, hi } = pc;
        if (Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) <= msg.size * 1.3) return;   // small enough already
        const dx = Math.max(lo[0] - px, 0, px - hi[0]), dy = Math.max(lo[1] - py, 0, py - hi[1]), dz = Math.max(lo[2] - pz, 0, pz - hi[2]), dist = Math.hypot(dx, dy, dz);
        if (dist > msg.reach) return;
        // the side facing the shooter: the chunk's nearest part not deeper than `depth` into the building
        if (dir) {
          const nx = Math.max(lo[0], Math.min(px, hi[0])), ny = Math.max(lo[1], Math.min(py, hi[1])), nz = Math.max(lo[2], Math.min(pz, hi[2]));
          const cx = dir[0] > 0 ? lo[0] : hi[0], cy = dir[1] > 0 ? lo[1] : hi[1], cz = dir[2] > 0 ? lo[2] : hi[2];   // the corner nearest the shooter
          const depth = Math.min((nx - px) * dir[0] + (ny - py) * dir[1] + (nz - pz) * dir[2], (cx - px) * dir[0] + (cy - py) * dir[1] + (cz - pz) * dir[2]);
          if (depth > msg.depth) return;
        }
        cand.push({ i, dist });
      });
      cand.sort((a, b) => a.dist - b.dist);
      const pieces = [], victims = [];
      for (const { i } of cand) {
        const pc = bld.pieces[i], out = [];
        shatter(pc.poly, msg.size, out);
        if (pieces.length && pieces.length + out.length > msg.cap) break;
        for (const ch of out) pieces.push(piece(ch, pc.box, pc.tint, { src: i, kind: pc.kind }));
        pc.refined = true; victims.push(i);
        yield;
      }
      if (!pieces.length) return empty;
      const out = pack(pieces, true);
      return { msg: { op: 'refine', job: msg.job, b: msg.b, data: out.data, victims }, transfer: out.transfer };
    }
    const jobs = [];
    let running = false;
    function pick() {
      let best = null;
      for (const j of jobs) if (!best || j.prio > best.prio) best = j;
      if (best && best.kind === 'refine') {                        // a building's cut comes before its refinements
        const c = jobs.find((j) => j.kind === 'cut' && j.b === best.b);
        if (c) best = c;
      }
      return best;
    }
    function tick() {
      const t0 = Date.now();
      while (jobs.length && Date.now() - t0 < sliceMs) {
        const j = pick();
        let r;
        try { r = j.gen.next(); } catch (e) { r = { done: true, value: { msg: { op: j.kind, job: j.job, b: j.b, data: null, victims: [], error: String(e) }, transfer: [] } }; }
        if (r.done) { jobs.splice(jobs.indexOf(j), 1); port.postMessage(r.value.msg, r.value.transfer); }
      }
      if (jobs.length) setTimeout(tick, 0); else running = false;
    }
    port.onmessage = (e) => {
      const m = e.data;
      if (m.op === 'cut' || m.op === 'refine') jobs.push({ kind: m.op, job: m.job, b: m.b, prio: m.prio || 1, gen: m.op === 'cut' ? cut(m) : refine(m) });
      else if (m.op === 'prio') { for (const j of jobs) if (j.b === m.b) j.prio = Math.max(j.prio, m.prio); }
      else if (m.op === 'drop') buildings.delete(m.b);
      if (jobs.length && !running) { running = true; setTimeout(tick, 0); }
    };
    port.postMessage({ op: 'ready' });
    return lib;
  }
})();
