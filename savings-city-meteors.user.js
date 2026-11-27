// ==UserScript==
// @name         Savings City – meteor shower
// @namespace    savings-city-tweaks
// @version      1.0
// @description  A ☄ button: a shower of 10–40 burning meteors falls on the city at one angle. They smash through whatever is in their way, leave craters, and badly damaged buildings collapse. Only in your browser – reload to rebuild.
// @match        https://your-savings-city-host.example/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * Needs savings-city-core (scene, classes, frame loop, smoke, lamps) and savings-city-buildings
 * (solid buildings). Uses residents, walk mode (cars, props, blast event) and cops when they're
 * there.
 *
 * How it works
 * ------------
 * - One shower = METEORS[0]…METEORS[1] meteors. They all come in along the same direction (one
 *   compass bearing and one angle above the horizon per shower), each on its own line, so the trails
 *   are parallel streaks across the sky.
 * - Where they land is planned when the shower starts (plan()):
 *     aimed: a share (AIMED_SHARE) is aimed at the biggest buildings (by volume, picked at random
 *       weighted by volume). Not at their middle: at a random point on the building, somewhere
 *       between 30 % and 90 % of its height, and the line is carried on down to the ground – so the
 *       meteor ploughs into the side or roof of the building and it looks like chance;
 *     random: the rest land anywhere over the city (and a bit around it), never too close to another
 *       landing point. Some of these hit buildings by chance too.
 *   The order is shuffled and the arrivals are spread over SHOWER_TIME seconds with random gaps.
 *   Aimed meteors are on the big side (no tiny pebble for a target).
 *   The buildings each meteor will hit are cut into chunks right away (buildings' prepare(), in its
 *   worker), so the hit is there the moment the meteor arrives.
 * - A meteor: a lumpy glowing rock in a stretched fireball, tumbling, with a trail of fire that
 *   cools into a long grey smoke streak (own instanced pools: the core's smoke stops at 30 m).
 * - In its path: the line is tested against every standing building's boxes each frame. A building
 *   it runs into is destroyed: it collapses, pushed the way the meteor flies, and the meteor loses
 *   energy (PUNCH_KEEP). Big meteors go through one or two buildings; when too little is left, it
 *   explodes there.
 * - On the ground: an explosion (fireball, rock and dirt flying, dust rolling out, a black smoke
 *   column), a crater with a raised rim and the rock still glowing in it, cooling down. Everything
 *   within the blast radius (by size) is hit:
 *     buildings: damage by distance (accumulated over all meteors); a building that reaches SEVERE
 *       collapses (pushed away from the impact), lighter damage blows a crater in the side facing it;
 *     people: blown apart close by, knocked down further out, a band of them catches fire, the rest
 *       run (residents); officers react to the sc:blast event (cops);
 *     cars: close by burnt-out wrecks (occupants dead), further out they catch fire and explode a few
 *       seconds later (walk mode); trees, lamps, benches, fountains knocked over (walk mode, when its
 *       props are known); street lamps go out or fall (core).
 * - Camera shake (the canvas element, so walk mode shakes too), sounds: a roar as each meteor comes
 *   down, a crash when it ploughs through a building, a boom on impact.
 * - The damage bus gets { kind: 'meteor', x, y, z, radius, power, source: 'meteor' } for every
 *   impact (nothing listens to it yet), and window gets sc:blast with source 'meteor'.
 * - Click the button during a shower to stop the meteors that haven't come in yet.
 * Test hooks: window.scMeteors = { start(opts), stop(), meteors, plan, damage }.
 */
(function () {
  'use strict';

  // ---- settings (tiles; 1 tile ≈ 20 m; seconds) ----
  const METEORS = [10, 40];          // how many meteors in one shower (random in this range)
  const AIMED_SHARE = [0.25, 0.4];   // share of them aimed at big buildings
  const BIG_POOL = 3;                // aimed ones pick from the (aimed count × this) biggest buildings
  const ELEVATION = [35, 60];        // the shower's angle above the horizon (degrees)
  const SPEED = 9;                   // tiles per second along the path (≈ 650 km/h; slow enough to see)
  const START_DIST = 34;             // a meteor appears this far up its path
  const SHOWER_TIME = [7, 14];       // the arrivals are spread over this many seconds
  const FIRST_AT = 3;                // the first one lands this many seconds after the click
  const SIZE = [0.045, 0.15];        // radius of the rock (0.15 ≈ 3 m)
  const MIN_GAP = 0.7;               // random landings keep at least this far apart
  const MARGIN = 1.5;                // random landings: the city's box grown by this much
  const BLAST = [0.35, 1.15];        // blast radius for the smallest … biggest meteor
  const PUNCH_KEEP = 0.65;           // energy left after ploughing through a building…
  const MIN_ENERGY = 0.32;           // …and below this it explodes where it is
  const PUNCH_FORCE = 3.5;           // how hard a building it runs into is thrown (tiles/s, top floors)
  const SEVERE = 1;                  // damage at which a building collapses (a direct hit is 1)
  const BLAST_DAMAGE = 1.7;          // damage next to a full-size impact; falls off with distance
  const CRATER_AT = 0.12;            // less damage than this: no crater in the building's side
  const ROCK_GLOW = 18;              // seconds the rock in the crater keeps glowing
  const SHAKE = 14;                  // camera shake per impact (pixels, biggest meteor)
  const CAP_FIRE = 3000, CAP_SMOKE = 2400, CAP_DEBRIS = 900, CAP_CRATERS = 80;
  const GRAVITY = 2.5;               // for flying rocks and dirt (tiles/s², a bit theatrical)
  const GROUND = 0.03;
  const SOUND = true;
  const MAX_ROARS = 6;               // at most this many meteors roar at once
  // -------------------------------------------

  const rnd = (a, b) => a + Math.random() * (b - a);
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const lerp = (a, b, t) => a + (b - a) * t;
  const C = () => window.scCore;
  const B = () => window.scBuildings;
  const out = (ctx) => (C() ? C().out(ctx) : ctx.destination);
  let K = null, scene = null;
  function noSnow(m) { m.defines = { ...(m.defines || {}), SNOW_COVER: '-0.50' }; return m; }

  // ---------- shapes ----------
  // an icosahedron, subdivided `sub` times, as a triangle list; jitter > 0 makes it lumpy (a rock)
  function ico(sub, jitter) {
    const t = (1 + Math.sqrt(5)) / 2;
    let V = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]];
    let F = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
    const norm = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l); };
    V = V.map(norm);
    for (let s = 0; s < sub; s++) {
      const mid = new Map(), F2 = [];
      const m = (a, b) => { const k = a < b ? a + ',' + b : b + ',' + a; if (!mid.has(k)) { V.push(norm([(V[a][0] + V[b][0]) / 2, (V[a][1] + V[b][1]) / 2, (V[a][2] + V[b][2]) / 2])); mid.set(k, V.length - 1); } return mid.get(k); };
      for (const [a, b, c] of F) { const ab = m(a, b), bc = m(b, c), ca = m(c, a); F2.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]); }
      F = F2;
    }
    if (jitter) V = V.map((v) => { const f = 1 + rnd(-jitter, jitter); return v.map((x) => x * f); });
    const P = [];
    for (const f of F) for (const i of f) P.push(...V[i]);
    return P;
  }
  function geometry(P, colors) {
    const g = new K.Geometry();
    g.setAttribute('position', new K.Attr(new Float32Array(P), 3));
    if (colors) g.setAttribute('color', new K.Attr(new Float32Array(colors), 3));
    g.computeVertexNormals();                                        // (a triangle list: flat faces)
    return g;
  }
  // a rock: lumpy, dark, with lighter and rusty patches (vertex colours, per triangle)
  function rockGeometry() {
    const P = ico(1, 0.22), col = [], c = new K.Color();
    const shades = ['#3b322c', '#2c2622', '#4a3d33', '#5a4636', '#352c27'];
    for (let i = 0; i < P.length; i += 9) { c.set(shades[(Math.random() * shades.length) | 0]); for (let k = 0; k < 3; k++) col.push(c.r, c.g, c.b); }
    return geometry(P, col);
  }
  // a crater: a dark bowl (just above the ground, it can't dig a real hole), a raised broken rim, a
  // scorched ring around it fading into the ground; radius 1, rim height 1 (scaled per crater)
  function craterGeometry() {
    const P = [], col = [], c = new K.Color(), seg = 28;
    // rings: [radius, height, colour]
    const rings = [[0, 0, '#141110'], [0.45, 0.02, '#1d1815'], [0.72, 0.35, '#2e2620'], [0.88, 1, '#4b3f35'], [1.05, 0.55, '#5a4c3f'], [1.3, 0.05, '#3a312b'], [1.7, 0, '#4f463e']];
    const jag = Array.from({ length: seg }, () => rnd(0.75, 1.25));
    const pt = (r, a, k) => { const ring = rings[r], h = ring[1] * (r === 3 || r === 4 ? jag[k % seg] : 1); return [Math.cos(a) * ring[0], h, Math.sin(a) * ring[0]]; };
    const colOf = (r) => { c.set(rings[r][2]); return [c.r, c.g, c.b]; };
    for (let r = 0; r < rings.length - 1; r++) for (let k = 0; k < seg; k++) {
      const a0 = (k / seg) * Math.PI * 2, a1 = ((k + 1) / seg) * Math.PI * 2;
      const p00 = pt(r, a0, k), p01 = pt(r, a1, k + 1), p10 = pt(r + 1, a0, k), p11 = pt(r + 1, a1, k + 1);
      const c0 = colOf(r), c1 = colOf(r + 1);
      P.push(...p00, ...p11, ...p10, ...p00, ...p01, ...p11); col.push(...c0, ...c1, ...c1, ...c0, ...c0, ...c1);
    }
    return geometry(P, col);
  }

  // ---------- particle pools (fire, smoke trail, debris): one InstancedMesh each, a ring buffer ----------
  // per particle: position, velocity, age, life, size, grow, gravity, drag, shade, resting
  const PS = 14, X = 0, VX = 3, AGE = 6, LIFE = 7, SZ = 8, GROW = 9, GV = 10, DRAG = 11, SHADE = 12, REST = 13;
  const pools = {};
  function makePool(name, geo, mat, cap) {
    const mesh = new K.Instanced(geo, mat, cap);
    mesh.frustumCulled = false; mesh.name = 'sc-meteor-' + name; mesh.userData.scMeteor = true; mesh.userData.scPuff = true;   // (the nuke skips puffs)
    const w = new K.Color('#ffffff');
    for (let i = 0; i < cap; i++) mesh.setColorAt(i, w);
    mesh.instanceMatrix.array.fill(0); mesh.count = 0;
    scene.add(mesh);
    const R = new Float32Array(cap * 9);
    for (let i = 0; i < cap; i++) randomRotation(R, i * 9);
    return { name, mesh, cap, next: 0, used: 0, hi: 0, d: new Float32Array(cap * PS), R };
  }
  function randomRotation(R, o) {
    let x = Math.random() * 2 - 1, y = Math.random() * 2 - 1, z = Math.random() * 2 - 1, w = Math.random() * 2 - 1;
    const l = Math.hypot(x, y, z, w) || 1; x /= l; y /= l; z /= l; w /= l;
    R[o] = 1 - 2 * (y * y + z * z); R[o + 1] = 2 * (x * y - z * w); R[o + 2] = 2 * (x * z + y * w);
    R[o + 3] = 2 * (x * y + z * w); R[o + 4] = 1 - 2 * (x * x + z * z); R[o + 5] = 2 * (y * z - x * w);
    R[o + 6] = 2 * (x * z - y * w); R[o + 7] = 2 * (y * z + x * w); R[o + 8] = 1 - 2 * (x * x + y * y);
  }
  // o: vx, vy, vz, life, size, grow, g (gravity), drag, shade (0…1), color (debris: '#rrggbb')
  function emit(pool, x, y, z, o) {
    if (!pool) return -1;
    const i = pool.next; pool.next = (i + 1) % pool.cap; pool.used = Math.max(pool.used, i + 1);
    const d = pool.d, b = i * PS;
    d[b] = x; d[b + 1] = y; d[b + 2] = z;
    d[b + VX] = o.vx || 0; d[b + VX + 1] = o.vy || 0; d[b + VX + 2] = o.vz || 0;
    d[b + AGE] = -(o.delay || 0); d[b + LIFE] = o.life || 1; d[b + SZ] = o.size || 0.05; d[b + GROW] = o.grow || 1;
    d[b + GV] = o.g || 0; d[b + DRAG] = o.drag || 0; d[b + SHADE] = o.shade ?? Math.random(); d[b + REST] = 0;
    if (o.color) { tmpColor.set(o.color); pool.mesh.setColorAt(i, tmpColor); pool.mesh.instanceColor.needsUpdate = true; }
    return i;
  }
  let tmpColor = null;
  // fire: white-yellow → orange → red → smoky dark, linear colours (filled in ensure())
  const FIRE_RAMP = [[0, '#fff7d6'], [0.15, '#ffd060'], [0.4, '#ff7a18'], [0.68, '#b4300f'], [1, '#3b302b']];
  let fireRamp = null;
  function rampAt(f, out3) {
    const r = fireRamp; let k = 0;
    while (k < r.length - 2 && f > r[k + 1][0]) k++;
    const t = clamp01((f - r[k][0]) / (r[k + 1][0] - r[k][0]));
    for (let j = 0; j < 3; j++) out3[j] = lerp(r[k][1][j], r[k + 1][1][j], t);
  }
  const rgb = [0, 0, 0];
  function stepPool(pool, dt) {
    const d = pool.d, R = pool.R, m = pool.mesh.instanceMatrix.array, col = pool.mesh.instanceColor.array;
    const kind = pool.name;
    let hi = 0;
    for (let i = 0; i < pool.used; i++) {
      const b = i * PS, e = i * 16;
      let age = d[b + AGE];
      const life = d[b + LIFE];
      if (!(age < life)) { if (m[e + 15] !== 0) m.fill(0, e, e + 16); continue; }
      hi = i + 1;
      age += dt; d[b + AGE] = age;
      if (age < 0) { m.fill(0, e, e + 16); continue; }
      const f = age / life;
      let x = d[b], y = d[b + 1], z = d[b + 2];
      if (!d[b + REST]) {
        const k = 1 / (1 + d[b + DRAG] * dt);
        d[b + VX] *= k; d[b + VX + 2] *= k; d[b + VX + 1] = d[b + VX + 1] * k - d[b + GV] * dt;
        x += d[b + VX] * dt; y += d[b + VX + 1] * dt; z += d[b + VX + 2] * dt;
        const s0 = d[b + SZ];
        if (kind === 'debris' && y < GROUND + s0 * 0.5) {               // lands: bounces a little, then lies
          y = GROUND + s0 * 0.5;
          if (Math.abs(d[b + VX + 1]) < 0.6) { d[b + REST] = 1; }
          else { d[b + VX + 1] = -d[b + VX + 1] * 0.25; d[b + VX] *= 0.45; d[b + VX + 2] *= 0.45; randomRotation(R, i * 9); }
        } else if (kind !== 'debris' && y < GROUND + 0.01) { y = GROUND + 0.01; d[b + VX + 1] = Math.abs(d[b + VX + 1]) * 0.2; }
        d[b] = x; d[b + 1] = y; d[b + 2] = z;
      }
      let s = d[b + SZ];
      if (kind === 'fire') {
        s *= (1 + (d[b + GROW] - 1) * Math.sqrt(f)) * (f > 0.75 ? (1 - f) / 0.25 : 1) * Math.min(1, age / 0.04 + 0.3);
        rampAt(Math.min(1, f * (1.1 - d[b + SHADE] * 0.3)), rgb);
        col[i * 3] = rgb[0]; col[i * 3 + 1] = rgb[1]; col[i * 3 + 2] = rgb[2];
      } else if (kind === 'smoke') {
        s *= (1 + (d[b + GROW] - 1) * (1 - (1 - f) * (1 - f))) * (f > 0.55 ? (1 - f) / 0.45 : 1) * Math.min(1, age / 0.15 + 0.2);
        const g0 = 0.14 + d[b + SHADE] * 0.1, g = lerp(g0, g0 + 0.35, f);   // grey, lighter as it thins out
        col[i * 3] = g; col[i * 3 + 1] = g * 0.97; col[i * 3 + 2] = g * 0.95;
      }
      const r = i * 9;
      m[e] = R[r] * s; m[e + 1] = R[r + 3] * s; m[e + 2] = R[r + 6] * s; m[e + 3] = 0;
      m[e + 4] = R[r + 1] * s; m[e + 5] = R[r + 4] * s; m[e + 6] = R[r + 7] * s; m[e + 7] = 0;
      m[e + 8] = R[r + 2] * s; m[e + 9] = R[r + 5] * s; m[e + 10] = R[r + 8] * s; m[e + 11] = 0;
      m[e + 12] = x; m[e + 13] = y; m[e + 14] = z; m[e + 15] = 1;
    }
    pool.hi = hi;
    pool.mesh.count = hi;
    if (hi) {
      const im = pool.mesh.instanceMatrix, ic = pool.mesh.instanceColor;
      if (im.addUpdateRange) im.addUpdateRange(0, hi * 16); im.needsUpdate = true;
      if (kind !== 'debris') { if (ic.addUpdateRange) ic.addUpdateRange(0, hi * 3); ic.needsUpdate = true; }
    }
  }

  // ---------- set-up ----------
  let ready = false, rockGeos = [], shellGeo = null, shellMats = null, craterMesh = null, craterN = 0;
  function ensure() {
    if (ready) return true;
    const c = C();
    K = c && c.classes && c.classes();
    if (!K || !K.Instanced || !K.Geometry || !K.Attr || !K.Color || !K.Lambert || !K.Basic || !K.Mesh || !K.Object3D || !c.scene) return false;
    scene = c.scene;
    tmpColor = new K.Color();
    fireRamp = FIRE_RAMP.map(([f, hex]) => { const cc = new K.Color(hex); return [f, [cc.r, cc.g, cc.b]]; });
    const blob = geometry(ico(0, 0.12));
    pools.fire = makePool('fire', blob, noSnow(new K.Basic({ color: '#ffffff' })), CAP_FIRE);
    pools.smoke = makePool('smoke', blob, noSnow(new K.Lambert({ color: '#ffffff' })), CAP_SMOKE);
    pools.debris = makePool('debris', geometry(ico(0, 0.3)), noSnow(new K.Lambert({ color: '#ffffff' })), CAP_DEBRIS);
    pools.debris.mesh.castShadow = true; pools.debris.mesh.receiveShadow = true;
    for (let k = 0; k < 5; k++) rockGeos.push(rockGeometry());
    // the fireball around the rock: a sphere moved back so it trails behind (local +z = backwards)
    const sp = ico(1, 0); for (let i = 2; i < sp.length; i += 3) sp[i] += 0.7;
    shellGeo = geometry(sp);
    shellMats = [noSnow(new K.Basic({ color: '#ff9a2e' })), noSnow(new K.Basic({ color: '#fff0b0' }))];
    craterMesh = new K.Instanced(craterGeometry(), noSnow(new K.Lambert({ vertexColors: true })), CAP_CRATERS);
    craterMesh.frustumCulled = false; craterMesh.receiveShadow = true; craterMesh.count = 0; craterMesh.name = 'sc-meteor-craters'; craterMesh.userData.scMeteor = true;
    scene.add(craterMesh);
    c.onFrame(step);
    ready = true;
    return true;
  }

  // ---------- planning a shower ----------
  const volume = (bd) => bd.boxes.reduce((v, b) => v + (b.x1 - b.x0) * (b.y1 - b.y0) * (b.z1 - b.z0), 0);
  function cityBox(all) {
    if (!all.length) return { x0: -6, x1: 6, z0: -6, z1: 6 };
    return { x0: Math.min(...all.map((b) => b.x0)), x1: Math.max(...all.map((b) => b.x1)), z0: Math.min(...all.map((b) => b.z0)), z1: Math.max(...all.map((b) => b.z1)) };
  }
  function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; }
  // the first building box the segment p → p + v·t (t 0…1) enters: { bd, t } or null
  function firstHit(p, v, list, skip) {
    let best = null;
    for (const bd of list) {
      if (skip && skip.has(bd.id)) continue;
      for (const b of bd.boxes) {
        let t0 = 0, t1 = 1, ok = true;
        for (const [o, dv, lo, hi] of [[p.x, v.x, b.x0, b.x1], [p.y, v.y, b.y0, b.y1], [p.z, v.z, b.z0, b.z1]]) {
          if (Math.abs(dv) < 1e-9) { if (o < lo || o > hi) { ok = false; break; } continue; }
          let a = (lo - o) / dv, c = (hi - o) / dv; if (a > c) [a, c] = [c, a];
          t0 = Math.max(t0, a); t1 = Math.min(t1, c); if (t0 > t1) { ok = false; break; }
        }
        if (ok && (!best || t0 < best.t)) best = { bd, t: t0 };
      }
    }
    return best;
  }
  function plan(opts = {}) {
    const all = B() ? B().list() : [];
    const n = opts.count || Math.round(rnd(METEORS[0], METEORS[1] + 0.49));
    // one direction for the whole shower: d points down along the path
    const az = opts.azimuth ?? Math.random() * Math.PI * 2, el = ((opts.elevation ?? rnd(ELEVATION[0], ELEVATION[1])) * Math.PI) / 180;
    const dir = { x: Math.cos(el) * Math.sin(az), y: -Math.sin(el), z: Math.cos(el) * Math.cos(az) };
    // aimed at big buildings: weighted by volume, from the biggest few
    const nAimed = Math.min(all.length, opts.aimed ?? Math.max(1, Math.round(n * rnd(AIMED_SHARE[0], AIMED_SHARE[1]))));
    const big = all.map((bd) => ({ bd, v: volume(bd) })).sort((a, b) => b.v - a.v).slice(0, Math.max(6, nAimed * BIG_POOL));
    const landings = [];
    for (let k = 0; k < nAimed && big.length; k++) {
      let r = Math.random() * big.reduce((s, x) => s + x.v, 0), i = 0;
      while (i < big.length - 1 && (r -= big[i].v) > 0) i++;
      const { bd } = big.splice(i, 1)[0];
      // a point on (in) one of its boxes – the taller ones more likely – then down the line to the ground
      const boxes = bd.boxes.slice().sort((a, b) => b.y1 - a.y1), b = boxes[Math.random() < 0.7 ? 0 : (Math.random() * boxes.length) | 0];
      const px = lerp(b.x0, b.x1, rnd(0.2, 0.8)), pz = lerp(b.z0, b.z1, rnd(0.2, 0.8)), py = lerp(GROUND, b.y1, rnd(0.3, 0.9));
      const t = (py - GROUND) / -dir.y;
      landings.push({ x: px + dir.x * t, z: pz + dir.z * t, aimed: bd.id, size: lerp(SIZE[0], SIZE[1], rnd(0.55, 1)) });
    }
    // the rest: anywhere over the city, spread out
    const box = cityBox(all);
    for (let k = landings.length, tries = 0; k < n && tries < n * 40; tries++) {
      const x = rnd(box.x0 - MARGIN, box.x1 + MARGIN), z = rnd(box.z0 - MARGIN, box.z1 + MARGIN);
      if (tries < n * 30 && landings.some((l) => Math.hypot(l.x - x, l.z - z) < MIN_GAP)) continue;
      landings.push({ x, z, aimed: null, size: lerp(SIZE[0], SIZE[1], Math.pow(Math.random(), 1.6)) });
      k++;
    }
    shuffle(landings);
    // arrival times: random gaps, stretched over the shower's length
    const span = opts.duration ?? rnd(SHOWER_TIME[0], SHOWER_TIME[1]);
    const gaps = landings.map(() => -Math.log(1 - Math.random() * 0.98));
    let acc = 0; const times = gaps.map((g, i) => (i ? (acc += g) : 0));
    const total = acc || 1;
    landings.forEach((l, i) => { l.at = FIRST_AT + (times[i] / total) * span; });
    // what each will run into first, so it can be cut in time
    const expect = [];
    for (const l of landings) {
      const start = { x: l.x - dir.x * START_DIST, y: GROUND - dir.y * START_DIST, z: l.z - dir.z * START_DIST };
      const h = firstHit(start, { x: dir.x * START_DIST, y: dir.y * START_DIST, z: dir.z * START_DIST }, all);
      l.first = h ? h.bd.id : null;
      if (h) expect.push(h.bd);
    }
    return { dir, azimuth: az, elevation: (el * 180) / Math.PI, landings, expect };
  }

  // ---------- the shower ----------
  let shower = null;                    // { t, plan, pending: [landing…], meteors: [meteor…] }
  const flying = [];                    // meteors in the air
  const embers = [];                    // rocks in craters, cooling down
  const damageOf = new Map();           // building id → damage so far
  let listCache = [], listAt = -1;
  function standing(now) {
    if (now - listAt > 300) { listAt = now; listCache = B() ? B().list() : []; }
    return listCache;
  }

  function start(opts = {}) {
    if (!C()) { alert('De meteorenregen heeft het core-script nodig (savings-city-core).'); return null; }
    if (!B()) { alert('De meteorenregen heeft het gebouwen-script nodig (savings-city-buildings).'); return null; }
    if (!ensure()) { alert('De 3D-stad is nog niet geladen.'); return null; }
    const p = plan(opts);
    // cut the buildings that will be hit, the first arrivals first (the worker takes them in order)
    const seen = new Set();
    for (const l of p.landings.slice().sort((a, b) => a.at - b.at)) {
      for (const id of [l.first, l.aimed]) if (id && !seen.has(id)) { seen.add(id); try { B().prepare(id); } catch (e) { /* cut when hit */ } }
    }
    shower = { t: 0, plan: p, pending: p.landings.slice().sort((a, b) => a.at - b.at), count: p.landings.length };
    listAt = -1;
    const res = window.scResidents;
    if (res && res.alarm) setTimeout(() => { const box = cityBox(standing(performance.now())); res.alarm((box.x0 + box.x1) / 2, (box.z0 + box.z1) / 2, 60, 25); }, (FIRST_AT - 1.2) * 1000);
    sound('rumble');
    updateButton();
    return p;
  }
  function stop() { if (shower) shower.pending = []; updateButton(); }

  function launch(l, dir) {
    const size = l.size, root = new K.Object3D();
    const rock = new K.Mesh(rockGeos[(Math.random() * rockGeos.length) | 0], noSnow(new K.Lambert({ vertexColors: true, emissive: '#ff5a10', emissiveIntensity: 0.55 })));
    rock.scale.setScalar(size); rock.castShadow = true;
    const outer = new K.Mesh(shellGeo, shellMats[0]), inner = new K.Mesh(shellGeo, shellMats[1]);
    root.add(rock); root.add(outer); root.add(inner);
    root.traverse((o) => { o.userData.scMeteor = true; o.frustumCulled = false; });
    const m = {
      l, size, energy: size / SIZE[1], dir, root, rock, outer, inner,
      x: l.x - dir.x * START_DIST, y: GROUND - dir.y * START_DIST, z: l.z - dir.z * START_DIST,
      spin: [rnd(-6, 6), rnd(-6, 6), rnd(-6, 6)], hitIds: new Set(), fireAcc: 0, smokeAcc: 0, roar: null, flicker: 0,
    };
    place(m);
    scene.add(root);
    flying.push(m);
    return m;
  }
  function place(m) {
    const s = m.size * Math.sqrt(Math.max(0.3, m.energy / (m.size / SIZE[1])));
    m.root.position.set(m.x, m.y, m.z);
    m.root.lookAt(m.x - m.dir.x, m.y - m.dir.y, m.z - m.dir.z);         // +z points back along the trail
    m.rock.scale.setScalar(s);
    const fl = 1 + Math.sin(m.flicker) * 0.08 + rnd(-0.05, 0.05);
    m.outer.scale.set(s * 1.45 * fl, s * 1.45 * fl, s * 2.6 * fl);
    m.inner.scale.set(s * 1.12, s * 1.12, s * 1.6 * fl);
  }

  function stepMeteor(m, dt, now) {
    const d = m.dir, len = SPEED * dt;
    const p0 = { x: m.x, y: m.y, z: m.z }, v = { x: d.x * len, y: d.y * len, z: d.z * len };
    // into a building on the way?
    let travelled = 1;
    for (let guard = 0; guard < 3; guard++) {
      const h = firstHit(p0, v, standing(now), m.hitIds);
      if (!h || h.t > travelled) break;
      const p = { x: p0.x + v.x * h.t, y: p0.y + v.y * h.t, z: p0.z + v.z * h.t };
      m.hitIds.add(h.bd.id);
      plough(m, h.bd, p);
      if (m.energy < MIN_ENERGY) { m.x = p.x; m.y = p.y; m.z = p.z; explode(m, p, h.bd); return false; }
    }
    // the ground?
    const ny = m.y + v.y;
    if (ny - m.size * 0.4 <= GROUND) {
      const t = clamp01((m.y - m.size * 0.4 - GROUND) / -v.y);
      m.x += v.x * t; m.z += v.z * t; m.y = GROUND + m.size * 0.4;
      explode(m, { x: m.x, y: GROUND, z: m.z }, null);
      return false;
    }
    m.x += v.x; m.y = ny; m.z += v.z;
    m.flicker += dt * 40;
    m.rock.rotation.x += m.spin[0] * dt; m.rock.rotation.y += m.spin[1] * dt; m.rock.rotation.z += m.spin[2] * dt;
    place(m);
    trail(m, len);
    // the roar, the last part of the way down
    const left = (m.y - GROUND) / -d.y / SPEED;
    if (!m.roar && left < 1.8 && roars < MAX_ROARS) m.roar = roar(m, left);
    return true;
  }
  // fire and smoke along the bit of path flown this frame
  function trail(m, len) {
    const d = m.dir, s = m.size * Math.sqrt(Math.max(0.3, m.energy / (m.size / SIZE[1])));
    m.fireAcc += len; m.smokeAcc += len;
    const fireStep = Math.max(0.025, s * 0.35), smokeStep = Math.max(0.05, s * 0.7);
    while (m.fireAcc >= fireStep) {
      m.fireAcc -= fireStep;
      const back = m.fireAcc + s * rnd(0.5, 1.5), j = s * 0.6;
      emit(pools.fire, m.x - d.x * back + rnd(-j, j), m.y - d.y * back + rnd(-j, j), m.z - d.z * back + rnd(-j, j),
        { vx: rnd(-0.2, 0.2), vy: rnd(0, 0.3), vz: rnd(-0.2, 0.2), size: s * rnd(0.7, 1.3), grow: rnd(1.2, 1.8), life: rnd(0.25, 0.6), drag: 2 });
    }
    while (m.smokeAcc >= smokeStep) {
      m.smokeAcc -= smokeStep;
      const back = m.smokeAcc + s * rnd(2, 4), j = s * 0.5;
      emit(pools.smoke, m.x - d.x * back + rnd(-j, j), m.y - d.y * back + rnd(-j, j), m.z - d.z * back + rnd(-j, j),
        { vx: rnd(-0.08, 0.08), vy: rnd(0, 0.1), vz: rnd(-0.08, 0.08), size: s * rnd(0.45, 0.75), grow: rnd(2, 3.2), life: rnd(1.6, 2.6), drag: 1.5 });
    }
  }

  // ---------- breaking things ----------
  // the meteor ploughs into a building: it comes down, thrown the meteor's way
  function plough(m, bd, p) {
    const d = m.dir, hl = Math.hypot(d.x, d.z) || 1, e = m.energy;
    damageOf.set(bd.id, Math.max(SEVERE, damageOf.get(bd.id) || 0));
    try { B().collapse(bd, { at: [p.x, p.y, p.z], push: [d.x / hl, 0, d.z / hl], force: PUNCH_FORCE * (0.6 + e * 0.6), spread: 3.5 }); } catch (err) { console.warn('[meteors] collapse', err); }
    // a splash of fire and concrete dust where it went in
    for (let k = 0; k < 14 + 20 * e; k++) emit(pools.fire, p.x, p.y, p.z, { vx: d.x * rnd(0.5, 2) + rnd(-1, 1), vy: rnd(-0.2, 1.2), vz: d.z * rnd(0.5, 2) + rnd(-1, 1), size: m.size * rnd(0.6, 1.4), grow: 2.2, life: rnd(0.4, 0.9), drag: 2.5 });
    for (let k = 0; k < 6; k++) dust(p.x, p.y, p.z, { vx: rnd(-0.6, 0.6), vy: rnd(0, 0.4), vz: rnd(-0.6, 0.6), size: rnd(0.08, 0.14), grow: 5, life: rnd(3, 5), drag: 1, rise: 0.04 });
    m.energy *= PUNCH_KEEP;
    shake(SHAKE * 0.6 * e, p);
    sound('crash', e, p);
  }
  function dust(x, y, z, o) { const c = C(); if (c && c.smoke) c.smoke('dust', x, y, z, o); }

  // the meteor goes off at p (on the ground, or in a building it couldn't get through)
  function explode(m, p, inBuilding) {
    if (m.roar) { try { m.roar.stop(); } catch {} m.roar = null; }
    const e = Math.max(0.25, m.energy), R = lerp(BLAST[0], BLAST[1], clamp01(e)), onGround = !inBuilding || p.y < 0.15;
    const c = C();
    // fireball
    for (let k = 0; k < 30 + 60 * e; k++) {
      const a = Math.random() * Math.PI * 2, up = Math.random(), sp = rnd(0.5, 2.6) * R;
      emit(pools.fire, p.x, p.y + 0.03, p.z, { vx: Math.cos(a) * sp * (1 - up * 0.6), vy: up * sp * 1.2 + 0.2, vz: Math.sin(a) * sp * (1 - up * 0.6), size: rnd(0.05, 0.12) * (0.6 + e), grow: rnd(2, 3.5), life: rnd(0.5, 1.3), drag: 3, shade: Math.random() });
    }
    // rocks and dirt
    const dirt = ['#3b322c', '#2a2420', '#5a4a3c', '#6b5e50', '#4a4038', '#7a6d5e'];
    for (let k = 0; k < 16 + 40 * e; k++) {
      const a = Math.random() * Math.PI * 2, sp = rnd(0.6, 3.2) * (0.5 + e);
      emit(pools.debris, p.x + rnd(-0.05, 0.05), p.y + 0.05, p.z + rnd(-0.05, 0.05), { vx: Math.cos(a) * sp, vy: rnd(1, 3.5) * (0.6 + e * 0.6), vz: Math.sin(a) * sp, size: rnd(0.012, 0.045) * (0.7 + e * 0.6), life: 1e9, g: GRAVITY, drag: 0.2, color: dirt[(Math.random() * dirt.length) | 0] });
    }
    // dust rolling out over the ground, a column of black smoke
    if (c && c.smoke) {
      for (let k = 0; k < 20 + 24 * e; k++) {
        const a = Math.random() * Math.PI * 2, sp = rnd(0.6, 1.6) * R;
        c.smoke('dust', p.x + Math.cos(a) * 0.05, p.y + 0.05, p.z + Math.sin(a) * 0.05, { vx: Math.cos(a) * sp, vy: rnd(0, 0.15), vz: Math.sin(a) * sp, size: rnd(0.08, 0.16) * (0.6 + e), grow: rnd(4, 7), life: rnd(4, 8), drag: 1.4, flat: 1.6, rise: 0.02, alpha: 0.8 });
      }
      for (let k = 0; k < 10 + 12 * e; k++) c.smoke('blacksmoke', p.x + rnd(-0.1, 0.1) * R, p.y + 0.1, p.z + rnd(-0.1, 0.1) * R, { vy: rnd(0.3, 0.8), rise: rnd(0.25, 0.45), size: rnd(0.06, 0.12) * (0.6 + e), grow: rnd(5, 8), life: rnd(4, 7), delay: k * 0.12, alpha: 0.8 });
    }
    // the crater with the rock in it, glowing and cooling down
    if (onGround) {
      addCrater(p.x, p.z, R * 0.5, R * 0.07);
      m.root.remove(m.outer); m.root.remove(m.inner);
      m.root.position.set(p.x, GROUND + m.size * 0.15, p.z);
      embers.push({ m, t: 0 });
    } else {
      m.root.removeFromParent();
    }
    // what's in reach
    blastBuildings(p, R, e, inBuilding);
    hitPeople(p, R, e);
    hitCars(p, R);
    hitProps(p, R);
    if (c && c.lampsOut) c.lampsOut(p.x, p.z, R * 1.15, { fell: (dd) => dd < R * 0.6 });
    if (c && c.damage) c.damage({ kind: 'meteor', x: p.x, y: p.y, z: p.z, radius: R, power: e, source: 'meteor' });
    shake(SHAKE * (0.5 + e * 0.7), p);
    sound('boom', e, p);
  }
  function addCrater(x, z, r, h) {
    const i = craterN % CAP_CRATERS; craterN++;
    const a = Math.random() * Math.PI * 2, c = Math.cos(a), s = Math.sin(a), m = craterMesh.instanceMatrix.array, o = i * 16;
    m.set([c * r, 0, -s * r, 0, 0, h, 0, 0, s * r, 0, c * r, 0, x, GROUND + 0.012, z, 1], o);
    craterMesh.count = Math.min(CAP_CRATERS, craterN);
    craterMesh.instanceMatrix.needsUpdate = true;
  }
  // nearby buildings: damage by distance; severe → collapse (pushed away), else a crater in the side
  function blastBuildings(p, R, e, direct) {
    const b = B(); if (!b) return;
    for (const bd of b.near(p.x, p.z, R)) {
      if (direct && bd.id === direct.id) continue;
      const qx = Math.max(bd.x0, Math.min(bd.x1, p.x)), qz = Math.max(bd.z0, Math.min(bd.z1, p.z)), dist = Math.hypot(qx - p.x, qz - p.z);
      const hurt = BLAST_DAMAGE * e * Math.pow(clamp01(1 - dist / R), 1.3);
      if (hurt <= 0) continue;
      const total = (damageOf.get(bd.id) || 0) + hurt;
      damageOf.set(bd.id, total);
      let ax = bd.cx - p.x, az = bd.cz - p.z; const al = Math.hypot(ax, az) || 1; ax /= al; az /= al;
      const qy = Math.min(bd.top - 0.04, Math.max(0.06, p.y > 0.15 ? p.y : rnd(0.06, Math.min(0.4, bd.top * 0.5))));
      try {
        if (total >= SEVERE) b.collapse(bd, { at: [qx, qy, qz], push: [ax, 0, az], force: 1.5 + 2.5 * Math.min(1.5, hurt), spread: 3 });
        else if (hurt >= CRATER_AT) b.crater(bd, { x: qx, y: qy, z: qz }, { x: -ax, y: 0, z: -az }, 0.1 + 0.22 * Math.min(1, hurt));
      } catch (err) { console.warn('[meteors] building', err); }
    }
  }
  function hitPeople(p, R, e) {
    const res = window.scResidents, gib = R * 0.4, knock = R * 0.95, panic = R * 3.5;
    if (res) {
      try {
        if (res.gibAround) res.gibAround(p.x, p.z, gib, 1.2 + e);
        if (res.blast) res.blast(p.x, p.z, knock, panic, 12, gib);
        if (res.avoid) res.avoid(p.x, p.z, R * 0.6, 90);
      } catch (err) { console.warn('[meteors] residents', err); }
    }
    window.dispatchEvent(new CustomEvent('sc:blast', { detail: { x: p.x, y: p.y + 0.08, z: p.z, gib, knock, panic, source: 'meteor' } }));
  }
  function hitCars(p, R) {
    const walk = window.scWalk, c = C(), cars = [...((c && c.traffic()) || [])];
    if (walk && walk.parkedCars) try { cars.push(...walk.parkedCars()); } catch {}
    let proxies = null;
    for (const car of cars) {
      if (!car || car.scTaken) continue;
      const d = Math.hypot(car.x - p.x, car.z - p.z);
      if (d > R) continue;
      if (walk && walk.wreck && walk.igniteCar) {
        try { if (d < R * 0.5) walk.wreck(car); else walk.igniteCar(car); if (walk.startEffects) walk.startEffects(); } catch (err) { console.warn('[meteors] car', err); }
        for (let k = 0; k < 6; k++) emit(pools.fire, car.x, 0.08, car.z, { vx: rnd(-0.3, 0.3), vy: rnd(0.3, 0.9), vz: rnd(-0.3, 0.3), size: rnd(0.03, 0.06), grow: 2, life: rnd(0.6, 1.2), drag: 2 });
      } else if (d < R * 0.6 && !car.scMeteor) {
        // without walk mode: the car is stopped and squashed flat
        car.scMeteor = true; car.parked = Infinity; car.speed = 0;
        if (!proxies) { proxies = new Map(); scene.traverse((o) => { const cc = o.userData && o.userData.car; if (cc && typeof cc.index === 'number') proxies.set(cc.index, o); }); }
        const tc = c.traffic(), i = tc ? tc.indexOf(car) : -1, px = proxies.get(i); if (px) px.scale.set(1.1, 0.25, 1.15);
        window.dispatchEvent(new CustomEvent('sc:car-exploded', { detail: { x: car.x, z: car.z, cause: 'meteor' } }));
      }
    }
  }
  function hitProps(p, R) {
    const walk = window.scWalk; if (!walk || !walk.propsNear || !walk.knockProp) return;
    try {
      for (const pr of walk.propsNear(p.x, p.z, R * 0.75)) {
        const dx = pr.x - p.x, dz = pr.z - p.z, l = Math.hypot(dx, dz) || 1;
        walk.knockProp(pr, { x: dx / l, y: 0, z: dz / l });
      }
    } catch (err) { console.warn('[meteors] props', err); }
  }

  // ---------- camera shake (the canvas element: works in walk mode too) ----------
  let shakeAmp = 0;
  function shake(a, p) {
    const walk = window.scWalk;
    if (walk && walk.walking && p) { const pl = walk.player; a *= clamp01(1.4 - Math.hypot(pl.x - p.x, pl.z - p.z) / 8); }
    shakeAmp = Math.max(shakeAmp, a);
  }
  function stepShake(dt) {
    const el = C() && C().renderer && C().renderer.domElement; if (!el) return;
    shakeAmp *= Math.exp(-5 * dt);
    if (shakeAmp < 0.3) { if (el.style.transform && el.dataset.scMeteorShake) { el.style.transform = ''; delete el.dataset.scMeteorShake; } return; }
    el.dataset.scMeteorShake = '1';
    el.style.transform = `translate(${((Math.random() * 2 - 1) * shakeAmp).toFixed(1)}px, ${((Math.random() * 2 - 1) * shakeAmp).toFixed(1)}px)`;
  }

  // ---------- the frame ----------
  function step(dt) {
    if (!ready) return;
    dt = Math.min(dt, 0.05);
    const now = performance.now();
    if (shower) {
      shower.t += dt;
      while (shower.pending.length && shower.pending[0].at - START_DIST / SPEED <= shower.t) launch(shower.pending.shift(), shower.plan.dir);
      if (!shower.pending.length && !flying.length) { shower = null; updateButton(); }
    }
    for (let i = flying.length - 1; i >= 0; i--) {
      let alive = false;
      try { alive = stepMeteor(flying[i], dt, now); } catch (err) { console.warn('[meteors] meteor', err); }
      if (!alive) flying.splice(i, 1);
    }
    for (let i = embers.length - 1; i >= 0; i--) {
      const em = embers[i]; em.t += dt;
      const f = clamp01(em.t / ROCK_GLOW), mat = em.m.rock.material;
      mat.emissiveIntensity = 0.9 * (1 - f) * (1 - f) * (0.85 + 0.15 * Math.sin(em.t * 9));
      if (em.t < ROCK_GLOW * 0.6 && Math.random() < dt * 6) {     // smouldering
        const r = em.m.root.position;
        emit(pools.smoke, r.x + rnd(-0.03, 0.03), r.y + em.m.size * 0.5, r.z + rnd(-0.03, 0.03), { vy: rnd(0.15, 0.3), size: em.m.size * 0.4, grow: 4, life: rnd(2, 3), drag: 0.5, shade: 0.4 });
      }
      if (f >= 1) { mat.emissiveIntensity = 0; embers.splice(i, 1); }
    }
    for (const k in pools) stepPool(pools[k], dt);
    stepShake(dt);
  }

  // ---------- sound ----------
  let audio = null, noiseBuf = null, roars = 0;
  function ctx() {
    audio = audio || new AudioContext();
    if (!noiseBuf) {
      noiseBuf = audio.createBuffer(1, audio.sampleRate * 2, audio.sampleRate);
      const ch = noiseBuf.getChannelData(0); for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;
    }
    return audio;
  }
  // louder close by (walk mode), the same everywhere from above
  function near(p) {
    const walk = window.scWalk;
    if (!p || !walk || !walk.walking) return 1;
    const pl = walk.player; return Math.max(0.12, 1 / (1 + Math.hypot(pl.x - p.x, pl.z - p.z) / 4));
  }
  function noise(a, t, dur) { const s = a.createBufferSource(); s.buffer = noiseBuf; s.loop = true; s.start(t, Math.random()); s.stop(t + dur); return s; }
  // a roar that swells and drops in pitch until the impact (`left` seconds from now)
  function roar(m, left) {
    if (!SOUND) return null;
    try {
      const a = ctx(), t = a.currentTime, f = a.createBiquadFilter(), g = a.createGain(), vol = 0.18 * (0.5 + m.energy) * near(m.l);
      const s = noise(a, t, left + 0.1);
      f.type = 'bandpass'; f.Q.value = 1.4; f.frequency.setValueAtTime(1800, t); f.frequency.exponentialRampToValueAtTime(220, t + left);
      g.gain.setValueAtTime(0.001, t); g.gain.exponentialRampToValueAtTime(vol, t + left * 0.9);
      s.connect(f); f.connect(g); g.connect(out(a));
      roars++; s.onended = () => { roars--; };
      return { stop() { try { g.gain.cancelScheduledValues(a.currentTime); g.gain.setValueAtTime(0.0001, a.currentTime); s.stop(a.currentTime + 0.02); } catch {} } };
    } catch { return null; }
  }
  function sound(kind, e = 1, p) {
    if (!SOUND) return;
    try {
      const a = ctx(), t = a.currentTime, g = a.createGain(), v = near(p);
      g.connect(out(a));
      if (kind === 'boom') {
        const len = 2.5 + e * 2, s = noise(a, t, len), f = a.createBiquadFilter();
        f.type = 'lowpass'; f.frequency.setValueAtTime(1500, t); f.frequency.exponentialRampToValueAtTime(60, t + len);
        g.gain.setValueAtTime(0.9 * (0.4 + e) * v, t); g.gain.exponentialRampToValueAtTime(0.001, t + len);
        s.connect(f); f.connect(g);
        const sub = a.createOscillator(), sg = a.createGain();
        sub.frequency.setValueAtTime(70, t); sub.frequency.exponentialRampToValueAtTime(25, t + 1.5);
        sg.gain.setValueAtTime(0.7 * (0.4 + e) * v, t); sg.gain.exponentialRampToValueAtTime(0.001, t + 1.8);
        sub.connect(sg); sg.connect(out(a)); sub.start(t); sub.stop(t + 1.9);
      } else if (kind === 'crash') {
        const len = 1.6, s = noise(a, t, len), f = a.createBiquadFilter();
        f.type = 'bandpass'; f.Q.value = 0.7; f.frequency.setValueAtTime(900, t); f.frequency.exponentialRampToValueAtTime(150, t + len);
        g.gain.setValueAtTime(0.7 * v, t); g.gain.exponentialRampToValueAtTime(0.001, t + len);
        s.connect(f); f.connect(g);
      } else if (kind === 'rumble') {
        const len = 4, s = noise(a, t, len), f = a.createBiquadFilter();
        f.type = 'lowpass'; f.frequency.value = 120;
        g.gain.setValueAtTime(0.001, t); g.gain.exponentialRampToValueAtTime(0.5, t + 2.5); g.gain.exponentialRampToValueAtTime(0.001, t + len);
        s.connect(f); f.connect(g);
      }
    } catch {}
  }

  // ---------- button ----------
  const SVG = 'xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="g-ico" aria-hidden="true"';
  const ICON = `<svg ${SVG}><circle cx="7" cy="17" r="3.5"/><path d="M9.8 14.2 19 5"/><path d="M8 11.2 13.5 5.7"/><path d="M12.8 16 18.3 10.5"/></svg>`;
  function updateButton() {
    const b = document.getElementById('sc-meteors'); if (!b) return;
    const busy = !!(shower && shower.pending.length);
    const label = busy ? 'Meteorenregen stoppen' : 'Meteorenregen';
    b.title = label; b.setAttribute('aria-label', label);
    b.style.color = shower ? '#e0702a' : '';
  }
  function ensureButton() {
    if (document.getElementById('sc-meteors')) return;
    const row = document.querySelector('.hz-tr .menu-mini'); if (!row) return;
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'icon-btn small'; b.id = 'sc-meteors';
    b.innerHTML = '<b class="s-bg"></b>' + ICON;
    b.addEventListener('click', (e) => { e.stopPropagation(); try { ctx(); } catch {} if (shower && shower.pending.length) stop(); else start(); });
    row.appendChild(b);
    updateButton();
  }
  const begin = () => { ensureButton(); new MutationObserver(ensureButton).observe(document.body, { childList: true, subtree: true }); };
  if (document.body) begin(); else document.addEventListener('DOMContentLoaded', begin);

  window.scMeteors = {
    // start a shower; opts: count, aimed, azimuth (radians), elevation (degrees), duration (s)
    start: (opts) => start(opts || {}),
    stop,
    plan: (opts) => (ensure() ? plan(opts || {}) : null),
    get meteors() { return flying.map((m) => ({ x: m.x, y: m.y, z: m.z, size: m.size, energy: m.energy, aimed: m.l.aimed, hits: [...m.hitIds] })); },
    get shower() { return shower ? { t: shower.t, count: shower.count, pending: shower.pending.length, flying: flying.length, plan: shower.plan } : null; },
    damage: (id) => damageOf.get(id) || 0,
  };
})();
