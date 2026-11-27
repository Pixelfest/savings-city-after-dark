// ==UserScript==
// @name         Savings City – flamethrower (walk mode)
// @namespace    savings-city-tweaks
// @version      1.3
// @description  Adds a flamethrower to walk mode (key 4, hold the mouse button): a roaring stream of fire that sets residents alight – they run screaming, fall and writhe, get up and run on, and set others on fire.
// @match        https://your-savings-city-host.example/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * Needs walk mode (1.31 or newer for burning cars; 1.30: weapons with `auto` keep firing while the button is held), the
 * core (classes, frame loop, sound output, smoke) and residents (1.19 or newer: ignite).
 *
 * - The stream: blobs of fire (one InstancedMesh of unlit low-poly balls, a ring buffer in typed
 *   arrays) shot from the nozzle, slowing down, rising a little, growing and going from yellow via
 *   orange and red to soot as they age. Where the stream meets a wall or the ground the blobs stop
 *   and spread out. Black smoke rises from the end of the stream (the core's solid puffs).
 * - Every shot (20 a second while held) checks the residents in a cone along the stream, up to the
 *   wall or ground it hits: whoever is in it catches fire (residents' ignite: run, writhe, get up,
 *   the fire goes out after a while; touching others sets them alight too). Cars in the stream heat
 *   up; after CAR_HEAT seconds of flame they catch fire (walk mode 1.31: igniteCar) and explode a few
 *   seconds later. Police officers (cops 1.6) in the stream catch fire too.
 * - Sound: a roar of filtered noise while the button is held, through the core's output (follows
 *   the app's sound button).
 */
(function () {
  'use strict';

  // ---- settings (tiles; 1 tile ≈ 20 m) ----
  const KEY = 'Digit4';            // select with 4 (or Q / the scroll wheel)
  const INTERVAL = 0.05;           // seconds between shots of fire while the button is held
  const RANGE = 1.3;               // tiles (≈ 26 m): how far the stream reaches
  const SPEED = 5;                 // tiles per second out of the nozzle…
  const DRAG = 2.6;                // …slowing down this fast
  const LIFE = [0.55, 0.8];        // seconds a blob of fire lasts
  const BLOBS_PER_SHOT = 3;
  const SPREAD = 0.06;             // how wide the stream fans out (radians, roughly)
  const CONE = [0.03, 0.12];       // radius of the cone that sets people alight: at the nozzle, at full range
  const IGNITE_CHANCE = 0.6;       // per shot, for someone in the cone
  const CAR_HEAT = 0.5;            // seconds of flame on a car before it catches fire (it explodes a few seconds later)
  const MAX_BLOBS = 600;
  const SMOKE = true;              // black smoke from the end of the stream
  const VOLUME = 0.5;
  // --------------------------------------------

  const rnd = (a, b) => a + Math.random() * (b - a);
  const W = () => window.scWalk;
  const C = () => window.scCore;
  const COLORS = [[0, '#fff6c0'], [0.2, '#ffd24a'], [0.45, '#ff8a1e'], [0.7, '#e8451c'], [0.88, '#5a3a2c'], [1, '#2a2624']];

  // ---------- the weapon ----------
  const def = {
    id: 'flamethrower', name: 'Vlammenwerper', key: KEY, interval: INTERVAL, auto: true, kick: 0.12,
    at: [0.14, -0.11, -0.2], aim: 1.15, roll: -0.04, muzzle: [0, 0, -0.42],
    build({ builder, mesh, makeFlash, colors }) {
      const { DARK, GRIP, SKIN, SLEEVE, METAL } = colors;
      const RED = '#a5281f', RED2 = '#7e1d17', BRASS = '#c9a227';
      const b = builder();
      b.prism(0, 0, -0.16, 0.022, 0.5, 8, METAL);                 // the lance
      b.prism(0, 0, -0.41, 0.03, 0.035, 8, DARK);                 // nozzle
      b.prism(0, -0.012, -0.43, 0.008, 0.02, 6, BRASS);           // pilot light
      b.prism(0, -0.075, 0.02, 0.05, 0.22, 10, RED);              // the tank under it
      b.prism(0, -0.075, -0.1, 0.053, 0.02, 10, RED2);
      b.prism(0, -0.075, 0.13, 0.053, 0.02, 10, RED2);
      b.box(0, -0.035, -0.07, 0.012, 0.04, 0.012, DARK);          // hose to the lance
      b.box(0, -0.06, 0.06, 0.024, 0.065, 0.03, GRIP, -0.25);     // rear grip
      b.box(0.002, -0.07, 0.065, 0.044, 0.055, 0.05, SKIN, -0.25);// hand
      b.box(0.006, -0.12, 0.14, 0.06, 0.065, 0.16, SLEEVE, 0.45); // sleeve
      b.box(0, -0.035, -0.25, 0.022, 0.05, 0.028, GRIP, -0.1);    // front grip with the other hand
      b.box(-0.004, -0.045, -0.245, 0.044, 0.05, 0.05, SKIN, -0.1);
      b.box(-0.02, -0.11, -0.18, 0.06, 0.06, 0.16, SLEEVE, 0.6);
      return { root: mesh(b), flash: makeFlash(1.3) };
    },
    fire({ o, d, start }) { shoot(o, d, start); },
  };
  (window.scWalkWeapons = window.scWalkWeapons || []).push(def);

  // ---------- the stream ----------
  // per blob, at i × ST: position, velocity, age, life, stop distance left, stuck, size
  const ST = 10;
  let K = null, blobs = null, data = null, next = 0, used = 0, cols = null;
  function setup() {
    if (blobs) return true;
    const c = C(); K = c && c.classes();
    if (!K || !K.Instanced || !c.scene) return false;
    const t = (1 + Math.sqrt(5)) / 2, V = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]]
      .map((v) => { const l = Math.hypot(...v) * 2; return v.map((x) => x / l); });
    const F = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
    const P = [], N = [];
    for (const f of F) for (const k of f) { P.push(...V[k]); N.push(V[k][0] * 2, V[k][1] * 2, V[k][2] * 2); }
    const g = new K.Geometry();
    g.setAttribute('position', new K.Attr(new Float32Array(P), 3));
    g.setAttribute('normal', new K.Attr(new Float32Array(N), 3));
    const mat = K.Basic ? new K.Basic({ color: '#ffffff' }) : new K.Lambert({ color: '#ffffff', emissive: '#ff8a1e' });
    blobs = new K.Instanced(g, mat, MAX_BLOBS);
    blobs.frustumCulled = false; blobs.count = 0; blobs.name = 'sc-flamethrower'; blobs.userData.scPuff = true;
    blobs.setColorAt(0, new K.Color('#ffffff'));
    data = new Float32Array(MAX_BLOBS * ST);
    cols = COLORS.map(([f, hex]) => { const k = new K.Color(hex); return [f, k.r, k.g, k.b]; });
    c.scene.add(blobs);
    c.onFrame(step);
    return true;
  }

  function shoot(o, d, start) {
    if (!setup()) return;
    const w = W();
    // where the stream ends: a wall, or the ground
    let reach = RANGE;
    const wall = w && w.rayBuildings ? w.rayBuildings(start, d, RANGE) : null;
    if (wall) reach = Math.min(reach, wall.t);
    if (d.y < -0.01) reach = Math.min(reach, (start.y - 0.04) / -d.y + 0.15);
    for (let k = 0; k < BLOBS_PER_SHOT; k++) {
      const i = next; next = (next + 1) % MAX_BLOBS; used = Math.max(used, Math.min(MAX_BLOBS, i + 1));
      const b = i * ST, sp = SPEED * rnd(0.85, 1.1);
      const dx = d.x + rnd(-SPREAD, SPREAD), dy = d.y + rnd(-SPREAD, SPREAD) * 0.6, dz = d.z + rnd(-SPREAD, SPREAD);
      const back = rnd(0, SPEED * INTERVAL);                          // spread over the interval, so the stream is continuous
      data[b] = start.x + dx * back; data[b + 1] = start.y + dy * back; data[b + 2] = start.z + dz * back;
      data[b + 3] = dx * sp; data[b + 4] = dy * sp; data[b + 5] = dz * sp;
      data[b + 6] = 0; data[b + 7] = rnd(...LIFE); data[b + 8] = reach - back; data[b + 9] = 0;
    }
    roar();
    igniteCone(start, d, reach);
    heatCars(start, d, reach);
    if (SMOKE && Math.random() < 0.35) {
      const c = C(), t = Math.min(reach, RANGE * 0.9);
      if (c && c.smoke) c.smoke('blacksmoke', start.x + d.x * t, Math.max(0.08, start.y + d.y * t), start.z + d.z * t,
        { vx: rnd(-0.1, 0.1), vy: rnd(0.3, 0.5), vz: rnd(-0.1, 0.1), rise: rnd(0.3, 0.45), size: rnd(0.04, 0.07), grow: 4, life: rnd(2, 3.5), alpha: 0.6 });
    }
  }
  function step(dt) {
    if (!used || !dt) return;
    const m = blobs.instanceMatrix.array, col = blobs.instanceColor.array, k = 1 / (1 + DRAG * dt);
    let live = 0, hi = 0;
    for (let i = 0; i < used; i++) {
      const b = i * ST, e = i * 16;
      if (!(data[b + 6] < data[b + 7])) { if (m[e + 15] !== 0) for (let q = 0; q < 16; q++) m[e + q] = 0; continue; }
      live++; hi = i + 1;
      const age = (data[b + 6] += dt), f = Math.min(1, age / data[b + 7]);
      let vx = data[b + 3] * k, vy = data[b + 4] * k + 0.6 * dt, vz = data[b + 5] * k;
      const len = Math.hypot(vx, vy, vz) * dt;
      if (data[b + 9]) { vx *= 0.9; vz *= 0.9; vy = Math.max(vy, 0) * 0.5; }   // against a wall / on the ground: spreads, licks upward
      else if ((data[b + 8] -= len) <= 0) { data[b + 9] = 1; vx *= 0.15; vz *= 0.15; vy = 0.15; }   // the stream's end
      let y = data[b + 1] + vy * dt;
      if (y < 0.045) { y = 0.045; vy = 0; }
      data[b] += vx * dt; data[b + 1] = y; data[b + 2] += vz * dt;
      data[b + 3] = vx; data[b + 4] = vy; data[b + 5] = vz;
      // grows, flickers, shrinks away at the end
      const s = (0.012 + 0.1 * Math.pow(f, 0.7)) * (f > 0.8 ? (1 - f) * 5 : 1) * rnd(0.85, 1.15) * (data[b + 9] ? 1.25 : 1);
      m[e] = s; m[e + 1] = 0; m[e + 2] = 0; m[e + 3] = 0; m[e + 4] = 0; m[e + 5] = s; m[e + 6] = 0; m[e + 7] = 0;
      m[e + 8] = 0; m[e + 9] = 0; m[e + 10] = s; m[e + 11] = 0; m[e + 12] = data[b]; m[e + 13] = y; m[e + 14] = data[b + 2]; m[e + 15] = 1;
      // colour by age: white-yellow → orange → red → soot
      let j = 1; while (j < cols.length - 1 && cols[j][0] < f) j++;
      const a = cols[j - 1], c = cols[j], t = (f - a[0]) / ((c[0] - a[0]) || 1);
      col[i * 3] = a[1] + (c[1] - a[1]) * t; col[i * 3 + 1] = a[2] + (c[2] - a[2]) * t; col[i * 3 + 2] = a[3] + (c[3] - a[3]) * t;
    }
    if (!live) { used = 0; next = 0; }
    blobs.count = live ? hi : 0;
    for (const [at, n] of [[blobs.instanceMatrix, hi * 16], [blobs.instanceColor, hi * 3]]) { if (!n) continue; if (at.addUpdateRange) at.addUpdateRange(0, n); at.needsUpdate = true; }
  }

  // ---------- setting people alight ----------
  function igniteCone(s, d, reach) {
    const res = window.scResidents;
    const people = res && res.ignite && res.people ? res.people : [];
    for (let i = 0; i < people.length; i++) {
      const p = people[i];
      if (p.burn || p.state === 'inside' || p.state === 'gone') continue;
      const vx = p.x - s.x, vy = 0.1 - s.y, vz = p.z - s.z;       // (the middle of a person, roughly)
      const t = vx * d.x + vy * d.y + vz * d.z;
      if (t < 0 || t > reach + 0.05) continue;
      const r = CONE[0] + (CONE[1] - CONE[0]) * Math.min(1, t / RANGE);
      const px = vx - d.x * t, pz = vz - d.z * t;
      if (px * px + pz * pz > r * r) continue;
      const py = vy - d.y * t;
      if (Math.abs(py) > 0.09 + r) continue;                      // over their heads / below
      if (Math.random() < IGNITE_CHANCE) res.ignite(p, s.x, s.z);
    }
    // police officers (cops script) in the stream
    const cops = window.scCops;
    if (cops && cops.ignite && cops.officers) cops.officers().forEach((o, i) => {
      if (o.burning || o.state === 'gone') return;
      const vx = o.x - s.x, vy = 0.1 - s.y, vz = o.z - s.z, t = vx * d.x + vy * d.y + vz * d.z;
      if (t < 0 || t > reach + 0.05) return;
      const r = CONE[0] + (CONE[1] - CONE[0]) * Math.min(1, t / RANGE), px = vx - d.x * t, pz = vz - d.z * t;
      if (px * px + pz * pz <= r * r && Math.abs(vy - d.y * t) <= 0.09 + r && Math.random() < IGNITE_CHANCE) cops.ignite(i, s.x, s.z);
    });
  }

  // Cars in the stream (traffic and parked ones) heat up; after CAR_HEAT seconds of flame they
  // catch fire (walk mode: igniteCar – they stop, the driver runs off burning, then the car explodes).
  const heat = new WeakMap();
  function heatCars(s, d, reach) {
    const w = W(); if (!w || !w.igniteCar) return;
    const cars = (w.trafficCars() || []).concat(w.parkedCars ? w.parkedCars() : []);
    for (const car of cars) {
      if (w.carBurning && w.carBurning(car)) continue;
      const vx = car.x - s.x, vy = 0.07 - s.y, vz = car.z - s.z;
      const t = vx * d.x + vy * d.y + vz * d.z;
      if (t < 0 || t > reach + 0.12) continue;
      const r = CONE[0] + (CONE[1] - CONE[0]) * Math.min(1, t / RANGE) + 0.08;   // + about half a car
      const px = vx - d.x * t, py = vy - d.y * t, pz = vz - d.z * t;
      if (px * px + pz * pz > r * r || Math.abs(py) > 0.07 + r) continue;
      const h = (heat.get(car) || 0) + INTERVAL;
      heat.set(car, h);
      if (h >= CAR_HEAT) w.igniteCar(car);
    }
  }

  // ---------- the roar ----------
  let snd = null, stopTimer = 0;
  function roar() {
    const c = C(); if (!c || !c.audio) return;
    try {
      if (!snd) {
        const a = c.audio(), buf = a.createBuffer(1, a.sampleRate * 2, a.sampleRate), ch = buf.getChannelData(0);
        let last = 0;
        for (let i = 0; i < ch.length; i++) { last = last * 0.92 + (Math.random() * 2 - 1) * 0.08; ch[i] = last * 6 + (Math.random() * 2 - 1) * 0.15; }   // rumbling noise
        const src = a.createBufferSource(); src.buffer = buf; src.loop = true;
        const lp = a.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900;
        const bp = a.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2200; bp.Q.value = 0.7;
        const bg = a.createGain(); bg.gain.value = 0.35;
        const gain = a.createGain(); gain.gain.value = 0.0001;
        src.connect(lp); lp.connect(gain); src.connect(bp); bp.connect(bg); bg.connect(gain); gain.connect(c.out(a));
        src.start();
        snd = { a, gain };
      }
      snd.gain.gain.setTargetAtTime(VOLUME, snd.a.currentTime, 0.04);
      clearTimeout(stopTimer);
      stopTimer = setTimeout(() => { if (snd) snd.gain.gain.setTargetAtTime(0.0001, snd.a.currentTime, 0.08); }, INTERVAL * 1000 * 2.5);
    } catch (e) { /* no sound */ }
  }
})();
