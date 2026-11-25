// ==UserScript==
// @name         Savings City – cops (walk mode)
// @namespace    savings-city-tweaks
// @version      1.2
// @description  Shoot in walk mode and nearby police cars stop: two officers get out and shoot back. You have 10 hearts; lose them all and you die.
// @match        https://your-savings-city-host.example/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * Needs the walk-mode script (1.20 or newer): it announces your shots (sc:shot), explosions
 * (sc:blast) and walk mode starting/stopping (sc:walk), and gives this script window.scWalk
 * (your position, wall tests, bullet tracers, effects, and addTarget so the officers can be shot).
 * Collapsing buildings (rocket launcher / monster) announce sc:crush.
 *
 * - When you fire, the nearest police car within ALERT_RADIUS that isn't busy yet stops
 *   (the app's car is held with parked = Infinity, speed 0, like walk mode does with wrecks).
 *   After a moment two officers step out, one each side, and come for you.
 * - Officers walk towards you until they can see you (no wall in between, checked against the
 *   buildings' triangles) and are within range, then stop and fire every SHOT_INTERVAL seconds.
 *   Their aim gets worse with distance and when you're running. Each hit costs a heart.
 * - At most MAX_CARS cars respond at once; once a car's officers are dead the next shot can
 *   bring another one.
 * - Officers are people too: a shot drops them, explosions knock them down or blow them apart,
 *   collapsing buildings bury them. Each death is announced as sc:kill (the bodycount counts it).
 * - 0 hearts: walk mode stops and "You died" fills the screen. Hearts are full again every time
 *   you start walking.
 * Officers are a few boxes each (own meshes; there are at most 2 × MAX_CARS).
 */
(function () {
  'use strict';

  // ---------- sound follows the app's own sound button (mute + volume, kept in localStorage) ----------
  // Everything this script plays goes through one gain node that copies the app's setting, also
  // while a sound is playing (checked twice a second).
  const appSoundLevel = () => {
    try {
      if (localStorage.getItem('citysaver:muted') === '1') return 0;
      const v = parseFloat(localStorage.getItem('citysaver:volume'));
      return Math.min(2.8, ((Number.isFinite(v) ? v : 0.6) / 0.6) ** 2);   // the app's level: volume², 0.6 = normal
    } catch { return 1; }
  };
  let soundOut = null;
  function out(ctx) {
    if (!soundOut || soundOut.context !== ctx) {
      soundOut = ctx.createGain();
      soundOut.gain.value = appSoundLevel();
      soundOut.connect(ctx.destination);
      if (!out.timer) out.timer = setInterval(() => { if (soundOut) soundOut.gain.setTargetAtTime(appSoundLevel(), soundOut.context.currentTime, 0.05); }, 500);
    }
    return soundOut;
  }


  // ---- settings (tiles; 1 tile ≈ 20 m) ----
  const HEARTS = 10;
  const ALERT_RADIUS = 7;          // police cars this close to a shot respond
  const MAX_CARS = 2;              // cars with living officers at the same time
  const COPS_PER_CAR = 2;
  const EXIT_DELAY = 0.7;          // seconds between the car stopping and the doors opening
  const COP_SPEED = 0.45;          // walking/running towards you (you walk 0.8, run 2)
  const RANGE = 5;                 // they fire from this distance when they can see you
  const KEEP_DISTANCE = 1.2;       // and don't come closer than this
  const SHOT_INTERVAL = [1.1, 2.0];// seconds between an officer's shots
  const ACCURACY = 0.45;           // chance to hit at point-blank range…
  const ACCURACY_FALLOFF = 0.08;   // …minus this per tile of distance…
  const MIN_ACCURACY = 0.12;       // …but never below this
  const RUNNING_DODGE = 0.55;      // aim × this while you're running
  const FIRST_SHOT_DELAY = 1.2;    // seconds before a fresh officer fires the first time
  // No police car close by? Now and then one comes from out of sight, along the roads:
  const SPAWN_CHANCE = 0.15;       // chance per second of shooting…
  const SPAWN_MIN_GAP = 15;        // …but not within this many seconds of the last police
  const SPAWN_GUARANTEE = 40;      // after this many seconds without police while you shoot: always
  const SPAWN_ROADS = [6, 16];     // it starts this many road tiles away, somewhere you can't see
  const SPAWN_SPEED = 2.2;         // tiles per second (normal cars about 1–2)
  const SPAWN_STOP = 2.2;          // it stops this close to you
  const SIREN = true;
  // ---------------------------------------------

  const rnd = (a, b) => a + Math.random() * (b - a);
  const W = () => window.scWalk;
  let K = null, geo = null, headGeo = null, mat = null;
  const HEAD_Y = 0.118;            // middle of the head above the feet (head + cap: 0.104 … 0.133)
  const cars = [];                 // { car, saved, cops: [], exitAt }
  const cops = [];                 // { x, z, h, state, t, nextShot, mesh, unit }
  let hearts = HEARTS, dead = false;

  // ---------- model ----------
  function model() {
    if (geo) return true;
    const w = W(); if (!w) return false;
    K = w.classes(); if (!K || !K.Color) return false;
    let P = [], N = [], C = [];
    const col = (hex) => { const c = new K.Color(hex); return [c.r, c.g, c.b]; };
    // a box from (x0, y0, z0) of size w × h × d, faces shaded like the residents (light from above)
    const box = (x0, y0, z0, bw, bh, bd, hex) => {
      const c = col(hex), x1 = x0 + bw, y1 = y0 + bh, z1 = z0 + bd;
      const quad = (a, b, cc, d, n, s) => { for (const v of [a, b, cc, a, cc, d]) { P.push(...v); N.push(...n); C.push(c[0] * s, c[1] * s, c[2] * s); } };
      quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], 0.85);
      quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1], 0.7);
      quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0], 0.78);
      quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0], 0.78);
      quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0], 1);
      quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0], 0.5);
    };
    const NAVY = '#1f2a4a', SHIRT = '#3b5a9a', SKIN = '#e0b48f', BLACK = '#18181b', GOLD = '#d8b23a';
    // facing +z; feet at y = 0 (same proportions as the residents: 0.048 legs, 0.055 torso, 0.022 head)
    box(-0.017, 0, -0.01, 0.015, 0.048, 0.02, NAVY);          // legs
    box(0.002, 0, -0.01, 0.015, 0.048, 0.02, NAVY);
    box(-0.02, 0.048, -0.012, 0.04, 0.055, 0.024, SHIRT);    // torso
    box(-0.0205, 0.05, -0.0125, 0.041, 0.006, 0.025, BLACK); // belt
    box(0.006, 0.088, 0.0118, 0.007, 0.007, 0.002, GOLD);    // badge
    box(0.02, 0.082, -0.005, 0.01, 0.01, 0.045, SHIRT);      // arms stretched out to the gun
    box(-0.03, 0.082, -0.005, 0.01, 0.01, 0.045, SHIRT);
    box(-0.012, 0.081, 0.037, 0.028, 0.011, 0.01, SKIN);     // hands
    box(-0.003, 0.088, 0.04, 0.007, 0.01, 0.028, BLACK);     // gun
    const make = () => {
      const g = new K.Geometry();
      g.setAttribute('position', new K.Attr(new Float32Array(P), 3));
      g.setAttribute('normal', new K.Attr(new Float32Array(N), 3));
      g.setAttribute('color', new K.Attr(new Float32Array(C), 3));
      P = []; N = []; C = [];
      return g;
    };
    geo = make();
    // the head on its own (centred on its middle), so a head shot can knock it off
    const hy = HEAD_Y;
    box(-0.011, 0.104 - hy, -0.011, 0.022, 0.022, 0.022, SKIN);   // head
    box(-0.013, 0.124 - hy, -0.013, 0.026, 0.009, 0.026, NAVY);   // cap
    box(-0.012, 0.124 - hy, 0.012, 0.024, 0.003, 0.01, BLACK);    // cap's peak
    box(-0.004, 0.128 - hy, 0.0125, 0.008, 0.005, 0.002, GOLD);
    headGeo = make();
    mat = new K.Basic({ vertexColors: true });
    return true;
  }

  // ---------- police cars responding ----------
  function policeCars() {
    const w = W(), list = w.trafficCars(); if (!list) return [];
    const out = [];
    for (const [i, m] of w.carObjects()) {
      const car = list[i];
      if (car && m.userData.car && m.userData.car.kind === 'police' && !car.scBurst && !car.scFlat && car.parked !== Infinity) out.push(car);
    }
    return out;
  }
  function respond(x, z) {
    if (dead || !model()) return false;
    if (busyUnits() >= MAX_CARS) return false;
    let best = null, bd = ALERT_RADIUS;
    for (const car of policeCars()) {
      if (cars.some((c) => c.car === car)) continue;
      const d = Math.hypot(car.x - x, car.z - z);
      if (d < bd) { bd = d; best = car; }
    }
    if (!best) return false;
    const c = { car: best, saved: { parked: best.parked, speed: best.speed }, cops: [], exitAt: performance.now() + EXIT_DELAY * 1000 };
    best.parked = Infinity; best.speed = 0;
    cars.push(c);
    lastPolice = performance.now();
    return true;
  }
  const busyUnits = () => cars.filter((c) => !c.done && (c.driving || c.cops.some((p) => p.state !== 'down' && p.state !== 'gone') || !c.cops.length)).length;

  // ---------- police cars coming from out of sight ----------
  // The road network from the city data the app reads (every Response.json() is watched).
  let roads = null;
  const origJson = Response.prototype.json;
  Response.prototype.json = async function () {
    const d = await origJson.apply(this, arguments);
    try { if (d && Array.isArray(d.roads) && Array.isArray(d.projects)) roads = buildRoads(d.roads); } catch (e) { console.warn('[cops] roads', e); }
    return d;
  };
  function buildRoads(keys) {
    const adj = new Map(), add = (a, b) => { (adj.get(a) || adj.set(a, []).get(a)).push(b); };
    for (const k of keys) {
      const [x, y, t] = k.split(','), a = x + ',' + y, b = t === 'h' ? (+x + 1) + ',' + y : x + ',' + (+y + 1);
      add(a, b); add(b, a);
    }
    return adj;
  }
  const xy = (n) => n.split(',').map(Number);
  let lastPolice = 0, lastRoll = 0;
  function maybeSpawn(now) {
    if (!roads || busyUnits() >= MAX_CARS) return;
    if (now - lastRoll < 1000) return;
    lastRoll = now;
    const since = (now - lastPolice) / 1000;
    if (since < SPAWN_GUARANTEE && (since < SPAWN_MIN_GAP || Math.random() > SPAWN_CHANCE)) return;
    spawnCar();
  }
  function spawnCar() {
    const w = W(), pl = w.player;
    if (!model() || !roads) return false;
    // the road point nearest to you, then every road point by its distance along the roads
    let target = null, td = Infinity;
    for (const n of roads.keys()) { const [x, z] = xy(n), d = Math.hypot(x - pl.x, z - pl.z); if (d < td) { td = d; target = n; } }
    if (!target || td > 3) return false;
    const dist = new Map([[target, 0]]), next = new Map(), queue = [target];
    for (let i = 0; i < queue.length; i++) {
      const n = queue[i], dn = dist.get(n);
      if (dn >= SPAWN_ROADS[1]) continue;
      for (const m of roads.get(n) || []) if (!dist.has(m)) { dist.set(m, dn + 1); next.set(m, n); queue.push(m); }
    }
    // out of sight: behind you, or a building in between
    const fx = -Math.sin(pl.yaw), fz = -Math.cos(pl.yaw);
    const hidden = (x, z) => {
      const dx = x - pl.x, dz = z - pl.z, l = Math.hypot(dx, dz) || 1;
      if ((dx * fx + dz * fz) / l < Math.cos(80 * Math.PI / 180)) return true;
      const dy = 0.08 - pl.y, L = Math.hypot(dx, dy, dz), wall = w.rayBuildings(pl, { x: dx / L, y: dy / L, z: dz / L }, L);
      return !!wall;
    };
    const starts = [...dist.entries()].filter(([n, d]) => d >= SPAWN_ROADS[0] && d <= SPAWN_ROADS[1] && hidden(...xy(n))).map(([n]) => n);
    if (!starts.length) return false;
    const start = starts[Math.floor(Math.random() * starts.length)];
    const path = [start]; while (path[path.length - 1] !== target) path.push(next.get(path[path.length - 1]));
    const pts = path.map(xy);
    const car = { x: pts[0][0], z: pts[0][1], heading: Math.atan2(pts[1][1] - pts[0][1], pts[1][0] - pts[0][0]), own: true, hits: 0 };
    const c = { car, saved: null, cops: [], exitAt: Infinity, driving: true, pts, seg: 0, s: 0, speed: 0 };
    c.mesh = carMesh(); w.scene.add(c.mesh);
    cars.push(c);
    lastPolice = performance.now();
    placeCar(c);
    return true;
  }
  // the app's own police car model (from its car batches); our own boxes if there is none
  let carModel = null;
  function carMesh() {
    const w = W();
    if (!carModel) {
      const list = w.trafficCars() || [], objs = w.carObjects();
      let idx = -1, y = 0.04;
      for (const [i, m] of objs) if (m.userData.car && m.userData.car.kind === 'police') { idx = i; y = m.position.y; break; }
      let batch = null;
      if (idx >= 0) w.scene.traverse((o) => { if (!batch && o.isInstancedMesh && Array.isArray(o.userData.cars) && o.userData.cars.includes(idx)) batch = o; });
      if (batch) carModel = { geo: batch.geometry, mat: batch.material, y };
      else {
        let P = [], N = [], C = [];
        const col = (hex) => { const c = new K.Color(hex); return [c.r, c.g, c.b]; };
        const box = (x0, y0, z0, bw, bh, bd, hex) => {
          const c = col(hex), x1 = x0 + bw, y1 = y0 + bh, z1 = z0 + bd;
          const quad = (a, b, cc, d, n, sh) => { for (const v of [a, b, cc, a, cc, d]) { P.push(...v); N.push(...n); C.push(c[0] * sh, c[1] * sh, c[2] * sh); } };
          quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], 0.8); quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1], 0.7);
          quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0], 0.85); quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0], 0.75);
          quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0], 1);
        };
        box(-0.11, 0.022, -0.0525, 0.22, 0.045, 0.105, '#1f2230'); box(-0.055, 0.067, -0.0445, 0.1, 0.04, 0.089, '#5fe0d8');
        box(-0.05, 0.107, -0.0445, 0.09, 0.008, 0.089, '#f4f4f4');
        for (const [x, z] of [[-0.065, -0.0525], [0.065, -0.0525], [-0.065, 0.0365], [0.065, 0.0365]]) box(x - 0.022, 0, z, 0.044, 0.04, 0.016, '#2a2a2e');
        const g = new K.Geometry();
        g.setAttribute('position', new K.Attr(new Float32Array(P), 3)); g.setAttribute('normal', new K.Attr(new Float32Array(N), 3)); g.setAttribute('color', new K.Attr(new Float32Array(C), 3));
        carModel = { geo: g, mat: new K.Basic({ vertexColors: true }), y: 0.04 };
      }
    }
    const m = new K.Mesh(carModel.geo, carModel.mat);
    m.castShadow = true; m.frustumCulled = false;
    // flashing lights on the roof
    const lamp = (hex, z) => { const b = new K.Mesh(new K.Geometry(), new K.Basic({ color: hex })); b.geometry = cube(); b.scale.set(0.03, 0.018, 0.028); b.position.set(-0.005, 0.124, z); m.add(b); return b; };
    m.userData.lights = [lamp('#ff2a2a', -0.016), lamp('#2a6bff', 0.016)];
    m.userData.y = carModel.y;
    return m;
  }
  let cubeGeo = null;
  function cube() {
    if (cubeGeo) return cubeGeo;
    const P = [], N = [], h = 0.5;
    const quad = (a, b, c, e, n) => { for (const v of [a, b, c, a, c, e]) { P.push(...v); N.push(...n); } };
    quad([-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h], [0, 0, 1]); quad([h, -h, -h], [-h, -h, -h], [-h, h, -h], [h, h, -h], [0, 0, -1]);
    quad([h, -h, h], [h, -h, -h], [h, h, -h], [h, h, h], [1, 0, 0]); quad([-h, -h, -h], [-h, -h, h], [-h, h, h], [-h, h, -h], [-1, 0, 0]);
    quad([-h, h, h], [h, h, h], [h, h, -h], [-h, h, -h], [0, 1, 0]); quad([-h, -h, -h], [h, -h, -h], [h, -h, h], [-h, -h, h], [0, -1, 0]);
    cubeGeo = new K.Geometry();
    cubeGeo.setAttribute('position', new K.Attr(new Float32Array(P), 3)); cubeGeo.setAttribute('normal', new K.Attr(new Float32Array(N), 3));
    return cubeGeo;
  }
  // drive along the path, keeping right; stop close to you
  function placeCar(c) {
    const a = c.pts[c.seg], b = c.pts[Math.min(c.seg + 1, c.pts.length - 1)];
    const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1, ux = dx / l, uz = dz / l;
    const want = Math.atan2(uz, ux);
    let dh = want - c.car.heading; dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    c.car.heading += dh * Math.min(1, 0.25);
    c.car.x = a[0] + ux * c.s - uz * 0.08; c.car.z = a[1] + uz * c.s + ux * 0.08;   // right-hand lane
    c.mesh.position.set(c.car.x, c.mesh.userData.y, c.car.z);
    c.mesh.rotation.y = -c.car.heading;
  }
  function stepOwnCars(dt, now) {
    const pl = W().player;
    for (const c of cars) {
      if (!c.car.own || c.car.wreck) continue;
      const lights = c.mesh.userData.lights, on = Math.floor(now / 180) % 2;
      if (lights) { lights[0].visible = !!on; lights[1].visible = !on; }
      if (!c.driving) continue;
      c.speed = Math.min(SPAWN_SPEED, c.speed + SPAWN_SPEED * dt);
      c.s += c.speed * dt;
      while (c.seg < c.pts.length - 1 && c.s >= 1) { c.s -= 1; c.seg++; }
      const end = c.seg >= c.pts.length - 1;
      if (end) c.s = 0;
      placeCar(c);
      if (end || Math.hypot(c.car.x - pl.x, c.car.z - pl.z) < SPAWN_STOP) {   // there: doors open
        c.driving = false; c.exitAt = now + EXIT_DELAY * 1000; siren(null);
      } else siren(c);
    }
  }
  // a wailing siren while one drives, louder when it's close
  let sirenOsc = null, sirenGain = null;
  function siren(c) {
    if (!SIREN) return;
    try {
      if (!c) { if (sirenGain) sirenGain.gain.setTargetAtTime(0, ctx().currentTime, 0.2); return; }
      const a = ctx();
      if (!sirenOsc) {
        sirenOsc = a.createOscillator(); sirenGain = a.createGain(); const lfo = a.createOscillator(), lg = a.createGain();
        sirenOsc.type = 'square'; sirenOsc.frequency.value = 800; lfo.frequency.value = 0.6; lg.gain.value = 260;
        lfo.connect(lg); lg.connect(sirenOsc.frequency);
        const f = a.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 1800;
        sirenOsc.connect(f); f.connect(sirenGain); sirenGain.connect(out(a)); sirenGain.gain.value = 0;
        sirenOsc.start(); lfo.start();
      }
      const pl = W().player, d = Math.hypot(c.car.x - pl.x, c.car.z - pl.z);
      sirenGain.gain.setTargetAtTime(0.12 / (1 + d * d * 0.05), a.currentTime, 0.1);
    } catch {}
  }
  // our own car can be shot (3 hits) or blown up
  function hitOwnCar(o, d, maxT) {
    let best = null;
    for (const c of cars) {
      if (!c.car.own || c.car.wreck) continue;
      const car = c.car, y0 = c.mesh.userData.y, co = Math.cos(car.heading), si = Math.sin(car.heading);
      const rx = o.x - car.x, rz = o.z - car.z;
      const OO = [rx * co + rz * si, o.y - y0, -rx * si + rz * co], DD = [d.x * co + d.z * si, d.y, -d.x * si + d.z * co];
      const lo = [-0.115, 0, -0.06], hi = [0.115, 0.13, 0.06];
      let t0 = 0, t1 = best ? best.t : maxT, ok = true;
      for (let k = 0; k < 3 && ok; k++) {
        if (Math.abs(DD[k]) < 1e-12) { if (OO[k] < lo[k] || OO[k] > hi[k]) ok = false; continue; }
        let a = (lo[k] - OO[k]) / DD[k], b = (hi[k] - OO[k]) / DD[k]; if (a > b) [a, b] = [b, a];
        t0 = Math.max(t0, a); t1 = Math.min(t1, b); if (t0 > t1) ok = false;
      }
      if (ok && t0 > 0) best = { t: t0, unit: c };
    }
    return best;
  }
  function explodeOwn(c) {
    const w = W(), car = c.car;
    if (car.wreck) return;
    car.wreck = true; c.driving = false; c.done = true; siren(null);
    const x = car.x, z = car.z;
    w.sound('boom');
    w.spawn('flash', x, 0.08, z, { size: 0.5, life: 0.3, grow: 2.2 });
    for (let k = 0; k < 50; k++) { const a = Math.random() * Math.PI * 2, up = Math.random(), sp = rnd(0.6, 1.6); w.spawn('fire', x, 0.08, z, { vx: Math.cos(a) * sp * (1 - up * 0.5), vy: 0.5 + up * 1.8, vz: Math.sin(a) * sp * (1 - up * 0.5), g: 1.6, size: rnd(0.04, 0.08), life: rnd(0.5, 1.1) }); }
    if (w.blackSmoke) for (let k = 0; k < 24; k++) w.blackSmoke(x + rnd(-0.1, 0.1), rnd(0.1, 0.35), z + rnd(-0.1, 0.1), { vx: rnd(-0.3, 0.3), vy: rnd(0.6, 1.4), vz: rnd(-0.3, 0.3), rise: rnd(0.35, 0.8), size: rnd(0.08, 0.16), life: rnd(4, 8) });
    w.startEffects();
    // burnt: our own copy of the material, darkened
    c.mesh.material = c.mesh.material.clone(); if (c.mesh.material.color) c.mesh.material.color.multiplyScalar(0.18);
    for (const l of c.mesh.userData.lights || []) l.visible = false;
    c.mesh.userData.lights = null;
    const res = window.scResidents;
    if (res && res.gibAround) res.gibAround(x, z, 0.3, 1.1);
    if (res && res.blast) res.blast(x, z, 1.3, 5, 12);
    window.dispatchEvent(new CustomEvent('sc:car-exploded', { detail: { x, z, police: true } }));
    if (!c.cops.length) for (let k = 0; k < COPS_PER_CAR; k++) window.dispatchEvent(new CustomEvent('sc:kill', { detail: { x, z, cause: 'car', who: 'cop' } }));   // still inside
    c.exitAt = Infinity;
    if (w.blastEvent) w.blastEvent(x, z, 0.3, 1.3, 5);
    c.burn = { t0: performance.now(), at: 0 };
  }
  function stepBurning(dt, now) {
    const w = W();
    for (const c of cars) {
      if (!c.burn) continue;
      const heat = Math.max(0, 1 - (now - c.burn.t0) / 25000); if (heat <= 0) continue;
      c.burn.at -= dt;
      while (c.burn.at <= 0) {
        c.burn.at += 0.1 / heat;
        w.spawn('fire', c.car.x + rnd(-0.08, 0.08), 0.1, c.car.z + rnd(-0.04, 0.04), { vy: rnd(0.2, 0.45), size: rnd(0.025, 0.05) * (0.5 + heat / 2), life: rnd(0.5, 1) });
        if (w.blackSmoke) w.blackSmoke(c.car.x, 0.13, c.car.z, { vy: rnd(0.3, 0.5), rise: rnd(0.35, 0.55), size: rnd(0.04, 0.07), life: rnd(5, 9), alpha: 0.85 * (0.5 + heat / 2) });
      }
      w.startEffects();
    }
  }
  function getOut(c) {
    const car = c.car, fx = Math.cos(car.heading), fz = Math.sin(car.heading);   // the app turns cars by −heading
    for (let k = 0; k < COPS_PER_CAR; k++) {
      const side = k % 2 ? 1 : -1;
      const cop = { x: car.x - fz * 0.085 * side + fx * rnd(-0.03, 0.03), z: car.z + fx * 0.085 * side + fz * rnd(-0.03, 0.03), h: 0, state: 'exit', t: 0,
        out: [-fz * side, fx * side], nextShot: performance.now() + (FIRST_SHOT_DELAY + rnd(0, 0.8)) * 1000, unit: c };
      cop.mesh = new K.Mesh(geo, mat);
      cop.mesh.castShadow = true; cop.mesh.frustumCulled = false;
      cop.head = new K.Mesh(headGeo, mat);
      cop.head.position.y = HEAD_Y; cop.head.castShadow = true; cop.head.frustumCulled = false;
      cop.mesh.add(cop.head);
      W().scene.add(cop.mesh);
      cops.push(cop); c.cops.push(cop);
    }
    c.car.scAbandoned = true;                                   // nobody inside any more
    W().sound('thud');
  }
  // send everyone home (walk mode stopped): officers gone, cars drive on
  function clearAll() {
    for (const cop of cops) cop.mesh.removeFromParent();
    cops.length = 0;
    for (const h of looseHeads) h.m.removeFromParent();
    looseHeads.length = 0;
    for (const c of cars) {
      if (c.car.own) { c.mesh.removeFromParent(); continue; }
      if (!c.car.scBurst && !c.car.scFlat && c.car.parked === Infinity && !wrecked(c.car)) { c.car.parked = c.saved.parked; c.car.speed = c.saved.speed; c.car.scAbandoned = false; }
    }
    cars.length = 0;
    siren(null);
  }
  const wrecked = (car) => car.scWrecked;
  window.addEventListener('sc:car-exploded', (e) => { for (const c of cars) if (Math.hypot(c.car.x - e.detail.x, c.car.z - e.detail.z) < 0.02) c.car.scWrecked = true; });

  // ---------- officers ----------
  const alive = (c) => c.state === 'exit' || c.state === 'fight';
  function step(dt, now) {
    const w = W(), pl = w.player;
    stepGore(dt);
    stepOwnCars(dt, now);
    stepBurning(dt, now);
    for (const c of cars) if (!c.cops.length && now >= c.exitAt && !c.car.scWrecked && !c.car.wreck) getOut(c);
    for (const cop of cops) {
      if (cop.state === 'down') { cop.fall = Math.min(1, cop.fall + dt / 0.45); pose(cop); continue; }
      if (cop.state === 'gone') continue;
      const dx = pl.x - cop.x, dz = pl.z - cop.z, dist = Math.hypot(dx, dz) || 1e-6;
      cop.t += dt;
      if (cop.state === 'exit') {
        move(cop, cop.out[0] * 0.25 * dt, cop.out[1] * 0.25 * dt);
        cop.h = Math.atan2(cop.out[0], cop.out[1]);
        if (cop.t > 0.4) cop.state = 'fight';
        pose(cop); continue;
      }
      cop.h = Math.atan2(dx, dz);
      const eyeY = 0.125, d = { x: dx / dist, y: (pl.y - 0.03 - eyeY) / dist, z: dz / dist };
      const dl = Math.hypot(d.x, d.y, d.z); d.x /= dl; d.y /= dl; d.z /= dl;
      const seen = dist <= RANGE && !w.rayBuildings({ x: cop.x, y: eyeY, z: cop.z }, d, dist * dl - 0.05);
      if (!seen || dist > KEEP_DISTANCE * rnd(1, 1.3)) {
        // come closer; sidestep a little so the two don't walk on top of each other
        const sp = COP_SPEED * (seen ? 0.5 : 1) * dt, sx = -d.z * (cop === cop.unit.cops[0] ? 0.3 : -0.3), sz = d.x * (cop === cop.unit.cops[0] ? 0.3 : -0.3);
        move(cop, (d.x + sx) * sp, (d.z + sz) * sp);
      }
      if (seen && now >= cop.nextShot) { cop.nextShot = now + rnd(...SHOT_INTERVAL) * 1000; shoot(cop, dist, d); }
      pose(cop);
    }
  }
  function move(cop, mx, mz) {
    const w = W();
    if (!w.blocked(cop.x + mx, cop.z)) cop.x += mx;
    if (!w.blocked(cop.x, cop.z + mz)) cop.z += mz;
  }
  function pose(cop) {
    const m = cop.mesh;
    m.position.set(cop.x, 0.038, cop.z);
    if (cop.state === 'down') {
      const f = cop.fall * cop.fall;
      m.quaternion.setFromAxisAngle(cop.axis, (Math.PI / 2) * f).multiply(new K.Q().setFromAxisAngle(new K.V3(0, 1, 0), cop.h));
      m.position.y += 0.011 * f;
    } else m.quaternion.setFromAxisAngle(new K.V3(0, 1, 0), cop.h);
  }

  // ---------- shooting at you ----------
  let lastPl = null, plSpeed = 0;
  function shoot(cop, dist, d) {
    const w = W(), pl = w.player;
    const start = { x: cop.x + Math.sin(cop.h) * 0.07, y: 0.093, z: cop.z + Math.cos(cop.h) * 0.07 };
    w.spawn('flash', start.x, start.y, start.z, { size: 0.02, life: 0.06, grow: 1.5 });
    w.startEffects();
    w.sound('shot');
    let chance = Math.max(MIN_ACCURACY, ACCURACY - dist * ACCURACY_FALLOFF);
    if (plSpeed > 1.2) chance *= RUNNING_DODGE;
    const hit = Math.random() < chance;
    const aim = { x: pl.x, y: pl.y - 0.03, z: pl.z };
    if (hit) { w.tracer(start, aim, () => hurt()); return; }
    // a miss: just past you, on until it meets a wall or the ground
    const rx = -d.z, rz = d.x, side = rnd(0.04, 0.12) * (Math.random() < 0.5 ? -1 : 1);
    const tx = aim.x + rx * side - start.x, ty = aim.y + rnd(-0.05, 0.06) - start.y, tz = aim.z + rz * side - start.z;
    const l = Math.hypot(tx, ty, tz) || 1, dir = { x: tx / l, y: ty / l, z: tz / l };
    let t = l + 4;
    if (dir.y < 0) t = Math.min(t, (start.y - 0.04) / -dir.y);
    const wall = w.rayBuildings(start, dir, t); if (wall) t = wall.t;
    w.tracer(start, { x: start.x + dir.x * t, y: start.y + dir.y * t, z: start.z + dir.z * t });
    whizz();
  }

  // ---------- your hearts ----------
  let ui = null, heartEls = [], hurtEl = null, diedEl = null;
  function buildUi() {
    if (ui) return;
    ui = document.createElement('div');
    ui.id = 'sc-cops-ui';
    const heart = '<svg viewBox="0 0 24 24" width="26" height="26"><path d="M12 21s-7.5-4.6-9.6-9.3C.9 8.3 3 4.5 6.6 4.5c2.2 0 3.7 1.2 5.4 3.2 1.7-2 3.2-3.2 5.4-3.2 3.6 0 5.7 3.8 4.2 7.2C19.5 16.4 12 21 12 21z"/></svg>';
    ui.innerHTML = `
      <style>
        #sc-cops-ui{position:fixed;inset:0;pointer-events:none;z-index:10000;font:700 16px/1.3 system-ui,sans-serif}
        #sc-cops-ui .hearts{position:absolute;left:50%;top:18px;transform:translateX(-50%);display:flex;gap:3px;filter:drop-shadow(0 1px 2px rgba(0,0,0,.6))}
        #sc-cops-ui .hearts svg path{fill:#e8313f;stroke:#fff;stroke-width:1.5}
        #sc-cops-ui .hearts .lost{animation:sc-heart-lost .5s ease-out forwards}
        #sc-cops-ui .hearts .lost svg path{fill:rgba(0,0,0,.25);stroke:rgba(255,255,255,.6)}
        @keyframes sc-heart-lost{0%{transform:scale(1.6)}100%{transform:scale(1)}}
        #sc-cops-ui .hurt{position:absolute;inset:0;box-shadow:inset 0 0 120px 40px rgba(200,0,0,.75);opacity:0;transition:opacity .45s}
        #sc-cops-ui .died{position:absolute;inset:0;display:none;flex-direction:column;align-items:center;justify-content:center;gap:28px;
          background:radial-gradient(ellipse at center,rgba(90,0,0,.55),rgba(10,0,0,.9));pointer-events:auto;animation:sc-died 1.2s ease-out}
        #sc-cops-ui .died h1{margin:0;font:900 clamp(48px,11vw,140px)/1 Georgia,'Times New Roman',serif;color:#d31a1a;letter-spacing:.04em;text-shadow:0 4px 18px #000}
        #sc-cops-ui .died button{font:700 18px system-ui,sans-serif;padding:10px 26px;border:0;border-radius:10px;background:#fff;color:#300;cursor:pointer}
        @keyframes sc-died{0%{opacity:0}100%{opacity:1}}
      </style>
      <div class="hurt"></div>
      <div class="hearts">${Array.from({ length: HEARTS }, () => `<span>${heart}</span>`).join('')}</div>
      <div class="died"><h1>You died</h1><button type="button">Opnieuw</button></div>`;
    document.body.appendChild(ui);
    heartEls = [...ui.querySelectorAll('.hearts span')];
    hurtEl = ui.querySelector('.hurt');
    diedEl = ui.querySelector('.died');
    diedEl.querySelector('button').addEventListener('click', () => { diedEl.style.display = 'none'; dead = false; hearts = HEARTS; drawHearts(); });
  }
  function drawHearts() {
    if (!ui) return;
    heartEls.forEach((el, i) => el.classList.toggle('lost', i >= hearts));
    ui.querySelector('.hearts').style.display = W() && W().walking ? 'flex' : 'none';
  }
  function hurt() {
    if (dead || !W().walking) return;
    hearts = Math.max(0, hearts - 1);
    buildUi(); drawHearts();
    hurtEl.style.transition = 'none'; hurtEl.style.opacity = '1';
    requestAnimationFrame(() => { hurtEl.style.transition = 'opacity .45s'; hurtEl.style.opacity = '0'; });
    ouch();
    if (hearts <= 0) die();
  }
  function die() {
    dead = true;
    W().leave();
    clearAll();
    buildUi();
    diedEl.style.display = 'flex';
    ui.querySelector('.hearts').style.display = 'none';
    sad();
  }

  // ---------- officers getting hurt ----------
  function kill(cop, d, how) {
    if (!alive(cop)) return false;
    const l = Math.hypot(d.x, d.z) || 1;
    const w = W();
    if (how === 'gib') {
      cop.state = 'gone'; cop.mesh.removeFromParent();
      const cols = ['#1f2a4a', '#3b5a9a', '#e0b48f', '#1f2a4a', '#3b5a9a'];
      for (let k = 0; k < 7; k++) w.spawn('debris', cop.x, rnd(0.03, 0.12), cop.z, { color: cols[k % cols.length], vx: d.x / l * rnd(0.4, 1.2) + rnd(-0.4, 0.4), vy: rnd(0.5, 1.3), vz: d.z / l * rnd(0.4, 1.2) + rnd(-0.4, 0.4), g: 3, size: rnd(0.012, 0.022), life: rnd(4, 6), land: true, spin: true });
    } else {
      cop.state = 'down'; cop.fall = 0;
      cop.axis = new K.V3(d.z / l, 0, -d.x / l);
      if (how === 'head') knockHeadOff(cop, d, l);
    }
    for (let k = 0; k < (how === 'gib' ? 30 : 14); k++) w.spawn('debris', cop.x, rnd(0.05, 0.1), cop.z, { color: k % 3 ? '#8a0b0b' : '#5e0606', vx: d.x / l * rnd(0, 0.6) + rnd(-0.25, 0.25), vy: rnd(0.1, 0.6), vz: d.z / l * rnd(0, 0.6) + rnd(-0.25, 0.25), g: 3, size: rnd(0.003, 0.006), life: rnd(4, 8), land: true });
    w.startEffects();
    w.sound('hit');
    window.dispatchEvent(new CustomEvent('sc:kill', { detail: { x: cop.x, z: cop.z, cause: how === 'gib' ? 'blast' : how, who: 'cop' } }));
    return true;
  }
  // head shot: the head (with the cap) flies off on its own, blood pulses from the neck for a while
  const looseHeads = [];
  function knockHeadOff(cop, d, l) {
    const head = cop.head; if (!head) return;
    cop.mesh.updateWorldMatrix(true, true);
    const p = new K.V3(); head.getWorldPosition(p);
    head.removeFromParent();
    head.position.copy(p); head.rotation.set(0, cop.h, 0);
    W().scene.add(head);
    cop.head = null;
    looseHeads.push({ m: head, v: [d.x / l * rnd(0.5, 1) + rnd(-0.2, 0.2), rnd(0.5, 1), d.z / l * rnd(0.5, 1) + rnd(-0.2, 0.2)], w: [rnd(-20, 20), rnd(-8, 8), rnd(-20, 20)], rest: false });
    cop.squirt = 3.5; cop.pulse = 0;
  }
  function stepGore(dt) {
    const w = W();
    for (const h of looseHeads) {
      if (h.rest) continue;
      const m = h.m;
      h.v[1] -= 3 * dt;
      m.position.x += h.v[0] * dt; m.position.y += h.v[1] * dt; m.position.z += h.v[2] * dt;
      m.rotation.x += h.w[0] * dt; m.rotation.y += h.w[1] * dt; m.rotation.z += h.w[2] * dt;
      if (Math.random() < 0.4) w.spawn('debris', m.position.x, m.position.y, m.position.z, { color: '#8a0b0b', vy: 0, g: 3, size: 0.003, life: 4, land: true });
      if (m.position.y < 0.05) {                                   // bounce, roll, then lie still
        m.position.y = 0.05;
        h.v[1] = Math.abs(h.v[1]) * 0.35; h.v[0] *= 0.55; h.v[2] *= 0.55; for (let k = 0; k < 3; k++) h.w[k] *= 0.5;
        if (Math.abs(h.v[1]) < 0.15 && Math.hypot(h.v[0], h.v[2]) < 0.05) h.rest = true;
      }
    }
    for (const cop of cops) {
      if (!(cop.squirt > 0)) continue;
      cop.squirt -= dt; cop.pulse -= dt;
      if (cop.pulse > 0) continue;
      cop.pulse = 0.35;                                            // heartbeats
      const n = new K.V3(0, 0.104, 0), up = new K.V3(0, 1, 0);
      cop.mesh.updateWorldMatrix(true, false);
      n.applyMatrix4(cop.mesh.matrixWorld); up.transformDirection(cop.mesh.matrixWorld);
      const f = Math.max(0.2, cop.squirt / 3.5);
      for (let k = 0; k < 7; k++) w.spawn('debris', n.x, n.y, n.z, { color: k % 2 ? '#8a0b0b' : '#a31010', vx: up.x * rnd(0.3, 0.8) * f + rnd(-0.08, 0.08), vy: up.y * rnd(0.3, 0.8) * f + rnd(0, 0.15), vz: up.z * rnd(0.3, 0.8) * f + rnd(-0.08, 0.08), g: 3, size: rnd(0.003, 0.006), life: rnd(4, 8), land: true });
    }
    w.startEffects();
  }
  // walk mode asks: is an officer on the line of fire?
  function register() {
    const w = W();
    if (!w || !w.addTarget || register.done) return;
    register.done = true;
    w.addTarget({
      hit(o, d, maxT) {
        const R = 0.022, a = d.x * d.x + d.z * d.z;
        let best = null;
        for (const cop of cops) {
          if (!alive(cop) || a < 1e-9) continue;
          const ex = o.x - cop.x, ez = o.z - cop.z, b = 2 * (ex * d.x + ez * d.z), c = ex * ex + ez * ez - R * R, disc = b * b - 4 * a * c;
          if (disc < 0) continue;
          const t = (-b - Math.sqrt(disc)) / (2 * a), y = o.y + d.y * t;
          if (t > 0 && t < maxT && y >= 0.038 && y <= 0.172 && (!best || t < best.t)) best = { t, cop, head: y >= 0.038 + 0.103 };
        }
        return best;
      },
      onHit(h, d) { kill(h.cop, d, h.head ? 'head' : 'shot'); },
    });
    w.addTarget({
      hit: (o, d, maxT) => hitOwnCar(o, d, maxT),
      onHit(h) {
        const c = h.unit; c.car.hits++;
        W().spawn('spark', c.car.x, 0.08, c.car.z, { vx: rnd(-0.4, 0.4), vy: rnd(0.2, 0.6), vz: rnd(-0.4, 0.4), g: 3, size: 0.004, life: 0.4 }); W().startEffects();
        if (c.car.hits >= 3) explodeOwn(c);
      },
    });
  }
  window.addEventListener('sc:blast', (e) => {
    const { x, z, gib = 0, knock = 0 } = e.detail;
    for (const c of cars) if (c.car.own && !c.car.wreck && Math.hypot(c.car.x - x, c.car.z - z) <= Math.max(0.35, knock * 0.5)) setTimeout(() => explodeOwn(c), 200 + Math.random() * 300);
    for (const cop of cops) {
      const dx = cop.x - x, dz = cop.z - z, dist = Math.hypot(dx, dz);
      if (dist <= gib) kill(cop, { x: dx || 1e-3, y: 0, z: dz }, 'gib');
      else if (dist <= knock) kill(cop, { x: dx || 1e-3, y: 0, z: dz }, 'blast');
    }
  });
  window.addEventListener('sc:crush', (e) => {
    const { x0, z0, x1, z1, margin = 0.3 } = e.detail;
    for (const cop of cops) {
      const ox = Math.max(x0 - cop.x, 0, cop.x - x1), oz = Math.max(z0 - cop.z, 0, cop.z - z1);
      if (Math.hypot(ox, oz) <= margin) kill(cop, { x: cop.x - (x0 + x1) / 2 || 1e-3, y: 0, z: cop.z - (z0 + z1) / 2 }, 'collapse');
    }
  });

  // ---------- events from walk mode ----------
  window.addEventListener('sc:shot', (e) => {
    if (!W() || !W().walking || dead) return;
    register();
    if (!respond(e.detail.x, e.detail.z)) maybeSpawn(performance.now());
  });
  window.addEventListener('sc:walk', (e) => {
    buildUi();
    if (e.detail.walking) { register(); hearts = HEARTS; dead = false; diedEl.style.display = 'none'; lastPolice = performance.now(); }
    else if (!dead) clearAll();
    drawHearts();
  });

  // ---------- loop ----------
  let last = 0;
  function frame(t) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, last ? (t - last) / 1000 : 0); last = t;
    const w = W();
    if (!w || !w.walking || dead || !geo) return;
    const pl = w.player;
    if (lastPl && dt > 0) plSpeed = plSpeed * 0.8 + 0.2 * Math.hypot(pl.x - lastPl.x, pl.z - lastPl.z) / dt;
    lastPl = { x: pl.x, z: pl.z };
    try { step(dt, performance.now()); } catch (e) { console.warn('[cops]', e); }
  }
  requestAnimationFrame(frame);
  window.scCops = { get hearts() { return hearts; }, get dead() { return dead; }, officers: () => cops.map((c) => ({ x: c.x, z: c.z, state: c.state, head: !!c.head })),
    cars: () => cars.map((c) => ({ own: !!c.car.own, driving: !!c.driving, x: c.car.x, z: c.car.z, wreck: !!c.car.wreck })), spawnCar: () => spawnCar() };

  // ---------- sounds (synthesised) ----------
  let audio = null;
  function ctx() { audio = audio || new AudioContext(); if (audio.state === 'suspended') audio.resume(); return audio; }
  function ouch() {
    try {
      const a = ctx(), t = a.currentTime, o = a.createOscillator(), g = a.createGain(), f = a.createBiquadFilter();
      o.type = 'sawtooth'; o.frequency.setValueAtTime(220, t); o.frequency.exponentialRampToValueAtTime(130, t + 0.25);
      f.type = 'bandpass'; f.frequency.value = 700; f.Q.value = 3;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.5, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      o.connect(f); f.connect(g); g.connect(out(a)); o.start(t); o.stop(t + 0.32);
    } catch {}
  }
  function whizz() {
    try {
      const a = ctx(), t = a.currentTime, o = a.createOscillator(), g = a.createGain();
      o.type = 'sine'; o.frequency.setValueAtTime(2400, t + 0.05); o.frequency.exponentialRampToValueAtTime(900, t + 0.2);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.06, t + 0.08); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
      o.connect(g); g.connect(out(a)); o.start(t); o.stop(t + 0.22);
    } catch {}
  }
  function sad() {
    try {
      const a = ctx(), t = a.currentTime;
      [392, 370, 349, 262].forEach((fq, i) => {
        const o = a.createOscillator(), g = a.createGain(), s = t + i * 0.45;
        o.type = 'triangle'; o.frequency.value = fq;
        g.gain.setValueAtTime(0.0001, s); g.gain.exponentialRampToValueAtTime(0.25, s + 0.03); g.gain.exponentialRampToValueAtTime(0.0001, s + (i === 3 ? 1.4 : 0.42));
        o.connect(g); g.connect(out(a)); o.start(s); o.stop(s + 1.5);
      });
    } catch {}
  }
})();
