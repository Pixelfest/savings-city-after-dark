// ==UserScript==
// @name         Savings City – nuke
// @namespace    savings-city-tweaks
// @version      3.4
// @description  A ☢ button: after a 10 second countdown a nuclear bomb goes off in the centre of the city. Flash, shockwave, buildings blown to pieces, mushroom cloud, camera shake. Only in your browser – reload to rebuild.
// @match        https://your-savings-city-host.example/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * How it works
 * ------------
 * - The scene, renderer, camera, traffic and three.js classes come from the core script
 *   (savings-city-core); buildings are cut and their chunks moved by the solid-buildings script
 *   (savings-city-buildings), which this script plans for: which part of each building stays, when
 *   each chunk flies and how. Buildings already in chunks (rockets, the monster) fly with the wave too.
 *   All three.js classes are borrowed from objects already in the scene (no extra download).
 * - Nearly everything the app draws is merged geometry with a colour per vertex (city blocks of
 *   buildings, trees, lots). When the shockwave front passes, every triangle is handled by its
 *   distance from ground zero:
 *     – within TOTAL_RADIUS: everything above the foundations is blown away;
 *     – further out: things are broken off above a height that grows towards the edge;
 *     – what's left is scorched (vertex colours darkened, more so near the centre).
 * - Buildings are solids: the boxes their walls are made of are cut (during the countdown) into a
 *   ruin of uneven columns and, above that, convex chunks (CHUNK_SIZE) with the facade (windows,
 *   colours) on the outside and broken concrete inside. At the flash the walls are swapped for
 *   these pieces; when the shockwave reaches a chunk it is flung outward and up, tumbles, lands and
 *   comes to rest on its largest face. Nothing stands near ground zero; further out more of each
 *   building remains (RUIN_SHARE), jagged (RUIN_JAGGED).
 *   Other things (roof details, trees …) above the ruins vanish into rubble cubes.
 *   Small rubble cubes in the building's colours fly along as gravel.
 * - Mushroom cloud, fireball, shockwave dome and dust ring are low-poly shapes; the cloud is a few
 *   hundred instanced puffs (cap that rolls outward, stem, skirt), glowing first, then cooling.
 * - Camera shake = shaking the canvas element, so it also works in walk mode.
 * - Residents (residents script) all run, and fall as the wave reaches them. Cars are vaporised
 *   near the centre and burnt out further away; all of them stop.
 * - Yield: clicking ☢ opens a popup to pick the yield in tonnes of TNT (presets from a hand grenade
 *   to the Tsar Bomba). Blast radii follow the cube root of the yield (TOTAL_PER_KT, EDGE_PER_KT
 *   per kiloton), the shockwave takes as long as it needs to get there, chunks fly harder, the
 *   mushroom cloud grows with yield^0.25 (kept within what the view can show), flash and shake too.
 * - Target: after the popup the mouse is a crosshair with two red rings on the ground (flattened
 *   completely / edge of the damage); a click sets ground zero (in walk mode: where you look).
 * - B-2 bomber: during the countdown a flying wing crosses the city at BOMBER_ALTITUDE, from a
 *   random direction, straight over ground zero. It releases the bomb BOMB_FALL seconds before
 *   the end of the countdown; the bomb keeps the plane's speed and falls (gravity chosen so it
 *   lands in exactly BOMB_FALL seconds), so it reaches ground zero just as it goes off. If the
 *   destruction isn't worked out yet at that moment, the bomb lies there until it is.
 * - If the app later rebuilds parts of the city (e.g. after a data refresh), those are destroyed
 *   again straight away. Nothing is sent to the server: reload the page and the city is back.
 */
(function () {
  'use strict';

  // sound through the core's output, which follows the app's own sound button (mute + volume)
  const out = (ctx) => (window.scCore ? window.scCore.out(ctx) : ctx.destination);


  // ---- settings (distances in tiles; 1 tile ≈ 20 m) --------------------------------------
  const COUNTDOWN = 10;            // seconds between the click and the blast (0 = immediately)
  const DEFAULT_YIELD = 15000;     // tonnes of TNT offered in the popup the first time (Hiroshima: 15 000 t)
  // Yield → effects (1 tile ≈ 20 m). Blast radii scale with the cube root of the yield (the usual
  // scaling law); per kiloton: flattened completely within TOTAL_PER_KT, damage up to EDGE_PER_KT.
  const TOTAL_PER_KT = 10;         // tiles (≈ 200 m: the 20 psi ring of a 1 kt air burst)
  const EDGE_PER_KT = 37;          // tiles (≈ 740 m: ~2 psi, windows and light damage)
  const WAVE_TILES_PER_SECOND = 13;// how fast the shockwave travels outward (sets how long it takes)
  const CLOUD_PER_KT = 25;         // mushroom cloud height in tiles for 1 kt; grows with yield^0.25 (kept within view)
  const WAVE_DELAY = 0.2;          // the wave leaves after the flash, so you can see the buildings break
  const FLASH_SECONDS = 0.6;       // white flash: short, so it doesn't hide the destruction
  const LIGHT_BOOST = 3.5;         // how much brighter the scene gets for a moment (was 7)
  const FOUNDATION_HEIGHT = 0.03;  // things lower than this survive even at ground zero
  const MAX_DEBRIS = 1500;        // pieces of rubble (instanced cubes; each moves every frame until it lies still) – × the detail setting's factor
  const BLAST_SPEED = 22;          // how hard chunks and rubble are flung outward near the centre, for 15 kt (scales with the yield; was 10)
  const CHUNK_SIZE = 0.2;          // buildings break into solid chunks about this big (tiles); smaller = more chunks
  const RUIN_COLUMN = 0.3;         // the ruin's broken top is made of columns about this wide (wider when the chunks are bigger)
  const RUIN_SHARE = 0.75;         // at the edge of the blast this share of a building still stands (less towards the centre, none in the middle)
  const RUIN_JAGGED = 0.12;        // how much the broken tops of neighbouring columns differ (tiles; 0 = one flat cut)
  const MAX_CHUNK_VERTICES = 60000;    // (× the detail setting's factor: 1, 2, 4, 8, 16) for a big city the chunk size is raised so they stay below about this (every moving chunk's
                                       // vertices are recomputed and uploaded each frame: this is what the blast costs)
  const SCATTER_DEGREES = 15;      // pieces fly away from ground zero ± this much, so debris mixes (was 35: now clearly outward)
  const GRAVEL = 0.12;             // other things (roof details, trees …) blown away: chance per triangle of a rubble cube
  const CLOUD_PUFFS = 500;
  const CLOUD_LINGER = 20;         // after this many seconds the cloud rises and drifts away
  const SHAKE = 22;                // camera shake strength (pixels)
  const SOUND = true;
  const BOMBER = true;             // a B-2 flies over during the countdown and drops the bomb
  const BOMBER_ALTITUDE = 21;      // tiles (≈ 420 m)
  const BOMBER_SPEED = 6;          // tiles per second
  const BOMB_FALL = 5;             // seconds from release to impact (= the blast): released early, the plane is well away
  const BOMBER_SPAN = 8;           // wingspan in tiles (a real B-2: 52 m = 2.6 tiles; bigger reads better from above)
  // -----------------------------------------------------------------------------------------

  // ---------- the scene, renderer, camera and traffic: from the core script, every frame ----------
  let scene = null, renderer = null, appCam = null, trafficCars = null;
  const B = () => window.scBuildings;
  function sync() {
    const c = window.scCore; if (!c) return;
    scene = c.scene || scene; renderer = c.renderer || renderer; appCam = c.camera || appCam; trafficCars = c.traffic() || trafficCars;
  }
  (function attach() {
    const c = window.scCore;
    if (!c) { if ((attach.n = (attach.n || 0) + 1) < 240) setTimeout(attach, 250); else console.warn('[nuke] savings-city-core is missing'); return; }
    c.onFrame(sync); sync();
  })();

  // ---------- small helpers ----------
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const smooth = (x) => { x = clamp01(x); return x * x * (3 - 2 * x); };
  const rnd = (a, b) => a + Math.random() * (b - a);
  const mine = (o) => { for (let p = o; p; p = p.parent) if (p.userData && p.userData.scNuke) return true; return false; };

  let K = null;   // borrowed three.js classes
  function classes() { sync(); return K || (K = window.scCore && window.scCore.classes()); }


  function geometry(pos, nor, col) {
    const g = new K.Geometry();
    g.setAttribute('position', new K.Attr(new Float32Array(pos), 3));
    g.setAttribute('normal', new K.Attr(new Float32Array(nor), 3));
    if (col) g.setAttribute('color', new K.Attr(new Float32Array(col), 3));
    return g;
  }
  // Low-poly ball (icosahedron, flat shaded), radius 1.
  function icosa() {
    const t = (1 + Math.sqrt(5)) / 2;
    const v = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map((p) => { const l = Math.hypot(...p); return p.map((c) => c / l); });
    const f = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
    const P = [], N = [];
    for (const [a, b, c] of f) {
      const A = v[a], B = v[b], C = v[c];
      const n = [(A[0] + B[0] + C[0]) / 3, (A[1] + B[1] + C[1]) / 3, (A[2] + B[2] + C[2]) / 3], l = Math.hypot(...n);
      for (const p of [A, B, C]) { P.push(...p); N.push(n[0] / l, n[1] / l, n[2] / l); }
    }
    return geometry(P, N);
  }
  function cube() {
    const P = [], N = [], h = 0.5;
    const quad = (a, b, c, e, n) => { for (const v of [a, b, c, a, c, e]) { P.push(...v); N.push(...n); } };
    quad([-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h], [0, 0, 1]); quad([h, -h, -h], [-h, -h, -h], [-h, h, -h], [h, h, -h], [0, 0, -1]);
    quad([h, -h, h], [h, -h, -h], [h, h, -h], [h, h, h], [1, 0, 0]); quad([-h, -h, -h], [-h, -h, h], [-h, h, h], [-h, h, -h], [-1, 0, 0]);
    quad([-h, h, h], [h, h, h], [h, h, -h], [-h, h, -h], [0, 1, 0]); quad([-h, -h, -h], [h, -h, -h], [h, -h, h], [-h, -h, h], [0, -1, 0]);
    return geometry(P, N);
  }
  // Half a ball (open at the bottom), radius 1 – the shockwave dome.
  function dome() {
    const P = [], N = [], S = 16, R = 6;
    const pt = (i, j) => { const a = (i / S) * Math.PI * 2, b = (j / R) * Math.PI / 2; return [Math.cos(a) * Math.cos(b), Math.sin(b), Math.sin(a) * Math.cos(b)]; };
    for (let i = 0; i < S; i++) for (let j = 0; j < R; j++) {
      const a = pt(i, j), b = pt(i + 1, j), c = pt(i + 1, j + 1), d = pt(i, j + 1);
      for (const p of [a, c, b, a, d, c]) { P.push(...p); N.push(...p); }
    }
    return geometry(P, N);
  }
  // Flat ring from radius `inner` to 1, facing up.
  function ring(inner) {
    const P = [], N = [], S = 48;
    for (let i = 0; i < S; i++) {
      const a0 = (i / S) * Math.PI * 2, a1 = ((i + 1) / S) * Math.PI * 2;
      const o0 = [Math.cos(a0), 0, Math.sin(a0)], o1 = [Math.cos(a1), 0, Math.sin(a1)];
      const i0 = o0.map((v) => v * inner), i1 = o1.map((v) => v * inner);
      for (const p of [i0, o1, o0, i0, i1, o1]) { P.push(...p); N.push(0, 1, 0); }
    }
    return geometry(P, N);
  }
  // Scorched ground: a disc, dark in the middle fading to grass colour at the rim.
  function scorchDisc() {
    const P = [], N = [], C = [], S = 48, rings = 6;
    const mid = new K.Color('#1f1b18'), rim = new K.Color('#b9d49b'), tmp = new K.Color();
    const col = (f) => { tmp.copy(mid).lerp(rim, f * f); return [tmp.r, tmp.g, tmp.b]; };
    for (let r = 0; r < rings; r++) {
      const f0 = r / rings, f1 = (r + 1) / rings;
      for (let i = 0; i < S; i++) {
        const a0 = (i / S) * Math.PI * 2, a1 = ((i + 1) / S) * Math.PI * 2;
        const p = (f, a) => [Math.cos(a) * f, 0, Math.sin(a) * f];
        const quad = [[p(f0, a0), f0], [p(f1, a1), f1], [p(f1, a0), f1], [p(f0, a0), f0], [p(f0, a1), f0], [p(f1, a1), f1]];
        for (const [v, f] of quad) { P.push(...v); N.push(0, 1, 0); C.push(...col(f)); }
      }
    }
    return geometry(P, N, C);
  }

  // ---------- the city: centre and size ----------
  function cityShape() {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity, n = 0;
    scene.traverse((g) => {
      if (!g.userData || g.userData.projectId === undefined) return;
      n++;
      x0 = Math.min(x0, g.position.x); z0 = Math.min(z0, g.position.z);
      x1 = Math.max(x1, g.position.x + 2); z1 = Math.max(z1, g.position.z + 2);
    });
    if (!n) return { cx: 0, cz: 0, R: 10 };
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    return { cx, cz, R: Math.max(4, Math.hypot(x1 - x0, z1 - z0) / 2) };
  }

  // ---------- state ----------
  let nuke = null;   // { t0, cx, cz, R, total, edge, H, ... }
  const elapsed = () => (performance.now() - nuke.t0) / 1000;
  const front = (t) => { t = Math.max(0, t - WAVE_DELAY); return nuke.edge * clamp01((1 - Math.exp(-t / (nuke.wave / 3.5))) / (1 - Math.exp(-3.5))); };
  // How high things may still stand at distance d once the wave has passed.
  function keepHeight(d) {
    if (d <= nuke.total) return FOUNDATION_HEIGHT;
    const f = clamp01((d - nuke.total) / (nuke.edge - nuke.total));
    return FOUNDATION_HEIGHT + f * f * f * 4;
  }
  const scorch = (d) => 0.22 + 0.78 * smooth(d / nuke.edge);

  // ---------- destroying geometry ----------
  // Every mesh in reach gets a list of its triangles (or vertices) sorted by distance from ground
  // zero; each frame the ones the front has passed are handled.
  const prepared = new WeakSet();
  const jobs = [];
  let debrisChance = 1;

  function eligible(o) {
    if (mine(o) || o.isInstancedMesh || o.isSkinnedMesh || o.userData.scSolid || o.userData.scPuff) return false;
    if (!(o.isMesh || o.isPoints) || !o.geometry || !o.geometry.attributes.position) return false;
    const ms = Array.isArray(o.material) ? o.material : [o.material];
    if (o.isMesh && ms.some((m) => m && m.isShaderMaterial)) return false;
    if (o.isPoints && ms.some((m) => m && m.uniforms && m.uniforms.uCenter)) return false;   // snowfall
    const g = o.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    const b = g.boundingBox;
    if (b.max.x - b.min.x > 300 || b.max.z - b.min.z > 300) return false;                      // the ground plane
    return true;
  }

  function prepare(o, uses, instant) {
    if (uses.get(o.geometry) > 1) o.geometry = o.geometry.clone();   // shared geometry: give this mesh its own copy
    const g = o.geometry;
    prepared.add(g);
    o.updateWorldMatrix(true, false);
    const e = o.matrixWorld.elements, pos = g.attributes.position, col = g.attributes.color, idx = g.index;
    const wx = (i) => e[0] * pos.getX(i) + e[4] * pos.getY(i) + e[8] * pos.getZ(i) + e[12];
    const wy = (i) => e[1] * pos.getX(i) + e[5] * pos.getY(i) + e[9] * pos.getZ(i) + e[13];
    const wz = (i) => e[2] * pos.getX(i) + e[6] * pos.getY(i) + e[10] * pos.getZ(i) + e[14];
    const triMode = o.isMesh && !idx;
    const n = triMode ? Math.floor(pos.count / 3) : pos.count;   // a stray vertex count must not stop everything
    const dist = new Float32Array(n), order = new Uint32Array(n);
    let breakable = 0;
    let mats = Array.isArray(o.material) ? o.material[0] : o.material;
    for (let k = 0; k < n; k++) {
      let x, z;
      if (triMode) { const i = k * 3; x = (wx(i) + wx(i + 1) + wx(i + 2)) / 3; z = (wz(i) + wz(i + 1) + wz(i + 2)) / 3; }
      else { x = wx(k); z = wz(k); }
      dist[k] = Math.hypot(x - nuke.cx, z - nuke.cz);
      order[k] = k;
      // will this piece be blown off? (for the debris budget)
      if (triMode && dist[k] <= nuke.edge) { const i = k * 3; if (Math.max(wy(i), wy(i + 1), wy(i + 2)) > keepHeight(dist[k])) breakable++; }
    }
    order.sort((a, b) => dist[a] - dist[b]);
    let shown = true; for (let q = o; q; q = q.parent) if (!q.visible) shown = false;   // hidden copies only vanish
    const job = { o, g, pos, col, nor: g.attributes.normal, triMode, dist, order, next: 0, wx, wy, wz, inv: null, matColor: mats && mats.color, visible: o.visible, breakable,
      animate: triMode && o.isMesh && shown, frags: null };
    jobs.push(job);
    if (instant) advance(job, front(elapsed()), false);
    return job;
  }

  function advance(job, f, makeDebris) {
    const { pos, col, order, dist } = job;
    let changed = false;
    while (job.next < order.length && dist[order[job.next]] <= f) {
      const k = order[job.next++], d = dist[k];
      if (d > nuke.edge) { job.next = order.length; break; }
      const keep = keepHeight(d), dark = scorch(d);
      changed = true;
      if (job.solid && job.solid[k]) continue;                  // part of a solid building: handled as chunks
      if (job.triMode) {
        const i = k * 3;
        const y0 = job.wy(i), y1 = job.wy(i + 1), y2 = job.wy(i + 2), cy = (y0 + y1 + y2) / 3;
        const lo = Math.min(y0, y1, y2), hi = Math.max(y0, y1, y2);
        if (hi <= keep) {
          // stays: scorched
          if (col) for (let v = i; v < i + 3; v++) col.setXYZ(v, col.getX(v) * dark, col.getY(v) * dark, col.getZ(v) * dark);
        } else if (lo < keep && keep > FOUNDATION_HEIGHT) {
          // a wall reaching above the break height: broken off there (top part becomes debris)
          if (makeDebris && Math.random() < debrisChance) spawnDebris(job, i, d, (keep + hi) / 2);
          if (!job.inv) job.inv = job.o.matrixWorld.clone().invert();
          for (let v = i; v < i + 3; v++) {
            if (job.wy(v) > keep) { const w = new K.V3(job.wx(v), keep, job.wz(v)).applyMatrix4(job.inv); pos.setXYZ(v, w.x, w.y, w.z); }
            if (col) col.setXYZ(v, col.getX(v) * dark, col.getY(v) * dark, col.getZ(v) * dark);
          }
        } else {
          if (makeDebris && Math.random() < debrisChance * GRAVEL) spawnDebris(job, i, d, cy);
          // blown off (a roof detail, a tree …): gone, the rubble cube above flies for it
          const lx = (pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3, ly = (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3, lz = (pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2)) / 3;
          for (let v = i; v < i + 3; v++) pos.setXYZ(v, lx, ly, lz);
        }
      } else {
        // indexed meshes and point clouds: squash vertices down to what may still stand
        const y = job.wy(k);
        if (y > keep) {
          if (job.o.isPoints) pos.setY(k, pos.getY(k) - 1000);           // lights in blown-away trees: gone
          else {
            if (!job.inv) job.inv = job.o.matrixWorld.clone().invert();
            const v = new K.V3(job.wx(k), keep, job.wz(k)).applyMatrix4(job.inv);
            pos.setXYZ(k, v.x, v.y, v.z);
          }
        }
        if (col) col.setXYZ(k, col.getX(k) * dark, col.getY(k) * dark, col.getZ(k) * dark);
      }
    }
    if (changed) {
      pos.needsUpdate = true;
      if (col) col.needsUpdate = true;
      job.g.boundingSphere = null;
    }
  }

  function scan(instant) {
    const uses = new Map(), list = [];
    scene.traverse((o) => { if (o.geometry) uses.set(o.geometry, (uses.get(o.geometry) || 0) + 1); if (eligible(o) && !prepared.has(o.geometry)) list.push(o); });
    let added = 0;
    for (const o of list) {
      if (prepared.has(o.geometry)) continue;
      try { prepare(o, uses, instant); added++; } catch (e) { prepared.add(o.geometry); console.warn('[nuke] skipped', o.name || o.type, e); }
    }
    if (added && instant) window.dispatchEvent(new Event('sc:geometry-changed'));
    return added;
  }

  // ---------- flying chunks ----------
  // Chunks (see "solid buildings" below) are prepared during the countdown, so the blast itself
  // only has to set them moving (the solid-buildings script moves them: they tumble, land and tip
  // onto their largest face).
  let nukeRoot = null;

  // how a chunk at `pivot`, `d` from ground zero, flies: away from ground zero, turned a random
  // bit so neighbouring buildings' debris mixes, faster near the centre
  function flight(pivot, d) {
    const [cx, cy, cz] = pivot;
    const turn = rnd(-1, 1) * SCATTER_DEGREES * Math.PI / 180, bx = (cx - nuke.cx) / (d || 1), bz = (cz - nuke.cz) / (d || 1);
    const dx = bx * Math.cos(turn) - bz * Math.sin(turn), dz = bx * Math.sin(turn) + bz * Math.cos(turn);
    // outward first: strong all the way to the edge of the damage, only a little upward
    const power = Math.pow(1 - clamp01(d / nuke.edge), 0.4);
    const out = nuke.speed * power * rnd(0.75, 1.25) + 1;
    return { v: [dx * out + rnd(-0.1, 0.1), rnd(0.3, 1.2) * power + 0.25 + cy * 0.2, dz * out + rnd(-0.1, 0.1)], spin: rnd(1.5, 7) * power + 0.6 };
  }
  // The shockwave reached this chunk: it starts flying.
  function launch(fr) {
    if (fr.active) return;
    fr.active = true;
    const f = flight(fr.pivot, fr.d || 1);
    B().launch(solid.set, fr, f.v, 0, f.spin, true);              // (slides on along the ground: blown away)
  }
  // buildings already in chunks before the blast (rockets, the monster): what's above the ruin's
  // height there flies like the rest
  function waveOverSolids(front) {
    const b = B(); if (!b) return;
    b.blastWave(nuke.cx, nuke.cz, Math.min(front, nuke.edge), (fr, d) => (fr.pivot[1] > keepHeight(d) ? flight(fr.pivot, d) : null));
  }

  // ---------- solid buildings ----------
  // Every building's walls are made by the app from rectangular boxes ("masses": a rectangle of
  // walls plus a flat top, one box per tier), all in one indexed facade mesh per building. Those
  // boxes are the building's solid volume. During the countdown each box is cut into columns
  // (RUIN_COLUMN wide), each column gets its own break height (the ruin's jagged top), and
  // everything above that is cut into convex chunks by random planes (about CHUNK_SIZE big).
  // Outside faces of the chunks keep the facade: same texture coordinates (windows) and colours
  // as the original walls and roof; faces inside the building are broken concrete.
  // At the flash the original walls are swapped for these pieces (they look the same); when the
  // shockwave reaches a chunk it flies off, the ruin stays, scorched, with a broken concrete top.
  const solid = { boxes: [], pieces: [], set: null, next: 0, verts: 0, hiddenMeshes: [], claims: new Set() };

  // How high a column of a ruin still stands, for a building of height H: nothing near the centre,
  // a growing share of the building further out, uneven from column to column.
  function columnKeep(d, H) {
    if (d > nuke.edge) return Infinity;
    if (d <= nuke.total) return FOUNDATION_HEIGHT;
    const f = clamp01((d - nuke.total) / (nuke.edge - nuke.total));
    let k = FOUNDATION_HEIGHT + (H - FOUNDATION_HEIGHT) * RUIN_SHARE * Math.pow(f, 0.8) + RUIN_JAGGED * rnd(-1, 1);
    if (Math.random() < 0.15) k -= RUIN_JAGGED * rnd(1, 2.5);      // a part that came down further
    return Math.max(FOUNDATION_HEIGHT, k);
  }

  function* planSolids() {
    if (!B()) throw new Error('savings-city-buildings is missing');
    const { readMasses, boxPoly, shatter, pieceTriangles, newell, bounds, isFacade } = B().geometry;
    // all buildings' boxes, nearest first (not the ones already in chunks: they fly with waveOverSolids)
    const masses = [];
    scene.traverse((o) => {
      if (!o.isMesh || o.isInstancedMesh || !o.geometry || !o.geometry.index || mine(o)) return;
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      if (!isFacade(m)) return;
      let pid = null; for (let p = o; p && pid === null; p = p.parent) if (p.userData && p.userData.projectId !== undefined) pid = p.userData.projectId;
      if (pid !== null && !B().isSolid(pid)) { o.userData.scPid = pid; masses.push(o); }
    });
    let mat = null;
    for (const o of masses) {
      const boxes = readMasses(o);
      for (const b of boxes) {
        const dx = Math.max(b.x0 - nuke.cx, 0, nuke.cx - b.x1), dz = Math.max(b.z0 - nuke.cz, 0, nuke.cz - b.z1);
        b.dMin = Math.hypot(dx, dz);
        if (b.dMin > nuke.edge) continue;                          // out of reach: stays as it is
        b.mesh = o; solid.boxes.push(b);
        solid.claims.add(o.userData.scPid);                         // ours at the flash: rockets and the monster leave it alone
      }
      mat = mat || (Array.isArray(o.material) ? o.material[0] : o.material);
      yield;
    }
    if (!solid.boxes.length || !mat) return;
    solid.boxes.sort((a, b) => a.dMin - b.dMin);
    // One chunk size for the whole city, raised for a big city so the pieces stay within budget.
    // (A chunk is cut until it is no longer than the size in any direction: never a long stick.)
    // Measured: about 140 vertices per (volume ÷ size³), ruins included (their columns grow with the size).
    let volume = 0;
    for (const b of solid.boxes) volume += (b.x1 - b.x0) * (b.z1 - b.z0) * (b.y1 - b.y0);
    const f = detailFactor();
    const size = Math.max(CHUNK_SIZE / Math.cbrt(f), Math.cbrt((volume * 140) / (MAX_CHUNK_VERTICES * f)));
    solid.size = size;
    // per box: columns with their own break height; below it a static ruin, above it chunks
    for (const b of solid.boxes) {
      const col = Math.max(RUIN_COLUMN, size * 0.8);                // with big chunks, wider ruin columns too
      const nx = Math.max(1, Math.round((b.x1 - b.x0) / col)), nz = Math.max(1, Math.round((b.z1 - b.z0) / col));
      const xs = [b.x0], zs = [b.z0];
      for (let i = 1; i < nx; i++) xs.push(b.x0 + (b.x1 - b.x0) * (i + rnd(-0.25, 0.25)) / nx); xs.push(b.x1);
      for (let i = 1; i < nz; i++) zs.push(b.z0 + (b.z1 - b.z0) * (i + rnd(-0.25, 0.25)) / nz); zs.push(b.z1);
      const wall = b.wallColor, concreteBase = [wall[0] * 0.55 + 0.15, wall[1] * 0.55 + 0.145, wall[2] * 0.55 + 0.14];   // broken inside: the building's colour, dusty
      const H = Math.max(...b.siblings.map((s) => s.y1));
      for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
        const x0 = xs[i], x1 = xs[i + 1], z0 = zs[j], z1 = zs[j + 1];
        const d = Math.hypot((x0 + x1) / 2 - nuke.cx, (z0 + z1) / 2 - nuke.cz);
        const keep = Math.min(b.y1, Math.max(b.y0, columnKeep(d, H)));
        const tags = (yTop) => ({
          '+x': { side: '+x', ext: Math.abs(x1 - b.x1) < 1e-6 }, '-x': { side: '-x', ext: Math.abs(x0 - b.x0) < 1e-6 },
          '+z': { side: '+z', ext: Math.abs(z1 - b.z1) < 1e-6 }, '-z': { side: '-z', ext: Math.abs(z0 - b.z0) < 1e-6 },
          '+y': { side: '+y', ext: Math.abs(yTop - b.y1) < 1e-6 }, '-y': { side: '-y', ext: false },
        });
        const shade = rnd(0.88, 1.08), concrete = concreteBase.map((v) => v * shade);
        if (keep > b.y0 + 1e-4) {                                 // the ruin that stays
          const tris = pieceTriangles(boxPoly(x0, b.y0, z0, x1, keep, z1, tags(keep)), b, concrete);
          solid.pieces.push({ tris, d, still: true, dark: scorch(d) });
          solid.verts += tris.length * 3;
        }
        if (b.y1 > keep + 1e-4) {                                 // what gets blown away
          const chunks = [];
          shatter(boxPoly(x0, keep, z0, x1, b.y1, z1, tags(b.y1)), size, chunks);
          for (const ch of chunks) {
            const s2 = rnd(0.9, 1.1), tris = pieceTriangles(ch, b, concrete.map((v) => v * s2));
            const { lo, hi } = bounds(ch);
            const cx = (lo[0] + hi[0]) / 2, cz = (lo[2] + hi[2]) / 2;
            let big = null, area = -1;                            // it lands on its largest face
            for (const f of ch) { const a = Math.hypot(...newell(f.v)); if (a > area) { area = a; big = f.n; } }
            solid.pieces.push({ tris, d: Math.hypot(cx - nuke.cx, cz - nuke.cz), still: false, normal: big, dark: scorch(d) });
            solid.verts += tris.length * 3;
          }
        }
      }
      yield;
    }
    solid.mat = mat;
  }

  // Which triangles of the drawn city meshes belong to a box that is replaced: hidden at the flash.
  function* flagSolidTriangles() {
    if (!solid.boxes.length) return;
    const cell = new Map(), key = (x, z) => Math.floor(x) + ',' + Math.floor(z);
    for (const b of solid.boxes) for (let x = Math.floor(b.x0); x <= Math.floor(b.x1); x++) for (let z = Math.floor(b.z0); z <= Math.floor(b.z1); z++) {
      const k = x + ',' + z; (cell.get(k) || cell.set(k, []).get(k)).push(b);
    }
    const E = 1e-3;
    const within = (b, x, y, z) => x >= b.x0 - E && x <= b.x1 + E && y >= b.y0 - E && y <= b.y1 + E && z >= b.z0 - E && z <= b.z1 + E;
    const onSurface = (b, x, y, z) => Math.abs(x - b.x0) < E || Math.abs(x - b.x1) < E || Math.abs(z - b.z0) < E || Math.abs(z - b.z1) < E || Math.abs(y - b.y1) < E;
    for (const job of jobs) {
      if (!job.animate || !job.triMode) continue;
      const n = job.order.length;
      let flags = null;
      for (let k = 0; k < n; k++) {
        const i = k * 3;
        const cx = (job.wx(i) + job.wx(i + 1) + job.wx(i + 2)) / 3, cz = (job.wz(i) + job.wz(i + 1) + job.wz(i + 2)) / 3;
        const list = cell.get(key(cx, cz));
        if (!list) continue;
        for (const b of list) {
          let ok = true;
          for (let v = i; v < i + 3 && ok; v++) { const x = job.wx(v), y = job.wy(v), z = job.wz(v); ok = within(b, x, y, z) && onSurface(b, x, y, z); }
          if (ok) { (flags || (flags = new Uint8Array(n)))[k] = 1; break; }
        }
        if (k % 20000 === 19999) yield;
      }
      if (flags) { job.solid = flags; let c = 0; for (const f of flags) c += f; job.breakable = Math.max(0, job.breakable - c); }
      yield;
    }
  }

  // Write all pieces into one layer with the facade material (the solid-buildings script's chunk
  // set); drawn from the flash on.
  function buildSolids() {
    if (!solid.pieces.length || !solid.mat) return;
    solid.pieces.sort((a, b) => a.d - b.d);
    const set = B().chunkSet(solid.pieces, solid.mat, { parent: nukeRoot, hidden: true, release: true });
    solid.pieces.forEach((pc, i) => { pc.fr = set.frs[i]; });
    solid.set = set; solid.mesh = set.mesh;
  }

  // The flash: original walls out, solid pieces in (they look the same).
  function showSolids() {
    if (!solid.mesh) return;
    solid.mesh.visible = true;
    for (const pid of solid.claims) B().claim(pid);
    for (const job of jobs) {
      if (!job.solid) continue;
      const pos = job.pos;
      for (let k = 0; k < job.solid.length; k++) {
        if (!job.solid[k]) continue;
        const i = k * 3, lx = (pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3, ly = (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3, lz = (pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2)) / 3;
        for (let v = i; v < i + 3; v++) pos.setXYZ(v, lx, ly, lz);
      }
      pos.needsUpdate = true; job.g.boundingSphere = null;
    }
    // a building drawn on its own (not merged into a city block) is simply hidden
    const swapped = new Set(solid.boxes.map((b) => b.mesh));
    for (const o of swapped) { let shown = true; for (let q = o; q; q = q.parent) if (!q.visible) shown = false; if (shown) o.visible = false; }
  }

  // Each frame: pieces the front has passed fly off (chunks) or get scorched (the ruin).
  function advanceSolids(f) {
    if (!solid.set) return;
    const pcs = solid.pieces, C = solid.set.col;
    let scorched = false, lo = Infinity, hi = -Infinity;
    while (solid.next < pcs.length && pcs[solid.next].d <= f) {
      const fr = pcs[solid.next++].fr;
      lo = Math.min(lo, fr.start); hi = Math.max(hi, fr.start + fr.count);
      if (fr.still) {
        for (let k = fr.start; k < fr.start + fr.count; k++) C.setXYZ(k, C.getX(k) * fr.dark, C.getY(k) * fr.dark, C.getZ(k) * fr.dark);
        scorched = true;
      } else {
        const dk = 0.55 + 0.45 * fr.dark;                         // flying chunks: a little scorched
        for (let k = fr.start; k < fr.start + fr.count; k++) C.setXYZ(k, C.getX(k) * dk, C.getY(k) * dk, C.getZ(k) * dk);
        scorched = true;
        launch(fr);
        if (debris && Math.random() < 0.08 * debrisChance) spawnDebrisAt(fr.pivot[0], fr.pivot[1], fr.pivot[2], fr.d, [C.getX(fr.start), C.getY(fr.start), C.getZ(fr.start)], 0.03);
      }
    }
    if (scorched) {
      if (C.addUpdateRange) { C.addUpdateRange(lo * 3, (hi - lo) * 3); }
      C.needsUpdate = true;
    }
  }

  // ---------- debris ----------
  let debris = null, dN = 0;
  // how much rubble: MAX_DEBRIS × the detail setting's factor (fixed when the bomb is prepared)
  const detailFactor = () => (window.scCore && window.scCore.detail ? window.scCore.detail().factor : 1);
  let maxDebris = MAX_DEBRIS, D = null;
  function allocDebris() {
    maxDebris = MAX_DEBRIS * detailFactor();
    D = { p: new Float32Array(maxDebris * 3), v: new Float32Array(maxDebris * 3), r: new Float32Array(maxDebris * 3), w: new Float32Array(maxDebris * 3), s: new Float32Array(maxDebris), rest: new Uint8Array(maxDebris) };
  }

  function spawnDebris(job, i, d, cy) {
    if (!debris || dN >= maxDebris) return;
    const x = (job.wx(i) + job.wx(i + 1) + job.wx(i + 2)) / 3, z = (job.wz(i) + job.wz(i + 1) + job.wz(i + 2)) / 3;
    // size from the triangle's area
    const ax = job.wx(i + 1) - job.wx(i), ay = job.wy(i + 1) - job.wy(i), az = job.wz(i + 1) - job.wz(i);
    const bx = job.wx(i + 2) - job.wx(i), by = job.wy(i + 2) - job.wy(i), bz = job.wz(i + 2) - job.wz(i);
    const area = Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx) / 2;
    const size = Math.max(0.05, Math.min(0.12, Math.sqrt(area) * 0.8));    // rubble between the big chunks (no dust-sized bits)
    const color = job.col ? [job.col.getX(i), job.col.getY(i), job.col.getZ(i)] : job.matColor ? [job.matColor.r, job.matColor.g, job.matColor.b] : null;
    spawnDebrisAt(x, cy, z, d, color, size);
  }
  function spawnDebrisAt(x, cy, z, d, color, size) {
    if (!debris || dN >= maxDebris) return;
    const k = dN++;
    const dx = (x - nuke.cx) / (d || 1), dz = (z - nuke.cz) / (d || 1);
    const power = Math.pow(1 - clamp01(d / nuke.edge), 0.4);
    const out = nuke.speed * power * rnd(0.6, 1.2) + 0.5;
    D.p.set([x, cy, z], k * 3);
    D.v.set([dx * out + rnd(-0.2, 0.2), rnd(0.3, 1.6) * power + cy * 0.25, dz * out + rnd(-0.2, 0.2)], k * 3);
    D.r.set([rnd(0, 6), rnd(0, 6), rnd(0, 6)], k * 3);
    D.w.set([rnd(-9, 9), rnd(-9, 9), rnd(-9, 9)], k * 3);
    D.s[k] = size; D.rest[k] = 0;
    const c = new K.Color();
    if (color) c.setRGB(color[0], color[1], color[2]); else c.set('#8a8580');
    c.multiplyScalar(0.55 + 0.35 * Math.random());              // dirty, scorched
    debris.setColorAt(k, c);
    debris.instanceColor.needsUpdate = true;
  }

  const tmpM = () => ({ m: new K.M4(), q: new K.Q(), e: new (scene.rotation.constructor)(), v: new K.V3(), s: new K.V3() });
  let T = null;
  function stepDebris(dt) {
    if (!debris) return;
    let moved = false;
    for (let k = 0; k < dN; k++) {
      if (D.rest[k] === 2) continue;
      const j = k * 3, s = D.s[k];
      D.v[j + 1] -= 6 * dt;                                       // gravity
      D.p[j] += D.v[j] * dt; D.p[j + 1] += D.v[j + 1] * dt; D.p[j + 2] += D.v[j + 2] * dt;
      D.r[j] += D.w[j] * dt; D.r[j + 1] += D.w[j + 1] * dt; D.r[j + 2] += D.w[j + 2] * dt;
      if (D.p[j + 1] < s / 2) {                                   // hits the ground: bounce a little, slide, stop
        D.p[j + 1] = s / 2;
        D.v[j] *= 0.45; D.v[j + 2] *= 0.45; D.v[j + 1] = Math.abs(D.v[j + 1]) * 0.2;
        for (let a = 0; a < 3; a++) D.w[j + a] *= 0.4;
        if (Math.hypot(D.v[j], D.v[j + 1], D.v[j + 2]) < 0.05) D.rest[k] = 1;
      }
      T.e.set(D.r[j], D.r[j + 1], D.r[j + 2]);
      T.q.setFromEuler(T.e);
      T.m.compose(T.v.set(D.p[j], D.p[j + 1], D.p[j + 2]), T.q, T.s.set(s, s, s));
      debris.setMatrixAt(k, T.m);
      if (D.rest[k] === 1) D.rest[k] = 2;                         // final position written: done
      moved = true;
    }
    debris.count = dN;
    if (moved) debris.instanceMatrix.needsUpdate = true;
  }

  // ---------- mushroom cloud ----------
  let cloud = null, cloudMat = null, fireball = null, shell = null, dust = null, disc = null;
  const puffs = [];
  const SMOKE = ['#5d5550', '#6e6660', '#7d7570', '#4c4643', '#8a827b', '#6a5a4e'];
  function makeCloud() {
    for (let i = 0; i < CLOUD_PUFFS; i++) {
      const u = i / CLOUD_PUFFS;
      const kind = u < 0.5 ? 'cap' : u < 0.62 ? 'top' : u < 0.86 ? 'stem' : 'skirt';
      puffs.push({ kind, phi: i * 2.39996, theta: rnd(0, Math.PI * 2), r: Math.random(), y0: Math.random(), sp: rnd(0.6, 1.4), sz: rnd(0.75, 1.25), smoke: new K.Color(SMOKE[i % SMOKE.length]) });
    }
  }
  const FIRE_HOT = () => new K.Color('#fff1b8'), FIRE = () => new K.Color('#ff8a2a'), FIRE_DEEP = () => new K.Color('#c2361a');
  let fc = null;
  function stepCloud(t) {
    // after CLOUD_LINGER: the whole cloud lifts off, drifts away with the wind, spreads and thins out
    const H = nuke.H, L = Math.max(0, t - CLOUD_LINGER);
    const lift = H * (0.05 * L + 0.004 * L * L), cx = nuke.cx + H * 0.06 * L, cz = nuke.cz + H * 0.02 * L;
    const g = smooth(t / 9), wide = smooth((t - 0.5) / 10);
    const Hc = 0.12 * H + 0.88 * H * g, Rc = 0.06 * H + 0.3 * H * wide, rt = 0.08 * H + 0.12 * H * wide, stemR = 0.04 * H + 0.05 * g * H;
    const gather = smooth(t / 1.6);                               // at first everything is the fireball
    const fade = 1 - clamp01((L - 8) / 30), stemFade = 1 - clamp01(L / 8), spread = 1 + 0.035 * L;
    if (!fc) fc = { hot: FIRE_HOT(), fire: FIRE(), deep: FIRE_DEEP(), c: new K.Color() };
    puffs.forEach((p, i) => {
      let x, y, z, s;
      if (p.kind === 'cap') {
        const th = p.theta - t * 0.55 * p.sp;                     // rolling outward over the top
        const rr = Rc + rt * Math.cos(th);
        x = rr * Math.cos(p.phi); z = rr * Math.sin(p.phi); y = Hc + rt * Math.sin(th) * 0.75; s = rt * 0.62 * p.sz;
      } else if (p.kind === 'top') {
        // the middle of the cap boils: each puff drifts from the centre out into the rolling ring
        // (and starts again in the middle), swirls slowly round, bobs and swells on its own beat
        const f = (p.r + t * 0.035 * p.sp) % 1, ph = p.phi + t * 0.06 * p.sp, beat = t * 0.9 * p.sp + p.phi * 3;
        const rr = Rc * 0.9 * Math.sqrt(f);
        x = rr * Math.cos(ph); z = rr * Math.sin(ph);
        y = Hc + rt * (0.55 + 0.12 * Math.sin(beat) - 0.25 * f * f);   // sinks a little towards the edge, where the roll takes over
        s = rt * 0.7 * p.sz * (1 + 0.12 * Math.sin(beat * 1.3 + 1)) * (f < 0.1 ? 0.6 + 4 * f : 1);   // (swells up again in the middle)
      } else if (p.kind === 'stem') {
        const f = (p.y0 + t * 0.04 * p.sp) % 1;                   // smoke rising up the stem
        const rr = stemR * (1 + 1.6 * Math.pow(1 - f, 3)) * (0.3 + 0.7 * p.r);
        x = rr * Math.cos(p.phi); z = rr * Math.sin(p.phi); y = f * Math.max(0, Hc - rt * 0.4); s = stemR * (0.9 + 0.8 * (1 - f)) * p.sz;
      } else {
        // dust skirt: keeps rolling outward and swirling, drifts with the wind, slowly settles
        const rr = (0.1 * H + 0.45 * H * smooth(t / 6) + 0.012 * H * t) * (0.75 + 0.5 * p.r);
        const ph = p.phi + t * 0.04 * p.sp;
        const wind = H * 0.012 * Math.max(0, t - 3);
        x = rr * Math.cos(ph) + wind; z = rr * Math.sin(ph) + wind * 0.3;
        y = 0.04 * H * p.r + 0.012 * H * Math.sin(t * 0.6 * p.sp + p.phi * 3) + 0.004 * H * t;
        s = 0.06 * H * (0.7 + 0.6 * p.r) * smooth(t / 1.2) * (1 + 0.02 * t) * (1 - smooth((t - 12) / 30));
      }
      // gather into the fireball at the start
      x *= gather; z *= gather; y = 0.1 * H + (y - 0.1 * H) * gather;
      s *= fade * (0.35 + 0.65 * gather) * spread * (p.kind === 'stem' ? stemFade : 1);
      x *= spread; z *= spread;
      if (p.kind !== 'skirt') y += lift * (p.kind === 'stem' ? 0.6 : 1);
      T.m.compose(T.v.set(cx + x, y, cz + z), T.q.set(0, 0, 0, 1), T.s.set(s, s * 0.85, s));
      cloud.setMatrixAt(i, T.m);
      // colour: white-hot → orange → deep red → smoke; the cap's underside and the stem stay hot longest
      const heat = clamp01(1 - t / (p.kind === 'skirt' ? 3 : 8) + (p.kind === 'cap' && y < Hc ? 0.15 : 0) - p.r * 0.15);
      const c = fc.c.copy(p.smoke);
      if (heat > 0) {
        const fire = heat > 0.66 ? fc.c.clone().copy(fc.fire).lerp(fc.hot, (heat - 0.66) / 0.34) : heat > 0.33 ? fc.c.clone().copy(fc.deep).lerp(fc.fire, (heat - 0.33) / 0.33) : fc.deep.clone();
        c.copy(p.smoke).lerp(fire, smooth(heat * 1.5));
      }
      cloud.setColorAt(i, c);
    });
    cloud.instanceMatrix.needsUpdate = true;
    cloud.instanceColor.needsUpdate = true;
    cloudMat.emissiveIntensity = 1.4 * Math.exp(-t / 3.5);
    cloud.visible = fade > 0;

    // fireball: white core that swells, rises and fades into the cap
    const fb = smooth(t / 0.8) * (1 - smooth((t - 2) / 3));
    fireball.visible = fb > 0.01;
    fireball.scale.setScalar(0.2 * H * fb + 0.001);
    fireball.position.set(nuke.cx, 0.1 * H + (Hc - 0.1 * H) * smooth((t - 1) / 6), nuke.cz);
    fireball.material.emissive.copy(fc.hot).lerp(fc.fire, clamp01(t / 3));
  }

  // ---------- shockwave visuals ----------
  function stepWave(t) {
    const f = front(t), done = f >= nuke.edge * 0.999;
    const k = clamp01(f / nuke.edge);
    shell.visible = !done; dust.visible = t < nuke.wave + 4;
    shell.scale.set(f + 0.01, (f + 0.01) * 0.55, f + 0.01);
    shell.material.opacity = 0.16 * (1 - k);
    dust.scale.set(f + 0.01, 1, f + 0.01);
    dust.material.opacity = 0.7 * (1 - clamp01((t - nuke.wave) / 4));
    disc.scale.set(Math.min(f, nuke.edge * 0.95) + 0.01, 1, Math.min(f, nuke.edge * 0.95) + 0.01);
  }

  // ---------- flash, light and shake ----------
  let lights = [], flashEl = null, countEl = null;
  function stepLight(t) {
    const boost = 1 + (nuke.light - 1) * Math.exp(-t / 0.18) + 0.25 * Math.exp(-t / 3);
    for (const L of lights) L.o.intensity = L.i * boost;
    if (flashEl) flashEl.style.opacity = String(t < 0.08 ? 1 : Math.max(0, 1 - (t - 0.08) / FLASH_SECONDS) ** 2);
  }
  function stepShake(t) {
    const el = renderer && renderer.domElement; if (!el) return;
    const arrive = Math.exp(-Math.pow((t - WAVE_DELAY - 1.2) / 0.6, 2));   // the wave rolling under the camera
    const a = nuke.shake * (Math.exp(-t / 1.1) + 0.8 * arrive + 0.25 * Math.exp(-t / 6));
    if (a < 0.2) { el.style.transform = ''; return; }
    const x = (Math.random() * 2 - 1) * a, y = (Math.random() * 2 - 1) * a, r = (Math.random() * 2 - 1) * a * 0.02;
    el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) rotate(${r.toFixed(2)}deg)`;
  }

  // ---------- residents and cars ----------
  const carsDone = new Set();
  // People are hit while the shockwave passes – once. After that the area is a place to stay away
  // from (residents walk round it and out of it), so nobody walks to their death in the ruins.
  const waving = (t) => t <= WAVE_DELAY + nuke.wave + 0.3;
  function stepPeople(t, f) {
    const res = window.scResidents;
    if (!res) return;
    if (!nuke.alarmed && typeof res.alarm === 'function') {
      res.alarm(nuke.cx, nuke.cz, nuke.edge * 2, 20); nuke.alarmed = true;   // who saw and heard it runs
      if (typeof res.avoid === 'function') res.avoid(nuke.cx, nuke.cz, nuke.edge, Infinity);
    }
    if (!waving(t)) return;
    if (typeof res.blast === 'function') res.blast(nuke.cx, nuke.cz, f, 0, 0);
    if (typeof res.killInside === 'function') res.killInside(nuke.cx, nuke.cz, Math.min(f, nuke.edge));   // indoors isn't safe either
  }
  function stepCars(f, maintain, wave) {
    if (!trafficCars) return;
    const proxies = new Map(), batches = [];
    if (maintain) scene.traverse((o) => {
      if (o.userData && o.userData.car && typeof o.userData.car.index === 'number') proxies.set(o.userData.car.index, o);
      if (o.isInstancedMesh && Array.isArray(o.userData.cars)) batches.push(o);
    });
    trafficCars.forEach((car, i) => {
      const d = Math.hypot(car.x - nuke.cx, car.z - nuke.cz);
      if (d > f || d > nuke.edge) return;
      if (!carsDone.has(car) && !wave) return;                   // the wave has passed: cars driving in now are fine
      car.parked = Infinity; car.speed = 0;
      if (!carsDone.has(car)) {
        carsDone.add(car);
        window.dispatchEvent(new CustomEvent('sc:car-exploded', { detail: { x: car.x, z: car.z, cause: 'nuke' } }));
        if (!car.scAbandoned) for (let n = 1 + (Math.random() < 0.5 ? 1 : 0); n > 0; n--) window.dispatchEvent(new CustomEvent('sc:kill', { detail: { x: car.x, z: car.z, cause: 'nuke', who: 'occupant' } }));
        if (d <= nuke.total && debris) for (let n = 0; n < 6 && dN < maxDebris; n++) {   // a few car parts flying off
          const k = dN++, dx = (car.x - nuke.cx) / (d || 1), dz = (car.z - nuke.cz) / (d || 1);
          D.p.set([car.x, 0.07, car.z], k * 3); D.v.set([dx * rnd(1, 3), rnd(0.5, 1.8), dz * rnd(1, 3)], k * 3);
          D.r.set([0, 0, 0], k * 3); D.w.set([rnd(-9, 9), rnd(-9, 9), rnd(-9, 9)], k * 3); D.s[k] = rnd(0.02, 0.045); D.rest[k] = 0;
          debris.setColorAt(k, new K.Color(n % 2 ? '#2a2a2e' : '#59606b')); debris.instanceColor.needsUpdate = true;
        }
      }
      if (!maintain) return;
      const proxy = proxies.get(i);
      if (d <= nuke.total) { if (proxy) proxy.scale.setScalar(0.0001); }      // vaporised
      else for (const b of batches) {                                       // burnt out
        const slot = b.userData.cars.indexOf(i);
        if (slot >= 0) { b.setColorAt(slot, new K.Color('#24201e')); b.instanceColor.needsUpdate = true; }
      }
    });
  }

  // ---------- sound ----------
  let audio = null;
  function tone(freq, dur, vol) {
    if (!SOUND) return;
    try {
      audio = audio || new AudioContext();
      const a = audio, t = a.currentTime, o = a.createOscillator(), g = a.createGain();
      o.frequency.value = freq; o.connect(g); g.connect(out(a));
      g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.start(t); o.stop(t + dur);
    } catch {}
  }
  function boom() {
    if (!SOUND) return;
    try {
      audio = audio || new AudioContext();
      const a = audio, t = a.currentTime, len = 9;
      const buf = a.createBuffer(1, Math.floor(a.sampleRate * len), a.sampleRate), ch = buf.getChannelData(0);
      let last = 0;
      for (let i = 0; i < ch.length; i++) { last = last * 0.96 + (Math.random() * 2 - 1) * 0.04; ch[i] = last * 6 * Math.pow(1 - i / ch.length, 1.6); }
      const src = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain();
      f.type = 'lowpass'; f.frequency.setValueAtTime(1200, t); f.frequency.exponentialRampToValueAtTime(70, t + 4);
      src.buffer = buf; src.connect(f); f.connect(g); g.connect(out(a));
      g.gain.setValueAtTime(1.2, t);
      src.start(t);
      const sub = a.createOscillator(), sg = a.createGain();
      sub.type = 'sine'; sub.frequency.setValueAtTime(55, t); sub.frequency.exponentialRampToValueAtTime(22, t + 5);
      sg.gain.setValueAtTime(0.8, t); sg.gain.exponentialRampToValueAtTime(0.001, t + 6);
      sub.connect(sg); sg.connect(out(a)); sub.start(t); sub.stop(t + 6);
    } catch {}
  }

  // ---------- yield ----------
  // Everything the blast does follows from the yield (tonnes of TNT).
  let yieldTons = DEFAULT_YIELD;
  function effects(tons) {
    const kt = Math.max(1e-6, tons / 1000), k3 = Math.cbrt(kt);
    const total = TOTAL_PER_KT * k3, edge = EDGE_PER_KT * k3;
    return {
      yield: tons, total, edge,
      wave: Math.min(16, Math.max(0.8, edge / WAVE_TILES_PER_SECOND)),                // seconds for the wave to reach the edge
      speed: Math.min(60, Math.max(4, BLAST_SPEED * Math.sqrt(total / (TOTAL_PER_KT * Math.cbrt(15))))),
      H: Math.min(150, Math.max(1.2, CLOUD_PER_KT * Math.pow(kt, 0.25))),             // mushroom cloud height
      shake: SHAKE * Math.min(2, Math.max(0.15, Math.sqrt(edge / (EDGE_PER_KT * Math.cbrt(15))))),
      light: 1 + (LIGHT_BOOST - 1) * Math.min(1.4, Math.max(0.25, Math.pow(kt / 15, 0.15))),
    };
  }
  const fmtTons = (t) => t < 1 ? (t * 1000).toLocaleString('nl-NL', { maximumFractionDigits: 2 }) + ' kg' : t >= 1e6 ? (t / 1e6).toLocaleString('nl-NL', { maximumFractionDigits: 2 }) + ' Mt' : t >= 1000 ? (t / 1000).toLocaleString('nl-NL', { maximumFractionDigits: 2 }) + ' kt' : t.toLocaleString('nl-NL', { maximumFractionDigits: 2 }) + ' t';
  const fmtM = (tiles) => { const m = tiles * 20; return m >= 1000 ? (m / 1000).toLocaleString('nl-NL', { maximumFractionDigits: 1 }) + ' km' : Math.round(m) + ' m'; };

  // the popup: pick the yield, see what it does
  let popup = null;
  const PRESETS = [['Granaat', 0.0002], ['MOAB', 11], ['Davy Crockett', 20], ['Hiroshima', 15000], ['Nagasaki', 21000], ['W88', 475000], ['Castle Bravo', 15e6], ['Tsar Bomba', 50e6]];
  const LOG_MIN = Math.log10(0.0001), LOG_MAX = Math.log10(1e8);
  function openPopup() {
    if (popup) return;
    try { const v = parseFloat(localStorage.getItem('sc-nuke:yield')); if (v > 0) yieldTons = v; } catch {}
    const locked = preparing || ready;                         // the destruction is already worked out for this yield
    popup = document.createElement('div');
    popup.id = 'sc-nuke-popup';
    popup.innerHTML = `
      <style>
        #sc-nuke-popup{position:fixed;inset:0;z-index:10050;display:flex;align-items:center;justify-content:center;background:rgba(10,12,20,.45);font:500 15px/1.4 system-ui,sans-serif}
        #sc-nuke-popup .box{width:min(440px,calc(100vw - 32px));background:#1d2233;color:#fff;border-radius:16px;padding:20px 22px;box-shadow:0 12px 40px rgba(0,0,0,.5)}
        #sc-nuke-popup h2{margin:0 0 4px;font:800 22px/1.2 system-ui,sans-serif;color:#ffd23f}
        #sc-nuke-popup .sub{opacity:.75;font-size:13px;margin-bottom:14px}
        #sc-nuke-popup label{display:block;font-weight:700;margin:10px 0 6px}
        #sc-nuke-popup .row{display:flex;gap:8px;align-items:center}
        #sc-nuke-popup input[type=number]{flex:1;min-width:0;font:700 18px system-ui,sans-serif;padding:8px 10px;border-radius:10px;border:0;background:#fff;color:#223}
        #sc-nuke-popup input[type=range]{width:100%;margin:12px 0 4px;accent-color:#ffd23f}
        #sc-nuke-popup .presets{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 12px}
        #sc-nuke-popup .presets button{border:0;border-radius:8px;padding:5px 9px;background:#2f3650;color:#fff;font:600 13px system-ui,sans-serif;cursor:pointer}
        #sc-nuke-popup .presets button:hover{background:#414a6b}
        #sc-nuke-popup .fx{background:#151927;border-radius:10px;padding:10px 12px;font-size:14px;display:grid;grid-template-columns:1fr auto;gap:3px 12px}
        #sc-nuke-popup .fx b{text-align:right;font-variant-numeric:tabular-nums}
        #sc-nuke-popup .note{font-size:12px;opacity:.7;margin-top:8px}
        #sc-nuke-popup .buttons{display:flex;gap:10px;justify-content:flex-end;margin-top:16px}
        #sc-nuke-popup .buttons button{border:0;border-radius:10px;padding:10px 18px;font:800 15px system-ui,sans-serif;cursor:pointer}
        #sc-nuke-popup .fire{background:#e8313f;color:#fff}
        #sc-nuke-popup .cancel{background:#3a4160;color:#fff}
      </style>
      <div class="box" role="dialog" aria-label="Kernbom">
        <h2>☢ Kernbom</h2>
        <div class="sub">Hoe zwaar? In ton TNT.</div>
        <label for="sc-nuke-yield">Kracht (ton TNT)</label>
        <div class="row"><input id="sc-nuke-yield" type="number" min="0.0001" max="100000000" step="any"><span class="unit"></span></div>
        <input type="range" min="0" max="1000" step="1" aria-label="Kracht">
        <div class="presets">${PRESETS.map(([n, t]) => `<button type="button" data-t="${t}">${n}<br><small>${fmtTons(t)}</small></button>`).join('')}</div>
        <div class="fx">
          <span>Alles plat binnen</span><b class="r-total"></b>
          <span>Schade tot</span><b class="r-edge"></b>
          <span>Paddenstoelwolk</span><b class="r-cloud"></b>
          <span>Drukgolf</span><b class="r-wave"></b>
        </div>
        ${locked ? '<div class="note">De verwoesting is al uitgerekend voor deze kracht. Herlaad de pagina om een andere te kiezen.</div>' : ''}
        <div class="buttons"><button type="button" class="cancel">Annuleren</button><button type="button" class="fire">Afvuren</button></div>
      </div>`;
    document.body.appendChild(popup);
    const num = popup.querySelector('input[type=number]'), range = popup.querySelector('input[type=range]'), unit = popup.querySelector('.unit');
    const show = (tons, from) => {
      tons = Math.min(1e8, Math.max(0.0001, tons || 0.0001));
      yieldTons = tons;
      if (from !== 'num') num.value = String(+tons.toPrecision(4));
      if (from !== 'range') range.value = String(Math.round((Math.log10(tons) - LOG_MIN) / (LOG_MAX - LOG_MIN) * 1000));
      unit.textContent = '= ' + fmtTons(tons);
      const fx = effects(tons);
      popup.querySelector('.r-total').textContent = fmtM(fx.total);
      popup.querySelector('.r-edge').textContent = fmtM(fx.edge);
      popup.querySelector('.r-cloud').textContent = fmtM(fx.H) + ' hoog';
      popup.querySelector('.r-wave').textContent = fx.wave.toFixed(1).replace('.', ',') + ' s tot de rand';
    };
    show(yieldTons);
    if (locked) { num.disabled = range.disabled = true; popup.querySelectorAll('.presets button').forEach((b) => { b.disabled = true; b.style.opacity = 0.4; }); }
    num.addEventListener('input', () => show(parseFloat(num.value), 'num'));
    range.addEventListener('input', () => show(Math.pow(10, LOG_MIN + (LOG_MAX - LOG_MIN) * range.value / 1000), 'range'));
    popup.querySelectorAll('.presets button').forEach((b) => b.addEventListener('click', () => show(parseFloat(b.dataset.t))));
    const close = () => { popup.remove(); popup = null; document.removeEventListener('keydown', key, true); };
    const fire = () => { try { localStorage.setItem('sc-nuke:yield', String(yieldTons)); } catch {} close(); if (locked) startCountdown(); else pickTarget(startCountdown); };
    const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } else if (e.key === 'Enter') { e.stopPropagation(); fire(); } };
    document.addEventListener('keydown', key, true);
    popup.querySelector('.cancel').addEventListener('click', close);
    popup.querySelector('.fire').addEventListener('click', fire);
    popup.addEventListener('click', (e) => { if (e.target === popup) close(); });
    setTimeout(() => num.focus(), 0);
  }

  // ---------- picking the target ----------
  // After the popup: the mouse becomes a crosshair; two red rings on the ground follow it (flattened
  // completely / edge of the damage). A click (not a drag – dragging still moves the map) sets
  // ground zero; Esc cancels. In walk mode: where you're looking, up to 30 tiles away.
  let target = null, picking = null;
  const CROSSHAIR = "url(\"data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><g fill="none" stroke="#ff2a2a" stroke-width="2"><circle cx="20" cy="20" r="11"/><path d="M20 2v12M20 26v12M2 20h12M26 20h12"/></g><circle cx="20" cy="20" r="2" fill="#ff2a2a"/></svg>') + "\") 20 20, crosshair";
  function groundAt(clientX, clientY) {
    const el = renderer && renderer.domElement; if (!el || !appCam) return null;
    const r = el.getBoundingClientRect(), nx = ((clientX - r.left) / r.width) * 2 - 1, ny = -((clientY - r.top) / r.height) * 2 + 1;
    const a = new K.V3(nx, ny, -1).unproject(appCam), b = new K.V3(nx, ny, 1).unproject(appCam);
    const dy = b.y - a.y; if (Math.abs(dy) < 1e-9) return null;
    const t = -a.y / dy; if (t < 0) return null;
    return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
  }
  function pickTarget(done) {
    if (!scene || !classes()) { alert('De 3D-stad is nog niet geladen.'); return; }
    const w = window.scWalk;
    if (w && w.walking && w.player) {                            // walk mode: where you look
      const p = w.player, d = { x: -Math.sin(p.yaw) * Math.cos(p.pitch), y: Math.sin(p.pitch), z: -Math.cos(p.yaw) * Math.cos(p.pitch) };
      const t = d.y < -0.01 ? Math.min(30, p.y / -d.y) : 30;
      target = { x: p.x + d.x * t, z: p.z + d.z * t };
      done(); return;
    }
    const fx = effects(yieldTons), el = renderer.domElement;
    const mat = (col, op) => new K.Lambert({ color: col, emissive: col, transparent: true, opacity: op, depthWrite: false, depthTest: false, side: 2 });
    const outer = new K.Mesh(ring(0.96), mat('#ff2a2a', 0.8)), inner = new K.Mesh(ring(0.9), mat('#ff2a2a', 0.9)), fill = new K.Mesh(ring(0), mat('#ff2a2a', 0.12));
    const marker = new K.Object3D(); marker.userData.scNuke = true;
    for (const m of [outer, inner, fill]) { m.renderOrder = 999; m.frustumCulled = false; marker.add(m); }
    outer.scale.set(fx.edge, 1, fx.edge); fill.scale.set(fx.edge, 1, fx.edge); inner.scale.set(Math.max(0.3, fx.total), 1, Math.max(0.3, fx.total));
    marker.position.y = 0.05; marker.visible = false;
    scene.add(marker);
    const hint = document.createElement('div');
    hint.style.cssText = 'position:fixed;left:50%;top:14%;transform:translateX(-50%);z-index:10040;pointer-events:none;background:rgba(20,22,30,.85);color:#fff;padding:10px 16px;border-radius:12px;font:700 16px/1.3 system-ui,sans-serif;text-align:center;box-shadow:0 4px 16px rgba(0,0,0,.4)';
    hint.innerHTML = '🎯 Klik op het doel<br><span style="font-weight:500;font-size:13px;opacity:.8">' + fmtTons(yieldTons) + ' · binnenste ring: alles plat · buitenste ring: schade · slepen = kaart verschuiven · Esc = annuleren</span>';
    document.body.appendChild(hint);
    const style = document.createElement('style');
    style.textContent = `canvas, .city-overlay, .city-overlay * { cursor: ${CROSSHAIR} !important; }`;
    document.head.appendChild(style);
    let down = null;
    const onMove = (e) => {
      const g = groundAt(e.clientX, e.clientY); marker.visible = !!g; if (g) marker.position.set(g.x, 0.05, g.z);
      if (!e.buttons) e.stopPropagation();                        // no hover cards from the app while aiming (dragging still pans)
    };
    const onDown = (e) => { if (e.target === el || el.contains(e.target) || e.target.closest('.city-overlay')) down = [e.clientX, e.clientY]; };
    const isClick = (e) => down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) < 6;
    const onUp = (e) => { if (isClick(e)) { e.stopPropagation(); e.preventDefault(); } };          // the app must not select anything
    const onClick = (e) => {
      if (!isClick(e)) return;
      e.stopPropagation(); e.preventDefault();
      const g = groundAt(e.clientX, e.clientY); down = null;
      if (!g) return;
      target = g; finish(); done();
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); finish(); } };
    const finish = () => {
      window.removeEventListener('pointermove', onMove, true); window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('pointerup', onUp, true); window.removeEventListener('click', onClick, true); window.removeEventListener('keydown', onKey, true);
      marker.removeFromParent(); hint.remove(); style.remove(); picking = null; updateButton();
    };
    window.addEventListener('pointermove', onMove, true); window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointerup', onUp, true); window.addEventListener('click', onClick, true); window.addEventListener('keydown', onKey, true);
    picking = { finish };
  }

  // ---------- go ----------
  // Preparation runs in small slices during the countdown, so the page keeps running smoothly:
  // finding everything that can break, sorting it by distance and cutting it into plates.
  let ready = false, preparing = false, fired = false, onReady = null;
  function* preparation() {
    allocDebris();
    const c = cityShape();
    nuke = { t0: 0, cx: target ? target.x : c.cx, cz: target ? target.z : c.cz, R: c.R, ...effects(yieldTons) };
    const root = new K.Object3D(); root.userData.scNuke = true; root.name = 'sc-nuke'; scene.add(root);
    nukeRoot = root;
    // everything that can break, sorted by distance from ground zero
    const uses = new Map(), list = [];
    scene.traverse((o) => { if (o.geometry) uses.set(o.geometry, (uses.get(o.geometry) || 0) + 1); if (eligible(o) && !prepared.has(o.geometry)) list.push(o); });
    for (const o of list) {
      if (prepared.has(o.geometry)) continue;
      try { prepare(o, uses, false); } catch (e) { prepared.add(o.geometry); console.warn('[nuke] skipped', o.name || o.type, e); }
      yield;
    }
    // buildings as solids: boxes → ruin columns + chunks; their original triangles are swapped at the flash
    try { yield* planSolids(); yield* flagSolidTriangles(); yield; buildSolids(); }
    catch (e) { console.warn('[nuke] solid buildings failed: buildings will only be cut off', e); solid.pieces = []; solid.set = null; solid.mesh = null; for (const j of jobs) j.solid = null; }
    const toBreak = jobs.reduce((x, j) => x + j.breakable, 0);
    debrisChance = Math.min(1 / GRAVEL, (maxDebris * 0.9) / Math.max(1, toBreak * GRAVEL));
    console.info('[nuke] ready · ground zero', nuke.cx.toFixed(1), nuke.cz.toFixed(1), '· city radius', nuke.R.toFixed(1),
      '· meshes', jobs.length, '· other pieces that will break', toBreak,
      '· building boxes', solid.boxes.length, '· chunk size', (solid.size || 0).toFixed(2), '· pieces', solid.pieces.length, '(' + (solid.verts / 3 | 0) + ' triangles)');
    window.scNukeDebug = { nuke, jobs, solid, debrisCount: () => dN };
  }

  function prepareInBackground(done) {
    if (ready) { done(); return; }
    onReady = done;
    if (preparing) return;
    preparing = true;
    const gen = preparation();
    const slice = () => {
      const t = performance.now();
      try {
        while (performance.now() - t < 10) {
          if (gen.next().done) { ready = true; preparing = false; if (onReady) onReady(); return; }
        }
      } catch (e) { console.warn('[nuke] preparation failed', e); ready = true; preparing = false; if (onReady) onReady(); return; }
      setTimeout(slice, 0);
    };
    slice();
  }

  function detonate() {
    if (fired) return;
    fired = true;
    if (bomber && bomber.bomb) bomber.bomb.removeFromParent();   // the bomb is the blast
    nuke.t0 = performance.now();
    scan(false);                                                 // anything the app rebuilt during the countdown
    const root = nukeRoot;
    const lam = (o) => new K.Lambert(o);
    cloudMat = lam({ color: '#ffffff', emissive: '#ff7a2a', emissiveIntensity: 1.4 });
    cloud = new K.Instanced(icosa(), cloudMat, CLOUD_PUFFS);
    cloud.frustumCulled = false; cloud.castShadow = true;
    for (let i = 0; i < CLOUD_PUFFS; i++) cloud.setColorAt(i, new K.Color('#ffffff'));
    fireball = new K.Mesh(icosa(), lam({ color: '#000000', emissive: '#fff1b8', emissiveIntensity: 1.6 }));
    shell = new K.Mesh(dome(), lam({ color: '#ffffff', emissive: '#fff4e0', emissiveIntensity: 0.6, transparent: true, opacity: 0.3, depthWrite: false, side: 2 }));
    shell.position.set(nuke.cx, 0, nuke.cz);
    dust = new K.Mesh(ring(0.82), lam({ color: '#a38f78', transparent: true, opacity: 0.7, depthWrite: false, side: 2 }));
    dust.position.set(nuke.cx, 0.06, nuke.cz);
    disc = new K.Mesh(scorchDisc(), lam({ vertexColors: true }));
    disc.position.set(nuke.cx, 0.003, nuke.cz); disc.receiveShadow = true;
    debris = new K.Instanced(cube(), lam({ color: '#ffffff' }), maxDebris);
    debris.frustumCulled = false; debris.castShadow = true; debris.receiveShadow = true; debris.count = 0;
    debris.setColorAt(0, new K.Color('#ffffff'));
    for (const m of [cloud, fireball, shell, dust, disc, debris]) { m.frustumCulled = false; root.add(m); }
    makeCloud();
    T = tmpM();

    lights = [];
    scene.traverse((o) => { if (o.isLight && !mine(o)) lights.push({ o, i: o.intensity }); });

    flashEl = document.createElement('div');
    flashEl.style.cssText = 'position:fixed;inset:0;background:#fffdf4;pointer-events:none;z-index:10000;opacity:1';
    document.body.appendChild(flashEl);
    try { showSolids(); } catch (e) { console.warn('[nuke] swap to solid buildings failed', e); }
    boom();
    updateButton();
    requestAnimationFrame(loop);
  }

  let last = 0, lastScan = 0;
  function loop(now) {
    requestAnimationFrame(loop);
    const t = elapsed(), dt = Math.min(0.05, last ? (now - last) / 1000 : 0); last = now;
    const f = front(t);
    // every part on its own, so one failing part can't stop the rest
    const safe = (name, fn) => { try { fn(); } catch (e) { if (!loop.warned) loop.warned = {}; if (!loop.warned[name]) { loop.warned[name] = 1; console.warn('[nuke] ' + name, e); } } };
    for (const j of jobs) safe('destroy', () => advance(j, f, true));
    safe('solids', () => advanceSolids(f));
    if (waving(t)) safe('chunks', () => waveOverSolids(f));      // (buildings broken after the blast are left alone)
    safe('debris', () => stepDebris(dt));
    safe('cloud', () => stepCloud(t));
    safe('wave', () => stepWave(t));
    safe('light', () => stepLight(t));
    safe('shake', () => stepShake(t));
    safe('people', () => stepPeople(t, f));
    const maintain = performance.now() - lastScan > 1000;
    safe('cars', () => stepCars(f, maintain, waving(t)));
    if (maintain) { lastScan = performance.now(); safe('rescan', () => scan(true)); }   // the app rebuilt something: break it again
    // the wave has passed: let walk mode rebuild its walls (you can walk through the ruins)
    if (!nuke.settled && t > nuke.wave + 0.5) { nuke.settled = true; safe('notify', () => window.dispatchEvent(new Event('sc:geometry-changed'))); }
  }

  // ---------- B-2 bomber ----------
  let bomber = null;
  function shapeMesh(tris, colorFor) {
    // tris: [[a, b, c], …] with points [x, y, z]; flat shaded, vertex colours
    const P = [], N = [], C = [];
    for (const [a, b, c] of tris) {
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]], l = Math.hypot(...n) || 1;
      const col = new K.Color(colorFor(n[1] / l));
      for (const p of [a, b, c]) { P.push(...p); N.push(n[0] / l, n[1] / l, n[2] / l); C.push(col.r, col.g, col.b); }
    }
    const g = new K.Geometry();
    g.setAttribute('position', new K.Attr(new Float32Array(P), 3));
    g.setAttribute('normal', new K.Attr(new Float32Array(N), 3));
    g.setAttribute('color', new K.Attr(new Float32Array(C), 3));
    const m = new K.Mesh(g, new K.Lambert({ vertexColors: true }));
    m.castShadow = true; m.frustumCulled = false;
    return m;
  }
  // a flying wing: swept leading edge, saw-tooth trailing edge, a low hump in the middle (+z = nose)
  function bomberModel() {
    const s = BOMBER_SPAN / 2.6;
    const half = [[0, 0.55], [1.3, -0.33], [0.92, -0.06], [0.62, -0.33], [0.32, -0.1], [0, -0.38]];
    const ring = [...half, ...half.slice(1, -1).reverse().map(([x, z]) => [-x, z])];            // nose → right tip → tail → left tip
    const thick = (x) => 0.022 * (1 - Math.min(1, Math.abs(x) / 1.3));
    const outer = ring.map(([x, z]) => [x * s, thick(x) * s, z * s]);
    const inner = ring.map(([x, z]) => [x * 0.42 * s, (0.055 + thick(x)) * s, (z * 0.5 + 0.03) * s]);
    const apex = [0, 0.085 * s, 0.1 * s], belly = [0, -0.03 * s, 0.05 * s];
    const tris = [];
    const up = (a, b, c) => { const u = [b[0] - a[0], b[2] - a[2]], v = [c[0] - a[0], c[2] - a[2]]; return u[0] * v[1] - u[1] * v[0] < 0 ? [a, b, c] : [a, c, b]; };   // normal +y
    const dn = (a, b, c) => { const t = up(a, b, c); return [t[0], t[2], t[1]]; };
    for (let i = 0; i < ring.length; i++) {
      const j = (i + 1) % ring.length;
      tris.push(up(outer[i], outer[j], inner[j]), up(outer[i], inner[j], inner[i]), up(inner[i], inner[j], apex));
      tris.push(dn(outer[i], outer[j], belly));
    }
    const plane = shapeMesh(tris, (ny) => (ny > 0 ? '#3d4048' : '#2a2c31'));
    // cockpit windows and engine intakes
    const box = (x, y, z, w, h, d, col) => {
      const c = [[x - w / 2, y, z - d / 2], [x + w / 2, y, z - d / 2], [x + w / 2, y, z + d / 2], [x - w / 2, y, z + d / 2]].map((p) => [p[0] * s, p[1] * s, p[2] * s]);
      const t = c.map((p) => [p[0], p[1] + h * s, p[2]]);
      return shapeMesh([up(t[0], t[1], t[2]), up(t[0], t[2], t[3]), [c[0], c[1], t[1]], [c[0], t[1], t[0]], [c[1], c[2], t[2]], [c[1], t[2], t[1]], [c[2], c[3], t[3]], [c[2], t[3], t[2]], [c[3], c[0], t[0]], [c[3], t[0], t[3]]], () => col);
    };
    for (const x of [-0.05, 0.05]) plane.add(box(x, 0.07, 0.3, 0.06, 0.012, 0.05, '#101216'));
    for (const x of [-0.2, 0.2]) plane.add(box(x, 0.045, 0.12, 0.12, 0.03, 0.14, '#33363d'));
    return plane;
  }
  function bombModel() {
    const tris = [], seg = 8, r = 0.022, len = 0.16, pts = (z, rr) => Array.from({ length: seg }, (_, i) => [Math.cos(i / seg * 6.283) * rr, Math.sin(i / seg * 6.283) * rr, z]);
    const rings = [pts(-len / 2, r * 0.7), pts(-len / 4, r), pts(len / 4, r), pts(len / 2 - 0.01, r * 0.6)], nose = [0, 0, len / 2 + 0.02], tail = [0, 0, -len / 2];
    for (let k = 0; k < rings.length - 1; k++) for (let i = 0; i < seg; i++) { const j = (i + 1) % seg, a = rings[k], b = rings[k + 1]; tris.push([a[i], b[i], b[j]], [a[i], b[j], a[j]]); }
    for (let i = 0; i < seg; i++) { const j = (i + 1) % seg; tris.push([rings[3][i], nose, rings[3][j]], [rings[0][j], tail, rings[0][i]]); }
    for (const [fx, fy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {   // tail fins
      const a = [0, 0, -len / 2], b = [fx * 0.045, fy * 0.045, -len / 2], c = [0, 0, -len / 2 + 0.05];
      tris.push([a, b, c], [a, c, b]);
    }
    return shapeMesh(tris, () => '#5a5f52');
  }
  function startBomber(tDet) {
    if (!BOMBER || COUNTDOWN < BOMB_FALL + 1 || !classes()) return;
    const c = target ? { cx: target.x, cz: target.z } : cityShape(), a = Math.random() * Math.PI * 2, u = [Math.cos(a), Math.sin(a)];
    const H = BOMBER_ALTITUDE, v = BOMBER_SPEED, tRel = tDet - BOMB_FALL * 1000;
    const R = [c.cx - u[0] * v * BOMB_FALL, c.cz - u[1] * v * BOMB_FALL];                       // where it lets go
    const g = 2 * (H - 0.08) / (BOMB_FALL * BOMB_FALL);
    const plane = bomberModel(), bomb = bombModel();
    plane.userData.scNuke = true; bomb.userData.scNuke = true;
    plane.rotation.y = Math.atan2(u[0], u[1]);                                                    // nose (+z) along the course
    plane.visible = false;
    const bs = BOMBER_SPAN / 2.6; bomb.scale.setScalar(bs);
    plane.add(bomb); bomb.position.set(0, -0.02 * bs, 0.05 * bs);                               // in the bomb bay
    scene.add(plane);
    bomber = { plane, bomb, u, R, H, v, g, tRel, tDet, released: false, rumbled: false };
    requestAnimationFrame(stepBomber);
  }
  function stepBomber() {
    const b = bomber; if (!b) return;
    const now = performance.now(), t = (now - b.tRel) / 1000;                                   // seconds since the release
    // the plane: on its straight course, from far out to far beyond
    const along = b.v * t;
    b.plane.position.set(b.R[0] + b.u[0] * along, b.H, b.R[1] + b.u[1] * along);
    b.plane.visible = t > -7 && t < 9;
    if (!b.rumbled && t > -4) { b.rumbled = true; rumble(); }
    if (!b.released && t >= 0) {                                                                // bombs away
      b.released = true;
      b.plane.remove(b.bomb); scene.add(b.bomb);
      whistle();
    }
    if (b.released && b.bomb.parent) {
      const tf = Math.min(t, BOMB_FALL), x = b.R[0] + b.u[0] * b.v * tf, z = b.R[1] + b.u[1] * b.v * tf;
      const y = Math.max(0.06 * BOMBER_SPAN / 2.6, b.H - 0.02 - 0.5 * b.g * tf * tf), vy = -b.g * tf;
      b.bomb.position.set(x, y, z);
      b.bomb.lookAt(x + b.u[0] * b.v, y + vy, z + b.u[1] * b.v);                                // nose along its flight
    }
    if (t > 9 && !b.bomb.parent) { b.plane.removeFromParent(); bomber = null; return; }
    if (t > 9) b.plane.visible = false;
    requestAnimationFrame(stepBomber);
  }
  function stopBomber() { if (!bomber) return; bomber.plane.removeFromParent(); bomber.bomb.removeFromParent(); bomber = null; }
  // the plane's roar passing over, and the whistle of the falling bomb
  function rumble() {
    if (!SOUND) return;
    try {
      audio = audio || new AudioContext();
      const a = audio, t = a.currentTime, len = 8, buf = a.createBuffer(1, Math.floor(a.sampleRate * len), a.sampleRate), ch = buf.getChannelData(0);
      let last = 0; for (let i = 0; i < ch.length; i++) { last = last * 0.97 + (Math.random() * 2 - 1) * 0.03; ch[i] = last * 8; }
      const src = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain();
      f.type = 'lowpass'; f.frequency.setValueAtTime(300, t); f.frequency.linearRampToValueAtTime(900, t + 4); f.frequency.linearRampToValueAtTime(250, t + len);
      g.gain.setValueAtTime(0.001, t); g.gain.exponentialRampToValueAtTime(0.5, t + 4); g.gain.exponentialRampToValueAtTime(0.001, t + len);
      src.buffer = buf; src.connect(f); f.connect(g); g.connect(out(a)); src.start(t);
    } catch {}
  }
  function whistle() {
    if (!SOUND) return;
    try {
      audio = audio || new AudioContext();
      const a = audio, t = a.currentTime, o = a.createOscillator(), g = a.createGain();
      o.type = 'sine'; o.frequency.setValueAtTime(1700, t); o.frequency.exponentialRampToValueAtTime(380, t + BOMB_FALL);
      g.gain.setValueAtTime(0.001, t); g.gain.exponentialRampToValueAtTime(0.12, t + 0.4); g.gain.setValueAtTime(0.12, t + BOMB_FALL - 0.2); g.gain.exponentialRampToValueAtTime(0.001, t + BOMB_FALL);
      o.connect(g); g.connect(out(a)); o.start(t); o.stop(t + BOMB_FALL + 0.05);
    } catch {}
  }

  // ---------- countdown + button ----------
  let counting = null;
  function startCountdown() {
    if (fired) return;
    if (!scene || !classes()) { alert('De 3D-stad is nog niet geladen.'); return; }
    try { audio = audio || new AudioContext(); } catch {}
    if (counting) { clearInterval(counting.timer); countEl.remove(); counting = null; onReady = null; stopBomber(); updateButton(); return; }   // click again: cancel
    prepareInBackground(() => {});                               // start working out the destruction right away
    countEl = document.createElement('div');
    countEl.style.cssText = 'position:fixed;left:50%;top:18%;transform:translateX(-50%);z-index:10001;pointer-events:none;font:800 64px/1 system-ui,sans-serif;color:#ffd23f;text-shadow:0 0 12px #000,0 2px 0 #000;letter-spacing:2px';
    document.body.appendChild(countEl);
    // the countdown follows the clock (not the ticks of a timer, which lag when the page is busy),
    // so the blast comes exactly when the bomber's bomb lands
    const tDet = performance.now() + COUNTDOWN * 1000;
    let shown = -1;
    const go = () => { countEl.remove(); counting = null; detonate(); };
    const tick = () => {
      const n = Math.ceil((tDet - performance.now()) / 1000);
      if (n <= 0) {
        clearInterval(counting.timer);
        if (ready) go();
        else { countEl.textContent = '☢ …'; prepareInBackground(go); }   // still working out the destruction
        return;
      }
      if (n === shown) return;
      shown = n;
      countEl.textContent = '☢ ' + n;
      tone(n <= 3 ? 1320 : 880, 0.18, 0.25);
    };
    counting = { timer: setInterval(tick, 50) };
    try { startBomber(tDet); } catch (e) { console.warn('[nuke] bomber', e); }
    tick();
    updateButton();
  }

  const SVG = 'xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="g-ico" aria-hidden="true"';
  // Lucide "radiation"
  const ICON = `<svg ${SVG}><path d="M12 12h.01"/><path d="M14 15.4641a4 4 0 0 1-4 0L7.52786 19.74597 A 1 1 0 0 0 7.99303 21.16211 10 10 0 0 0 16.00697 21.16211 1 1 0 0 0 16.47214 19.74597z"/><path d="M16 12a4 4 0 0 0-2-3.464l2.472-4.282a1 1 0 0 1 1.46-.305 10 10 0 0 1 4.006 6.94A1 1 0 0 1 21 12z"/><path d="M8 12a4 4 0 0 1 2-3.464L7.528 4.254a1 1 0 0 0-1.46-.305 10 10 0 0 0-4.006 6.94A1 1 0 0 0 3 12z"/></svg>`;
  function updateButton() {
    const b = document.getElementById('sc-nuke'); if (!b) return;
    const label = fired ? 'Herlaad de pagina om de stad te herstellen' : counting ? 'Aftellen stoppen' : 'Nuke (na 10 seconden)';
    b.title = label; b.setAttribute('aria-label', label);
    b.style.opacity = fired ? '0.45' : '';
    b.style.color = counting ? '#e33b3b' : '';
  }
  function ensureButton() {
    if (document.getElementById('sc-nuke')) return;
    const row = document.querySelector('.hz-tr .menu-mini'); if (!row) return;
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'icon-btn small'; b.id = 'sc-nuke';
    b.innerHTML = '<b class="s-bg"></b>' + ICON;
    b.addEventListener('click', (e) => { e.stopPropagation(); if (picking) picking.finish(); else if (counting || fired) startCountdown(); else openPopup(); });   // during the countdown: cancel
    row.appendChild(b);
    updateButton();
  }
  const start = () => { ensureButton(); new MutationObserver(ensureButton).observe(document.body, { childList: true, subtree: true }); };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
