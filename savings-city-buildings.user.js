// ==UserScript==
// @name         Savings City – solid buildings
// @namespace    savings-city-tweaks
// @version      1.5
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
 *   concrete in the wall's colour. All chunks go into one mesh with the facade material; every
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
 * - collapse(building, opts) in two styles:
 *     from an impact (opts.at, opts.out): the floor there fails first, the failure spreads, what's
 *       above drops and leans towards the hole, the floors below pancake;
 *     pushed (opts.push = direction, opts.force, opts.spread): a crack runs from opts.at through the
 *       building and the chunks are thrown the push's way (upper floors more) – a monster's punch.
 *   Either way a jagged stump stays, dust rolls out, people inside and right next to it die
 *   (residents' crush, sc:crush), and walk mode rebuilds its walls (sc:geometry-changed).
 * - Chunk physics: gravity, tumbling, landing on the ground, tipping onto the largest face, rest.
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
    const set = { mesh, g, pos: g.attributes.position, nor: g.attributes.normal, col: g.attributes.color, frs, active: false, dusty: !!opts.dusty, center: opts.center || null };
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
        orig: d.orig.subarray(start * 3, (start + count) * 3), n0: d.n0.subarray(start * 3, (start + count) * 3), state: 'still', idx: d.src ? d.src[i] : i, fine: !!d.src });
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
    let ax = rnd(-1, 1), ay = rnd(-0.5, 0.5), az = rnd(-1, 1); const al = Math.hypot(ax, ay, az) || 1;
    Object.assign(fr, { state: 'flying', v, delay, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], off: [0, 0, 0], axis: [ax / al, ay / al, az / al], w: spin, landed: false, age: 0, slide });
    set.active = true;
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
        fr.v[1] -= 6 * dt;                                           // gravity
        for (let a = 0; a < 3; a++) fr.off[a] += fr.v[a] * dt;
        if (!fr.landed) fr.R = mul(rot(...fr.axis, fr.w * dt), fr.R);   // tumbling through the air
        else {
          // on the ground: tip over until it lies on its largest face
          const [x, y, z] = fr.normal, R = fr.R;
          const n = [R[0] * x + R[1] * y + R[2] * z, R[3] * x + R[4] * y + R[5] * z, R[6] * x + R[7] * y + R[8] * z];
          const tilt = Math.acos(Math.min(1, Math.max(-1, -n[1])));
          if (tilt > 0.01) { let ax = n[2], az = -n[0]; let l = Math.hypot(ax, az); if (l < 1e-6) { ax = 1; az = 0; l = 1; } fr.R = mul(rot(ax / l, 0, az / l, Math.min(tilt, 6 * dt)), R); }
          const f = Math.exp(-(fr.slide ? 2 : 5) * dt); fr.v[0] *= f; fr.v[2] *= f;
          if ((tilt <= 0.01 && Math.hypot(fr.v[0], fr.v[2]) < 0.05) || fr.age > 12) fr.state = 'rest';
        }
        let minY = writeChunk(set, fr);
        if (minY < GROUND) {
          fr.off[1] += GROUND - minY;
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
        lo = Math.min(lo, fr.start); hi = Math.max(hi, fr.start + fr.count);
      }
      // upload only the part that moved (add ranges; never clear them first – see CONTEXT.md)
      if (hi > 0) for (const a of [set.pos, set.nor]) { if (a.addUpdateRange) a.addUpdateRange(lo * 3, (hi - lo) * 3); a.needsUpdate = true; }
      if (!busy) set.active = false;
    }
  }
  function writeChunk(set, fr) {
    const { orig, n0, R, pivot, off } = fr, pos = set.pos, nor = set.nor;
    let minY = Infinity;
    for (let n = 0, k = fr.start; n < fr.count; n++, k++) {
      const a = orig[n * 3], b = orig[n * 3 + 1], c = orig[n * 3 + 2];
      const py = pivot[1] + off[1] + R[3] * a + R[4] * b + R[5] * c;
      pos.setXYZ(k, pivot[0] + off[0] + R[0] * a + R[1] * b + R[2] * c, py, pivot[2] + off[2] + R[6] * a + R[7] * b + R[8] * c);
      const p = n0[n * 3], q = n0[n * 3 + 1], r = n0[n * 3 + 2];
      nor.setXYZ(k, R[0] * p + R[1] * q + R[2] * r, R[3] * p + R[4] * q + R[5] * r, R[6] * p + R[7] * q + R[8] * r);
      if (py < minY) minY = py;
    }
    return minY;
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
  function chunkSizeFor(bd) {
    const volume = bd.boxes.reduce((v, b) => v + (b.x1 - b.x0) * (b.y1 - b.y0) * (b.z1 - b.z0), 0);
    const f = C() && C().detail ? C().detail().factor : 1;
    return Math.max(CHUNK_SIZE / Math.cbrt(f), Math.cbrt((7.7 * volume) / (MAX_CHUNKS * f)));
  }
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
    const st = { bd, hits: 0, ready: false, set: null, sets: [], shown: false, down: false, wave: null, pending: [], spots: [], refining: 0, size: chunkSizeFor(bd), t0: performance.now() };
    solids.set(bd.id, st);
    getCutter().send({ op: 'cut', b: bd.id, boxes: plainBoxes(bd.boxes), size: st.size, prio }).then((m) => {
      try {
        st.set = packedSet(m.data, facadeMat(bd), { hidden: true, dusty: true, center: [bd.cx, bd.cz] });
        st.sets.push(st.set);
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
    const set = packedSet(d, facadeMat(st.bd), { hidden: !st.shown, dusty: true, center: [st.bd.cx, st.bd.cz] });
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
    for (let step = 0; step < 4 && n && standing(p) < 6; step++) p = { x: p.x - out.x * R * 0.8, y: p.y - (out.y || 0) * R * 0.8, z: p.z - out.z * R * 0.8 };
    let count = 0;
    for (const set of st.sets) for (const fr of set.frs) {
      if (fr.state !== 'still') continue;
      const dx = fr.pivot[0] - p.x, dy = fr.pivot[1] - p.y, dz = fr.pivot[2] - p.z, d = Math.hypot(dx, dy, dz);
      if (d > R * rnd(0.85, 1.15)) continue;
      const l = d || 1, sp = rnd(0.6, 2.2) * (1 - d / (R * 1.2) * 0.5);
      launch(set, fr, [(dx / l) * 0.5 * sp + out.x * sp + rnd(-0.3, 0.3), (dy / l) * 0.4 * sp + rnd(0.2, 1), (dz / l) * 0.5 * sp + out.z * sp + rnd(-0.3, 0.3)], 0, rnd(4, 12));
      count++;
    }
    return count;
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
  function fall(st, opts) {
    swapIn(st);
    lightsOut(st);
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
        if (fr.state !== 'still' || fr.pivot[1] < 0.03 + Math.random() * STUMP) continue;
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
        if (fr.state !== 'still' || fr.pivot[1] < 0.03 + Math.random() * STUMP) continue;
        const dh = Math.hypot(fr.pivot[0] - p.x, fr.pivot[2] - p.z), dy = fr.pivot[1] - p.y;
        let delay, v;
        if (dy > -0.06) {
          const up = Math.min(1, Math.max(0, dy) / H);
          delay = 0.12 + dh / COLLAPSE_SPREAD * 0.6 + rnd(0, 0.08);
          const lean = COLLAPSE_LEAN * (0.25 + up) * rnd(0.7, 1.2);
          v = [nx * lean + (fr.pivot[0] - cx) * rnd(0, 0.3) + rnd(-0.08, 0.08), rnd(-0.3, 0), nz * lean + (fr.pivot[2] - cz) * rnd(0, 0.3) + rnd(-0.08, 0.08)];
        } else {
          delay = 0.35 + dh / COLLAPSE_SPREAD + (-dy) * 1.8 + rnd(0, 0.15);
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
      return { solid: true, ready: st.ready, cutMs: st.cutMs && Math.round(st.cutMs), down: st.down, hits: st.hits, fine: all.filter((f) => f.fine).length, chunks: all.length, standing: all.filter((f) => f.state === 'still').length }; },
    crater, hit, collapse, blastWave, claim,
    get cutter() { return cutter ? cutter.mode : null; },        // 'worker' or 'page' (no worker could be made)
    // low-level, for scripts with their own plans (the nuke)
    geometry: { readMasses, boxPoly: geo.boxPoly, shatter: geo.shatter, pieceTriangles: geo.pieceTriangles, newell: geo.newell, bounds: geo.bounds, isFacade, JF },
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


    // the texture mapping of a wall at point p (the numbers from readMasses)
    function wallUV(w, p) { return [w.ua + (p[w.along] - w.sa) * w.du, w.va + (p[1] - w.ya) * w.dv]; }
    const lib = { boxPoly, split, shatter, pieceTriangles, newell, bounds, JF };
    if (!port) return lib;

    // ---- pieces → flat arrays ----
    function largest(poly) { let big = null, area = -1; for (const f of poly) { const a = Math.hypot(...newell(f.v)); if (a > area) { area = a; big = f.n; } } return big; }
    function pack(pieces, withSrc) {
      let V = 0;
      const tris = pieces.map((pc) => { const t = pieceTriangles(pc.poly, pc.box, pc.tint); V += t.length * 3; return t; });
      const P = pieces.length, pos = new Float32Array(V * 3), nor = new Float32Array(V * 3), col = new Float32Array(V * 3), uv = new Float32Array(V * 2), orig = new Float32Array(V * 3);
      const meta = new Float32Array(P * 14), src = withSrc ? new Int32Array(P) : null;
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
      }
      const data = { pos, nor, n0: nor.slice(), col, uv, orig, meta, src, P };
      return { data, transfer: [pos.buffer, nor.buffer, data.n0.buffer, col.buffer, uv.buffer, orig.buffer, meta.buffer].concat(src ? [src.buffer] : []) };
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
        const wall = b.wallColor, concrete0 = [wall[0] * 0.55 + 0.15, wall[1] * 0.55 + 0.145, wall[2] * 0.55 + 0.14];
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
        for (const ch of out) pieces.push(piece(ch, pc.box, pc.tint, { src: i }));
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
