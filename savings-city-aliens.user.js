// ==UserScript==
// @name         Savings City – alien invasion
// @namespace    savings-city-tweaks
// @version      1.0
// @description  👽 in the disasters menu: retro flying saucers come over the city and attack for 10 seconds. Green laser beams blast holes in the buildings (at most 4 per building), thin red beams vaporize half of the people into rising, shrinking particles in their own colours. Then the saucers fly off. Only in your browser – reload to rebuild.
// @match        https://your-savings-city-host.example/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * Needs savings-city-core (scene, classes, frame loop, sound, dust) and savings-city-buildings (solid
 * buildings, craters). Uses residents (skin(p, 'ufo'): the people it vaporizes, with their colours)
 * and cops (skin(i, 'ufo'): officers) when they're there.
 *
 * How it works
 * ------------
 * - One invasion: ARRIVE s flying in, ATTACK s shooting, LEAVE s flying off (10 + 10 + 5).
 * - Panic: from PANIC_AT s after the start (the saucers are in sight) until they're gone, every
 *   PANIC_EVERY s everyone outside is alarmed again (residents' alarm() from below each saucer), so
 *   people run screaming the whole time – also the ones who calmed down or just came out.
 * - The saucers (UFOS: more for a bigger city) each get a station over the city, spread out, at
 *   ALTITUDE above the tallest building. They come in from far outside the city (from every side),
 *   slow down onto their station, hover there (drifting in small circles, bobbing, the hull turning,
 *   the rim lights chasing), and at the end climb away outward, faster and faster.
 * - A saucer: a retro flying saucer – a flat silver disc with a ridge, a glass dome with a glow, a
 *   ring of blinking lights on the rim and a green glowing emitter underneath. One group of meshes
 *   per saucer (lathed geometry made here, flat faces).
 * - Buildings: when the invasion starts every standing building (at most MAX_TARGETS) gets SHOTS
 *   shots (random, at most 4), spread over the attack; the buildings are cut into chunks right away
 *   (buildings' prepare(), in its worker), so they're ready by the time the shooting starts. A shot:
 *   the saucer nearest to the building aims at a random point in one of its boxes, the line is cast
 *   against the chunks (buildings' ray(), so it goes through earlier holes) or the box, and a thick
 *   green beam flashes from the emitter to that point; there it blasts a crater (buildings'
 *   crater(): no collapse – the building keeps standing, full of holes), with green sparks and dust.
 * - People: when the invasion starts, half of everyone outside (residents and officers) is counted;
 *   that many shots are spread over the attack. Each picks someone at random who's still standing
 *   outside, the nearest saucer fires a thin red beam at them, and they're vaporized: taken out of
 *   the city (skin(…, 'ufo'), so they count in the bodycount) and turned into a cloud of small
 *   particles in their own colours (trousers low, shirt in the middle, skin and hair on top) that
 *   swirl up, getting smaller, into nothing.
 * - Beams and particles are instanced (one InstancedMesh each for the beams' cores and glows, one
 *   for the particles).
 * - Sound: a warbling hum while the saucers are there, a "pew" for every shot (green lower, red
 *   higher; at most a few red ones per second).
 * Test hooks: window.scAliens = { start(opts), state, ufos }.
 */
(function () {
  'use strict';

  // ---- settings (tiles; 1 tile ≈ 20 m; a person is 0.135 tall; seconds) ----
  const ARRIVE = 10;                 // seconds for the saucers to fly in…
  const ATTACK = 10;                 // …seconds they shoot…
  const LEAVE = 5;                   // …and seconds to fly off
  const PANIC_AT = 2.5;              // people start to panic this many seconds after the start…
  const PANIC_EVERY = 2.5;           // …and are alarmed again this often until the saucers have left
  const UFOS = [4, 12];              // how many saucers (more for more buildings: one per BUILDINGS_PER_UFO, plus 3)
  const BUILDINGS_PER_UFO = 6;
  const UFO_SIZE = 1.8;              // × the saucer's size (1: radius 0.32 tiles ≈ 6.5 m)
  const ALTITUDE = [1.0, 1.8];       // hover this high above the tallest building…
  const MIN_ALTITUDE = 2.2;          // …but at least this high
  const COME_FROM = 28;              // they come in from (and leave to) this far out
  const MIN_GAP = 1.1;               // stations keep at least this far apart
  const SHOTS = [2, 4];              // shots per building (random in this range; at most 4)
  const MAX_TARGETS = 60;            // at most this many buildings are shot at
  const HOLE = [0.13, 0.2];          // crater radius per shot
  const PEOPLE_SHARE = 0.5;          // share of the people outside that is vaporized
  const PARTICLES = 46;              // particles per vaporized person
  const VAPOR_LIFE = [1.1, 2.3];     // seconds a particle floats up before it's gone
  const MAX_ZAPS = 8;                // at most this many red "pew" sounds per second
  const SOUND = true;
  const CAP_GREEN = 96, CAP_RED = 600, CAP_PARTS = 16000;
  // -------------------------------------------

  const rnd = (a, b) => a + Math.random() * (b - a);
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const lerp = (a, b, t) => a + (b - a) * t;
  const C = () => window.scCore;
  const B = () => window.scBuildings;
  const RES = () => window.scResidents;
  const COPS = () => window.scCops;
  const out = (ctx) => (C() ? C().out(ctx) : ctx.destination);
  let K = null, scene = null;
  function noSnow(m) { m.defines = { ...(m.defines || {}), SNOW_COVER: '-0.50' }; return m; }
  // an unlit colour: MeshBasicMaterial when the scene has one to borrow from, else black Lambert glowing in that colour
  const unlit = (hex, o = {}) => noSnow(K.Basic ? new K.Basic({ color: hex, ...o }) : new K.Lambert({ color: '#000000', emissive: hex, ...o }));

  const COP_COLORS = { trousers: '#1f2a4a', shirt: '#3b5a9a', skin: '#e0b48f', hair: '#1f2a4a', bald: false };
  const ANY = { shirt: '#4f8fd8', trousers: '#2f4a7a', skin: '#eec4a2', hair: '#3d2a1c', bald: false };

  // ---------- shapes ----------
  function geometry(P, colors) {
    const g = new K.Geometry();
    g.setAttribute('position', new K.Attr(new Float32Array(P), 3));
    if (colors) g.setAttribute('color', new K.Attr(new Float32Array(colors), 3));
    g.computeVertexNormals();                                        // (a triangle list: flat faces)
    return g;
  }
  // a shape turned around the y axis: profile [[radius, y, '#colour'], …] from the bottom up
  function lathe(profile, seg) {
    const P = [], col = [], c = new K.Color();
    for (let i = 0; i < profile.length - 1; i++) {
      const [r0, y0] = profile[i], [r1, y1, hex] = profile[i + 1];
      c.set(hex || profile[i][2] || '#ffffff');
      for (let k = 0; k < seg; k++) {
        const a0 = (k / seg) * Math.PI * 2, a1 = ((k + 1) / seg) * Math.PI * 2;
        const p00 = [Math.cos(a0) * r0, y0, Math.sin(a0) * r0], p01 = [Math.cos(a1) * r0, y0, Math.sin(a1) * r0];
        const p10 = [Math.cos(a0) * r1, y1, Math.sin(a0) * r1], p11 = [Math.cos(a1) * r1, y1, Math.sin(a1) * r1];
        if (r0 > 1e-6) { P.push(...p00, ...p10, ...p01); col.push(c.r, c.g, c.b, c.r, c.g, c.b, c.r, c.g, c.b); }
        if (r1 > 1e-6) { P.push(...p01, ...p10, ...p11); col.push(c.r, c.g, c.b, c.r, c.g, c.b, c.r, c.g, c.b); }
      }
    }
    return geometry(P, col);
  }
  // a box from (−½, −½, 0) to (½, ½, 1): a beam along +z
  function beamGeometry() {
    const v = [[-0.5, -0.5, 0], [0.5, -0.5, 0], [0.5, 0.5, 0], [-0.5, 0.5, 0], [-0.5, -0.5, 1], [0.5, -0.5, 1], [0.5, 0.5, 1], [-0.5, 0.5, 1]];
    const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
    const P = []; for (const t of f) for (const i of t) P.push(...v[i]);
    return geometry(P);
  }
  function cubeGeometry() {
    const v = [[-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5], [-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5]];
    const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
    const P = []; for (const t of f) for (const i of t) P.push(...v[i]);
    return geometry(P);
  }

  // ---------- set-up ----------
  let ready = false, hullGeo = null, domeGeo = null, emitGeo = null, lightGeo = null;
  let hullMat = null, domeMat = null, emitMat = null;
  const LIGHT_COLORS = ['#ff3b3b', '#ffd23b', '#3bff6a', '#3bd0ff'];
  let lightMats = null, lightOff = null;
  const beams = { green: null, red: null };
  let parts = null, tmpColor = null;
  function ensure() {
    if (ready) return true;
    const c = C();
    K = c && c.classes && c.classes();
    if (!K || !K.Instanced || !K.Geometry || !K.Attr || !K.Color || !K.Lambert || !K.Mesh || !K.Object3D || !c.scene) return false;
    scene = c.scene;
    tmpColor = new K.Color();
    // the saucer: bottom → rim → ridge → top plate (radius 1 = UFO radius)
    hullGeo = lathe([
      [0.0, -0.17, '#8a9099'], [0.28, -0.17], [0.5, -0.13, '#9aa1ab'], [0.8, -0.06, '#b8bfc9'], [1.0, 0, '#d9dee6'],
      [0.97, 0.035, '#7d848e'], [0.8, 0.07, '#e8ecf2'], [0.55, 0.12, '#cfd5de'], [0.36, 0.14, '#b0b7c1'], [0.0, 0.14, '#b0b7c1'],
    ], 28);
    domeGeo = lathe(Array.from({ length: 7 }, (_, i) => { const a = (i / 6) * Math.PI / 2; return [Math.cos(a) * 0.36, 0.14 + Math.sin(a) * 0.3, '#ffffff']; }), 20);
    emitGeo = lathe([[0, -0.2, '#ffffff'], [0.2, -0.17], [0.28, -0.17]], 20);
    lightGeo = cubeGeometry();
    hullMat = noSnow(new K.Lambert({ vertexColors: true, emissive: '#1a1d22', side: 2 }));
    domeMat = noSnow(new K.Lambert({ color: '#8fe8ff', emissive: '#2aa7c8', emissiveIntensity: 0.6, transparent: true, opacity: 0.82, side: 2 }));
    emitMat = unlit('#7dff5a', { side: 2 });
    lightMats = LIGHT_COLORS.map((h) => unlit(h));
    lightOff = unlit('#3a3f48');
    // beams: a bright core and a see-through glow around it
    const bg = beamGeometry();
    beams.green = beamPool('green', bg, '#e6ffd8', '#2cff2c', CAP_GREEN);
    beams.red = beamPool('red', bg, '#ffb0a8', '#ff1a1a', CAP_RED);
    // particles (vapor, sparks)
    const pm = new K.Instanced(cubeGeometry(), noSnow(K.Basic ? new K.Basic({ color: '#ffffff' }) : new K.Lambert({ color: '#ffffff', emissive: '#555555' })), CAP_PARTS);
    pm.frustumCulled = false; pm.name = 'sc-ufo-parts'; pm.userData.scUfo = true; pm.userData.scPuff = true;
    const w = new K.Color('#ffffff'); for (let i = 0; i < CAP_PARTS; i++) pm.setColorAt(i, w);
    pm.instanceMatrix.array.fill(0); pm.count = 0;
    scene.add(pm);
    parts = { mesh: pm, next: 0, used: 0, d: new Float32Array(CAP_PARTS * PS) };
    c.onFrame(step);
    ready = true;
    return true;
  }
  function beamPool(name, geo, core, glow, cap) {
    const mk = (hex, opacity) => {
      const m = new K.Instanced(geo, unlit(hex, { transparent: opacity < 1, opacity, depthWrite: opacity >= 1, blending: opacity < 1 ? 2 : 1 }), cap);
      m.frustumCulled = false; m.name = 'sc-ufo-beam-' + name; m.userData.scUfo = true; m.userData.scPuff = true;
      m.instanceMatrix.array.fill(0); m.count = cap; m.renderOrder = 5;
      scene.add(m);
      return m;
    };
    return { core: mk(core, 1), glow: mk(glow, 0.38), cap, free: Array.from({ length: cap }, (_, i) => cap - 1 - i), live: [] };
  }

  // ---------- a saucer ----------
  function makeUfo(station, from) {
    const root = new K.Object3D(), body = new K.Object3D();
    const hull = new K.Mesh(hullGeo, hullMat), dome = new K.Mesh(domeGeo, domeMat), emit = new K.Mesh(emitGeo, emitMat);
    hull.castShadow = true;
    body.add(hull); body.add(dome); body.add(emit);
    const lights = [];
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2, l = new K.Mesh(lightGeo, lightOff);
      l.position.set(Math.cos(a) * 0.985, 0.018, Math.sin(a) * 0.985); l.scale.setScalar(0.06);
      body.add(l); lights.push(l);
    }
    root.add(body);
    root.scale.setScalar(0.32 * UFO_SIZE);
    root.traverse((o) => { o.userData.scUfo = true; o.frustumCulled = false; });
    const u = { root, body, lights, station, from, x: from.x, y: from.y, z: from.z, px: from.x, pz: from.z,
      ph: Math.random() * Math.PI * 2, spin: rnd(1.2, 2.2) * (Math.random() < 0.5 ? -1 : 1), drift: rnd(0.25, 0.55), out: null, leaveFrom: null };
    root.position.set(u.x, u.y, u.z);
    scene.add(root);
    return u;
  }
  // where it hovers at time t (seconds of the invasion): its station, circling and bobbing a little
  function hover(u, t) {
    const w = 0.5 + u.drift * 0.4;
    return { x: u.station.x + Math.cos(t * w + u.ph) * u.drift, y: u.station.y + Math.sin(t * 1.7 + u.ph) * 0.06, z: u.station.z + Math.sin(t * w + u.ph) * u.drift };
  }
  const easeOut = (s) => 1 - Math.pow(1 - clamp01(s), 3);
  function moveUfo(u, t, dt) {
    let p;
    if (t < ARRIVE) {
      const h = hover(u, t), s = easeOut(t / ARRIVE);
      p = { x: lerp(u.from.x, h.x, s), y: lerp(u.from.y, h.y, s), z: lerp(u.from.z, h.z, s) };
    } else if (t < ARRIVE + ATTACK) {
      p = hover(u, t);
    } else {
      if (!u.leaveFrom) u.leaveFrom = hover(u, t);
      const s = clamp01((t - ARRIVE - ATTACK) / LEAVE), k = s * s;
      p = { x: u.leaveFrom.x + u.out.x * COME_FROM * 1.2 * k, y: u.leaveFrom.y + 9 * k, z: u.leaveFrom.z + u.out.z * COME_FROM * 1.2 * k };
    }
    const vx = (p.x - u.x) / Math.max(dt, 1e-3), vz = (p.z - u.z) / Math.max(dt, 1e-3);
    u.x = p.x; u.y = p.y; u.z = p.z;
    u.root.position.set(p.x, p.y, p.z);
    // lean into the way it flies
    const tx = Math.max(-0.35, Math.min(0.35, vz * 0.05)), tz = Math.max(-0.35, Math.min(0.35, -vx * 0.05));
    u.root.rotation.x = lerp(u.root.rotation.x, tx, Math.min(1, dt * 4));
    u.root.rotation.z = lerp(u.root.rotation.z, tz, Math.min(1, dt * 4));
    u.body.rotation.y += u.spin * dt;
    // chasing rim lights
    const on = Math.floor(t * 10 + u.ph * 3);
    u.lights.forEach((l, k) => { l.material = (k + on) % 3 === 0 ? lightMats[(k + Math.floor(t * 2)) % lightMats.length] : lightOff; });
  }
  const emitterOf = (u) => ({ x: u.x, y: u.y - 0.19 * 0.32 * UFO_SIZE, z: u.z });
  function nearestUfo(x, z) {
    let best = null, bd = Infinity;
    for (const u of ufos) { const d = Math.hypot(u.x - x, u.z - z); if (d < bd) { bd = d; best = u; } }
    return best;
  }

  // ---------- beams ----------
  const REACH = 0.05;                 // seconds the beam takes to reach its target
  function fireBeam(kind, u, target, opts) {
    const pool = beams[kind]; if (!pool || !pool.free.length) { if (opts.onHit) opts.onHit(); return; }
    pool.live.push({ slot: pool.free.pop(), u, target, t: 0, life: opts.life, width: opts.width, glow: opts.glow, onHit: opts.onHit, hit: false });
  }
  function writeBeam(arr, o, a, b, w, len) {
    let zx = b.x - a.x, zy = b.y - a.y, zz = b.z - a.z;
    const L = Math.hypot(zx, zy, zz) || 1e-6; zx /= L; zy /= L; zz /= L;
    const up = Math.abs(zy) > 0.95 ? [1, 0, 0] : [0, 1, 0];
    let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
    const xl = Math.hypot(xx, xy, xz) || 1; xx /= xl; xy /= xl; xz /= xl;
    const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    const l = L * len;
    arr[o] = xx * w; arr[o + 1] = xy * w; arr[o + 2] = xz * w; arr[o + 3] = 0;
    arr[o + 4] = yx * w; arr[o + 5] = yy * w; arr[o + 6] = yz * w; arr[o + 7] = 0;
    arr[o + 8] = zx * l; arr[o + 9] = zy * l; arr[o + 10] = zz * l; arr[o + 11] = 0;
    arr[o + 12] = a.x; arr[o + 13] = a.y; arr[o + 14] = a.z; arr[o + 15] = 1;
  }
  function stepBeams(pool, dt) {
    const core = pool.core.instanceMatrix.array, glow = pool.glow.instanceMatrix.array;
    let changed = false;
    for (let i = pool.live.length - 1; i >= 0; i--) {
      const bm = pool.live[i]; bm.t += dt; changed = true;
      const o = bm.slot * 16;
      if (bm.t >= bm.life) { core.fill(0, o, o + 16); glow.fill(0, o, o + 16); pool.free.push(bm.slot); pool.live.splice(i, 1); continue; }
      if (!bm.hit && bm.t >= REACH) { bm.hit = true; try { if (bm.onHit) bm.onHit(); } catch (e) { console.warn('[aliens] hit', e); } }
      const len = clamp01(bm.t / REACH), f = bm.t / bm.life;
      const w = (f < 0.6 ? 1 : 1 - (f - 0.6) / 0.4) * (0.85 + 0.15 * Math.sin(bm.t * 90));
      const a = emitterOf(bm.u);
      writeBeam(core, o, a, bm.target, bm.width * w, len);
      writeBeam(glow, o, a, bm.target, bm.glow * (0.7 + 0.3 * w), len);
    }
    if (changed) { pool.core.instanceMatrix.needsUpdate = true; pool.glow.instanceMatrix.needsUpdate = true; }
  }

  // ---------- particles ----------
  // per particle: x y z, vx vy vz, age, life, size, g (gravity; < 0 rises), swirl (rad/s around cx, cz), cx, cz, ground
  const PS = 14, AGE = 6, LIFE = 7, SZ = 8, GV = 9, SW = 10, CX = 11, CZ = 12, GR = 13;
  function emit(x, y, z, o) {
    const i = parts.next; parts.next = (i + 1) % CAP_PARTS; parts.used = Math.max(parts.used, i + 1);
    const d = parts.d, b = i * PS;
    d[b] = x; d[b + 1] = y; d[b + 2] = z;
    d[b + 3] = o.vx || 0; d[b + 4] = o.vy || 0; d[b + 5] = o.vz || 0;
    d[b + AGE] = -(o.delay || 0); d[b + LIFE] = o.life || 1; d[b + SZ] = o.size || 0.01; d[b + GV] = o.g || 0;
    d[b + SW] = o.swirl || 0; d[b + CX] = o.cx ?? x; d[b + CZ] = o.cz ?? z; d[b + GR] = o.ground ?? -1;
    tmpColor.set(o.color || '#ffffff'); parts.mesh.setColorAt(i, tmpColor);
    parts.colorDirty = true;
  }
  function stepParts(dt) {
    const d = parts.d, m = parts.mesh.instanceMatrix.array;
    let hi = 0;
    for (let i = 0; i < parts.used; i++) {
      const b = i * PS, e = i * 16;
      let age = d[b + AGE];
      const life = d[b + LIFE];
      if (!(age < life)) { if (m[e + 15] !== 0) m.fill(0, e, e + 16); continue; }
      hi = i + 1;
      age += dt; d[b + AGE] = age;
      if (age < 0) { m.fill(0, e, e + 16); continue; }
      const f = age / life;
      d[b + 4] -= d[b + GV] * dt;
      let x = d[b] + d[b + 3] * dt, y = d[b + 1] + d[b + 4] * dt, z = d[b + 2] + d[b + 5] * dt;
      const sw = d[b + SW];
      if (sw) {                                                     // swirl around the column it rises from
        const cx = d[b + CX], cz = d[b + CZ], a = sw * dt, c = Math.cos(a), s = Math.sin(a), rx = x - cx, rz = z - cz;
        x = cx + rx * c - rz * s; z = cz + rx * s + rz * c;
        d[b + 3] *= 0.98; d[b + 5] *= 0.98;
      }
      if (d[b + GR] >= 0 && y < d[b + GR]) { y = d[b + GR]; d[b + 4] = 0; d[b + 3] *= 0.5; d[b + 5] *= 0.5; }
      d[b] = x; d[b + 1] = y; d[b + 2] = z;
      const s = d[b + SZ] * (1 - f) * Math.min(1, age / 0.05 + 0.4);
      m[e] = s; m[e + 1] = 0; m[e + 2] = 0; m[e + 3] = 0;
      m[e + 4] = 0; m[e + 5] = s; m[e + 6] = 0; m[e + 7] = 0;
      m[e + 8] = 0; m[e + 9] = 0; m[e + 10] = s; m[e + 11] = 0;
      m[e + 12] = x; m[e + 13] = y; m[e + 14] = z; m[e + 15] = 1;
    }
    parts.mesh.count = hi;
    if (hi) parts.mesh.instanceMatrix.needsUpdate = true;
    if (parts.colorDirty && parts.mesh.instanceColor) { parts.mesh.instanceColor.needsUpdate = true; parts.colorDirty = false; }
  }

  // ---------- vaporizing someone ----------
  function vaporize(info) {
    const col = info.colors || (info.cop ? COP_COLORS : ANY);
    const k = info.k || 1, h = info.h || 0.135, y0 = info.y ?? 0.04;
    const swirl = rnd(1.5, 3) * (Math.random() < 0.5 ? -1 : 1);
    for (let n = 0; n < PARTICLES; n++) {
      const u = Math.random();
      let hex, r;
      if (u < 0.42) { hex = col.trousers; r = 0.012; }
      else if (u < 0.78) { hex = col.shirt; r = 0.019; }
      else if (u > 0.92 && !col.bald) { hex = col.hair; r = 0.011; }
      else { hex = col.skin; r = 0.011; }
      const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * r * k;
      emit(info.x + Math.cos(a) * d, y0 + u * h, info.z + Math.sin(a) * d, {
        vx: Math.cos(a) * rnd(0.01, 0.04), vy: rnd(0.03, 0.1), vz: Math.sin(a) * rnd(0.01, 0.04),
        g: -rnd(0.08, 0.2), swirl, cx: info.x, cz: info.z,
        size: rnd(0.008, 0.014), life: rnd(VAPOR_LIFE[0], VAPOR_LIFE[1]), delay: (1 - u) * 0.12 * Math.random(), color: hex,
      });
    }
    // a red flicker where they stood
    for (let n = 0; n < 6; n++) emit(info.x + rnd(-0.01, 0.01), y0 + rnd(0, h), info.z + rnd(-0.01, 0.01), { vy: rnd(0.05, 0.15), size: rnd(0.006, 0.01), life: rnd(0.2, 0.45), color: '#ff5040' });
  }
  function shootPerson() {
    const res = RES(), list = [];
    if (res && res.people) for (const q of res.people) if (q && q.state !== 'inside' && q.state !== 'down' && q.state !== 'gone') list.push({ who: 'res', q, x: q.x, z: q.z });
    const cops = (COPS() && typeof COPS().officers === 'function' && COPS().officers()) || [];
    cops.forEach((c, i) => { if (c.state === 'exit' || c.state === 'fight') list.push({ who: 'cop', i, x: c.x, z: c.z }); });
    if (!list.length) return false;
    const f = list[(Math.random() * list.length) | 0];
    const u = nearestUfo(f.x, f.z); if (!u) return false;
    let info = null;
    try { info = f.who === 'res' ? res.skin(f.q, 'ufo') : COPS().skin(f.i, 'ufo'); } catch (e) { console.warn('[aliens] take', e); }
    if (!info) return false;
    const target = { x: info.x, y: (info.y ?? 0.04) + (info.h || 0.135) * 0.6, z: info.z };
    fireBeam('red', u, target, { life: 0.28, width: 0.006, glow: 0.02, onHit: () => vaporize(info) });
    zap('red');
    killed++;
    return true;
  }

  // ---------- shooting a building ----------
  // where the line from o towards p enters box b: { t, n } (t along the unit direction d) or null
  function boxEntry(o, d, b) {
    let t0 = 0, t1 = Infinity, n = null;
    for (const [oo, dd, lo, hi, ax] of [[o.x, d.x, b.x0, b.x1, 'x'], [o.y, d.y, b.y0, b.y1, 'y'], [o.z, d.z, b.z0, b.z1, 'z']]) {
      if (Math.abs(dd) < 1e-9) { if (oo < lo || oo > hi) return null; continue; }
      let a = (lo - oo) / dd, c = (hi - oo) / dd, sgn = -1;
      if (a > c) { [a, c] = [c, a]; sgn = 1; }
      if (a > t0) { t0 = a; n = { x: 0, y: 0, z: 0 }; n[ax] = sgn; }
      t1 = Math.min(t1, c); if (t0 > t1) return null;
    }
    return n ? { t: t0, n } : null;
  }
  function shootBuilding(id) {
    const b = B(); if (!b || !b.alive(id)) return false;
    const bd = b.list().find((x) => x.id === id); if (!bd || !bd.boxes || !bd.boxes.length) return false;
    const u = nearestUfo(bd.cx ?? (bd.x0 + bd.x1) / 2, bd.cz ?? (bd.z0 + bd.z1) / 2); if (!u) return false;
    const boxes = bd.boxes.slice().sort((p, q) => q.y1 - p.y1), bx = boxes[Math.random() < 0.6 ? 0 : (Math.random() * boxes.length) | 0];
    const aim = { x: lerp(bx.x0, bx.x1, rnd(0.2, 0.8)), y: lerp(Math.max(0.03, bx.y0), bx.y1, rnd(0.25, 0.95)), z: lerp(bx.z0, bx.z1, rnd(0.2, 0.8)) };
    const o = emitterOf(u);
    let d = { x: aim.x - o.x, y: aim.y - o.y, z: aim.z - o.z };
    const L = Math.hypot(d.x, d.y, d.z) || 1; d = { x: d.x / L, y: d.y / L, z: d.z / L };
    let p = null, n = null;
    try {
      if (b.covers && b.covers(id) && b.ray) { const h = b.ray(o, d, L + 0.5); if (h && h.id === id) { p = { x: o.x + d.x * h.t, y: o.y + d.y * h.t, z: o.z + d.z * h.t }; n = h.n; } }
    } catch (e) { /* the box then */ }
    if (!p) {
      let best = null;
      for (const q of bd.boxes) { const h = boxEntry(o, d, q); if (h && (!best || h.t < best.t)) best = h; }
      if (best) { p = { x: o.x + d.x * best.t, y: o.y + d.y * best.t, z: o.z + d.z * best.t }; n = best.n; }
      else { p = aim; n = { x: -d.x, y: -d.y, z: -d.z }; }
    }
    const hitP = p, hitN = n;
    fireBeam('green', u, hitP, { life: 0.5, width: 0.022, glow: 0.075, onHit: () => blast(bd, hitP, hitN, d) });
    zap('green');
    return true;
  }
  function blast(bd, p, n, d) {
    const b = B();
    try { if (b.alive(bd.id)) b.crater(bd, p, n, rnd(HOLE[0], HOLE[1])); } catch (e) { console.warn('[aliens] crater', e); }
    // green sparks and dust
    for (let k = 0; k < 26; k++) {
      const sp = rnd(0.3, 1.2);
      emit(p.x, p.y, p.z, { vx: (n.x + rnd(-0.8, 0.8)) * sp, vy: (n.y + rnd(-0.2, 1)) * sp, vz: (n.z + rnd(-0.8, 0.8)) * sp, g: 2.4, ground: 0.03,
        size: rnd(0.008, 0.02), life: rnd(0.4, 1), color: k % 3 ? '#7dff5a' : '#e8ffd8' });
    }
    const c = C();
    if (c && c.smoke) for (let k = 0; k < 5; k++) c.smoke('dust', p.x + n.x * 0.03, p.y, p.z + n.z * 0.03, { vx: n.x * rnd(0.2, 0.5) + rnd(-0.15, 0.15), vy: rnd(-0.05, 0.15), vz: n.z * rnd(0.2, 0.5) + rnd(-0.15, 0.15), size: rnd(0.06, 0.11), grow: 4, life: rnd(2, 4), drag: 1.2, rise: 0.03 });
    zap('boom');
  }

  // ---------- the invasion ----------
  let inv = null;                        // { t, shots: [{ at, kind, id }], peopleCounted }
  let ufos = [];
  let killed = 0;
  function cityBox(all) {
    if (!all.length) return { x0: -4, x1: 4, z0: -4, z1: 4, top: 1 };
    return { x0: Math.min(...all.map((b) => b.x0)), x1: Math.max(...all.map((b) => b.x1)), z0: Math.min(...all.map((b) => b.z0)), z1: Math.max(...all.map((b) => b.z1)), top: Math.max(...all.map((b) => b.top || 0)) };
  }
  function start(opts = {}) {
    if (!C()) { alert('De invasie heeft het core-script nodig (savings-city-core).'); return null; }
    if (!B()) { alert('De invasie heeft het gebouwen-script nodig (savings-city-buildings).'); return null; }
    if (!ensure()) { alert('De 3D-stad is nog niet geladen.'); return null; }
    if (inv) return null;
    const all = B().list(), box = cityBox(all);
    const cx = (box.x0 + box.x1) / 2, cz = (box.z0 + box.z1) / 2;
    const n = opts.ufos || Math.max(UFOS[0], Math.min(UFOS[1], Math.round(all.length / BUILDINGS_PER_UFO) + 3));
    const alt = Math.max(MIN_ALTITUDE, box.top + rnd(ALTITUDE[0], ALTITUDE[1]));
    // stations: spread over the city
    const stations = [];
    for (let tries = 0; stations.length < n && tries < n * 60; tries++) {
      const x = rnd(box.x0, box.x1), z = rnd(box.z0, box.z1);
      if (tries < n * 50 && stations.some((s) => Math.hypot(s.x - x, s.z - z) < MIN_GAP)) continue;
      stations.push({ x, y: alt + rnd(-0.3, 0.3), z });
    }
    const a0 = Math.random() * Math.PI * 2;
    ufos = stations.map((s, i) => {
      // come in from outside, roughly from the side the station is on (spread around the compass)
      const a = a0 + (i / stations.length) * Math.PI * 2 + rnd(-0.3, 0.3);
      const from = { x: cx + Math.sin(a) * COME_FROM, y: alt + rnd(3, 6), z: cz + Math.cos(a) * COME_FROM };
      const u = makeUfo(s, from);
      const b = a + rnd(-0.6, 0.6); u.out = { x: Math.sin(b), z: Math.cos(b) };
      return u;
    });
    // the buildings: a few shots each, spread over the attack; cut them now
    const shots = [];
    const targets = all.slice().sort(() => Math.random() - 0.5).slice(0, MAX_TARGETS);
    for (const bd of targets) {
      const k = Math.min(4, opts.shots || Math.round(rnd(SHOTS[0] - 0.49, SHOTS[1] + 0.49)));
      for (let j = 0; j < k; j++) shots.push({ at: ARRIVE + rnd(0.15, ATTACK - 0.3), kind: 'b', id: bd.id });
      try { B().prepare(bd.id); } catch (e) { /* cut when hit */ }
    }
    shots.sort((p, q) => p.at - q.at);
    inv = { t: 0, shots, ended: false, panicAt: PANIC_AT };
    countPeople();
    killed = 0;
    hum(true);
    updateButton();
    return { ufos: ufos.length, buildings: targets.length, shots: shots.length };
  }
  // everyone outside runs, away from the saucers (alarm() from below each one, in random order)
  function panic() {
    const res = RES(); if (!res || !res.alarm) return;
    for (const u of ufos.slice().sort(() => Math.random() - 0.5)) {
      try { res.alarm(u.x, u.z, 60, PANIC_EVERY + 4); } catch (e) { console.warn('[aliens] panic', e); return; }
    }
  }
  // at the click (before anyone runs indoors): half of the people outside, spread over the attack
  function countPeople() {
    const res = RES();
    let total = 0;
    if (res && res.people) for (const q of res.people) if (q && q.state !== 'inside' && q.state !== 'down' && q.state !== 'gone') total++;
    const cops = (COPS() && typeof COPS().officers === 'function' && COPS().officers()) || [];
    total += cops.filter((c) => c.state === 'exit' || c.state === 'fight').length;
    const n = Math.floor(total * PEOPLE_SHARE);
    for (let k = 0; k < n; k++) inv.shots.push({ at: ARRIVE + 0.1 + (ATTACK - 0.4) * ((k + Math.random()) / n), kind: 'p' });
    inv.shots.sort((p, q) => p.at - q.at);
    inv.people = n;
  }

  function step(dt) {
    if (!ready) return;
    dt = Math.min(dt, 0.05);
    if (inv) {
      inv.t += dt;
      const t = inv.t;
      for (const u of ufos) moveUfo(u, t, dt);
      if (t >= inv.panicAt && t < ARRIVE + ATTACK + LEAVE) { inv.panicAt = t + PANIC_EVERY; panic(); }
      while (inv.shots.length && inv.shots[0].at <= t) {
        const s = inv.shots.shift();
        try { if (s.kind === 'p') shootPerson(); else shootBuilding(s.id); } catch (e) { console.warn('[aliens] shot', e); }
      }
      if (t >= ARRIVE + ATTACK + LEAVE) {
        for (const u of ufos) u.root.removeFromParent();
        ufos = []; inv = null; hum(false); updateButton();
      }
    }
    stepBeams(beams.green, dt);
    stepBeams(beams.red, dt);
    stepParts(dt);
  }

  // ---------- sound ----------
  let humNodes = null, zapBudget = MAX_ZAPS, zapAt = 0;
  function actx() { const c = C(); return c && c.audio ? c.audio() : null; }
  function hum(on) {
    if (!SOUND) return;
    try {
      const a = actx(); if (!a) return;
      const t = a.currentTime;
      if (on && !humNodes) {
        // two detuned oscillators with a wobbling pitch: the classic saucer warble
        const g = a.createGain(), o1 = a.createOscillator(), o2 = a.createOscillator(), lfo = a.createOscillator(), lg = a.createGain(), f = a.createBiquadFilter();
        o1.type = 'sine'; o1.frequency.value = 220; o2.type = 'triangle'; o2.frequency.value = 331;
        lfo.frequency.value = 6; lg.gain.value = 40; lfo.connect(lg); lg.connect(o1.frequency); lg.connect(o2.frequency);
        f.type = 'lowpass'; f.frequency.value = 1400;
        o1.connect(f); o2.connect(f); f.connect(g); g.connect(out(a));
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.09, t + ARRIVE * 0.8);
        g.gain.setValueAtTime(0.09, t + ARRIVE + ATTACK); g.gain.exponentialRampToValueAtTime(0.0001, t + ARRIVE + ATTACK + LEAVE);
        // the pitch rises as they leave
        o1.frequency.setValueAtTime(220, t + ARRIVE + ATTACK); o1.frequency.exponentialRampToValueAtTime(520, t + ARRIVE + ATTACK + LEAVE);
        o2.frequency.setValueAtTime(331, t + ARRIVE + ATTACK); o2.frequency.exponentialRampToValueAtTime(780, t + ARRIVE + ATTACK + LEAVE);
        const end = t + ARRIVE + ATTACK + LEAVE + 0.1;
        for (const o of [o1, o2, lfo]) { o.start(t); o.stop(end); }
        humNodes = { g, end };
        o1.onended = () => { humNodes = null; };
      }
    } catch {}
  }
  function zap(kind) {
    if (!SOUND) return;
    try {
      const a = actx(); if (!a) return;
      const now = a.currentTime;
      if (kind === 'red') {
        zapBudget = Math.min(MAX_ZAPS, zapBudget + (now - zapAt) * MAX_ZAPS); zapAt = now;
        if (zapBudget < 1) return; zapBudget--;
      }
      const t = now, o = a.createOscillator(), g = a.createGain();
      o.connect(g); g.connect(out(a));
      if (kind === 'boom') {
        const len = 0.5; o.type = 'sawtooth'; o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(40, t + len);
        g.gain.setValueAtTime(0.12, t); g.gain.exponentialRampToValueAtTime(0.0001, t + len); o.start(t); o.stop(t + len + 0.02);
        return;
      }
      const green = kind === 'green', len = green ? 0.38 : 0.14;
      o.type = green ? 'sawtooth' : 'square';
      o.frequency.setValueAtTime(green ? 1100 : 2400, t); o.frequency.exponentialRampToValueAtTime(green ? 140 : 500, t + len);
      g.gain.setValueAtTime(green ? 0.12 : 0.035, t); g.gain.exponentialRampToValueAtTime(0.0001, t + len);
      o.start(t); o.stop(t + len + 0.02);
    } catch {}
  }

  // ---------- menu entry ----------
  const SVG = 'xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="g-ico" aria-hidden="true"';
  const ICON = `<svg ${SVG}><path d="M8 10a4 4 0 0 1 8 0"/><ellipse cx="12" cy="11.5" rx="10" ry="3"/><path d="M8 16l-2 5"/><path d="M16 16l2 5"/><path d="M12 15v6"/></svg>`;
  function updateButton() { const c = window.scCore; if (c && c.menu) c.menu.update(); }
  const whenCore = (fn) => (window.scCore ? fn(window.scCore) : (window.scCoreWaiting = window.scCoreWaiting || []).push(fn));
  whenCore((c) => c.menu && c.menu.add({
    id: 'aliens', order: 25, icon: ICON,
    label: () => (inv ? 'Invasie bezig…' : 'Buitenaardse invasie'),
    active: () => !!inv,
    onClick: () => { try { actx(); } catch {} if (!inv) start(); },
  }));

  window.scAliens = {
    // start an invasion; opts: ufos (how many), shots (per building)
    start: (opts) => start(opts || {}),
    get state() { return inv ? { t: inv.t, shotsLeft: inv.shots.length, people: inv.people || 0, killed, ufos: ufos.length } : { t: null, killed, ufos: 0 }; },
    get ufos() { return ufos.map((u) => ({ x: u.x, y: u.y, z: u.z })); },
  };
})();
