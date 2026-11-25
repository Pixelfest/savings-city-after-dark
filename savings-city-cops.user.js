// ==UserScript==
// @name         Savings City – cops (walk mode)
// @namespace    savings-city-tweaks
// @version      1.0
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
  // ---------------------------------------------

  const rnd = (a, b) => a + Math.random() * (b - a);
  const W = () => window.scWalk;
  let K = null, geo = null, mat = null;
  const cars = [];                 // { car, saved, cops: [], exitAt }
  const cops = [];                 // { x, z, h, state, t, nextShot, mesh, unit }
  let hearts = HEARTS, dead = false;

  // ---------- model ----------
  function model() {
    if (geo) return true;
    const w = W(); if (!w) return false;
    K = w.classes(); if (!K || !K.Color) return false;
    const P = [], N = [], C = [];
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
    box(-0.011, 0.104, -0.011, 0.022, 0.022, 0.022, SKIN);   // head
    box(-0.013, 0.124, -0.013, 0.026, 0.009, 0.026, NAVY);   // cap
    box(-0.012, 0.124, 0.012, 0.024, 0.003, 0.01, BLACK);    // cap's peak
    box(-0.004, 0.128, 0.0125, 0.008, 0.005, 0.002, GOLD);
    box(0.02, 0.082, -0.005, 0.01, 0.01, 0.045, SHIRT);      // arms stretched out to the gun
    box(-0.03, 0.082, -0.005, 0.01, 0.01, 0.045, SHIRT);
    box(-0.012, 0.081, 0.037, 0.028, 0.011, 0.01, SKIN);     // hands
    box(-0.003, 0.088, 0.04, 0.007, 0.01, 0.028, BLACK);     // gun
    geo = new K.Geometry();
    geo.setAttribute('position', new K.Attr(new Float32Array(P), 3));
    geo.setAttribute('normal', new K.Attr(new Float32Array(N), 3));
    geo.setAttribute('color', new K.Attr(new Float32Array(C), 3));
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
    if (dead || !model()) return;
    const busy = cars.filter((c) => c.cops.some((p) => p.state !== 'down' && p.state !== 'gone')).length;
    if (busy >= MAX_CARS) return;
    let best = null, bd = ALERT_RADIUS;
    for (const car of policeCars()) {
      if (cars.some((c) => c.car === car)) continue;
      const d = Math.hypot(car.x - x, car.z - z);
      if (d < bd) { bd = d; best = car; }
    }
    if (!best) return;
    const c = { car: best, saved: { parked: best.parked, speed: best.speed }, cops: [], exitAt: performance.now() + EXIT_DELAY * 1000 };
    best.parked = Infinity; best.speed = 0;
    cars.push(c);
  }
  function getOut(c) {
    const car = c.car, fx = Math.cos(car.heading), fz = Math.sin(car.heading);   // the app turns cars by −heading
    for (let k = 0; k < COPS_PER_CAR; k++) {
      const side = k % 2 ? 1 : -1;
      const cop = { x: car.x - fz * 0.085 * side + fx * rnd(-0.03, 0.03), z: car.z + fx * 0.085 * side + fz * rnd(-0.03, 0.03), h: 0, state: 'exit', t: 0,
        out: [-fz * side, fx * side], nextShot: performance.now() + (FIRST_SHOT_DELAY + rnd(0, 0.8)) * 1000, unit: c };
      cop.mesh = new K.Mesh(geo, mat);
      cop.mesh.castShadow = true; cop.mesh.frustumCulled = false;
      W().scene.add(cop.mesh);
      cops.push(cop); c.cops.push(cop);
    }
    W().sound('thud');
  }
  // send everyone home (walk mode stopped): officers gone, cars drive on
  function clearAll() {
    for (const cop of cops) cop.mesh.removeFromParent();
    cops.length = 0;
    for (const c of cars) if (!c.car.scBurst && !c.car.scFlat && c.car.parked === Infinity && !wrecked(c.car)) { c.car.parked = c.saved.parked; c.car.speed = c.saved.speed; }
    cars.length = 0;
  }
  const wrecked = (car) => car.scWrecked;
  window.addEventListener('sc:car-exploded', (e) => { for (const c of cars) if (Math.hypot(c.car.x - e.detail.x, c.car.z - e.detail.z) < 0.02) c.car.scWrecked = true; });

  // ---------- officers ----------
  const alive = (c) => c.state === 'exit' || c.state === 'fight';
  function step(dt, now) {
    const w = W(), pl = w.player;
    for (const c of cars) if (!c.cops.length && now >= c.exitAt && !c.car.scWrecked) getOut(c);
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
    }
    for (let k = 0; k < (how === 'gib' ? 30 : 14); k++) w.spawn('debris', cop.x, rnd(0.05, 0.1), cop.z, { color: k % 3 ? '#8a0b0b' : '#5e0606', vx: d.x / l * rnd(0, 0.6) + rnd(-0.25, 0.25), vy: rnd(0.1, 0.6), vz: d.z / l * rnd(0, 0.6) + rnd(-0.25, 0.25), g: 3, size: rnd(0.003, 0.006), life: rnd(4, 8), land: true });
    w.startEffects();
    w.sound('hit');
    window.dispatchEvent(new CustomEvent('sc:kill', { detail: { x: cop.x, z: cop.z, cause: how === 'gib' ? 'blast' : how, who: 'cop' } }));
    return true;
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
          if (t > 0 && t < maxT && y >= 0.038 && y <= 0.172 && (!best || t < best.t)) best = { t, cop };
        }
        return best;
      },
      onHit(h, d) { kill(h.cop, d, 'shot'); },
    });
  }
  window.addEventListener('sc:blast', (e) => {
    const { x, z, gib = 0, knock = 0 } = e.detail;
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
  window.addEventListener('sc:shot', (e) => { if (W() && W().walking) { register(); respond(e.detail.x, e.detail.z); } });
  window.addEventListener('sc:walk', (e) => {
    buildUi();
    if (e.detail.walking) { register(); hearts = HEARTS; dead = false; diedEl.style.display = 'none'; }
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
  window.scCops = { get hearts() { return hearts; }, get dead() { return dead; }, officers: () => cops.map((c) => ({ x: c.x, z: c.z, state: c.state })) };

  // ---------- sounds (synthesised) ----------
  let audio = null;
  function ctx() { audio = audio || new AudioContext(); if (audio.state === 'suspended') audio.resume(); return audio; }
  function ouch() {
    try {
      const a = ctx(), t = a.currentTime, o = a.createOscillator(), g = a.createGain(), f = a.createBiquadFilter();
      o.type = 'sawtooth'; o.frequency.setValueAtTime(220, t); o.frequency.exponentialRampToValueAtTime(130, t + 0.25);
      f.type = 'bandpass'; f.frequency.value = 700; f.Q.value = 3;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.5, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      o.connect(f); f.connect(g); g.connect(a.destination); o.start(t); o.stop(t + 0.32);
    } catch {}
  }
  function whizz() {
    try {
      const a = ctx(), t = a.currentTime, o = a.createOscillator(), g = a.createGain();
      o.type = 'sine'; o.frequency.setValueAtTime(2400, t + 0.05); o.frequency.exponentialRampToValueAtTime(900, t + 0.2);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.06, t + 0.08); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
      o.connect(g); g.connect(a.destination); o.start(t); o.stop(t + 0.22);
    } catch {}
  }
  function sad() {
    try {
      const a = ctx(), t = a.currentTime;
      [392, 370, 349, 262].forEach((fq, i) => {
        const o = a.createOscillator(), g = a.createGain(), s = t + i * 0.45;
        o.type = 'triangle'; o.frequency.value = fq;
        g.gain.setValueAtTime(0.0001, s); g.gain.exponentialRampToValueAtTime(0.25, s + 0.03); g.gain.exponentialRampToValueAtTime(0.0001, s + (i === 3 ? 1.4 : 0.42));
        o.connect(g); g.connect(a.destination); o.start(s); o.stop(s + 1.5);
      });
    } catch {}
  }
})();
