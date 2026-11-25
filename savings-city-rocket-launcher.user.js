// ==UserScript==
// @name         Savings City – rocket launcher (walk mode)
// @namespace    savings-city-tweaks
// @version      1.4
// @description  Adds a rocket launcher to walk mode (key 3). Residents and cars are blown apart, walls get holes blown in them.
// @match        https://your-savings-city-host.example/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * Needs the walk-mode script (1.18 or newer): this script hands it a weapon (model, key, firing)
 * through window.scWalkWeapons, and uses window.scWalk for hit tests and effects.
 * Residents are blown apart by the residents script (1.9 or newer, window.scResidents.gibAround).
 *
 * The rocket flies visibly (a flame out of its back) until it hits a wall, a car, a resident, a tree or
 * lamp, or the ground. The explosion:
 *  - residents close by are blown apart (legs, torso, head fly off); a bit further they fall over,
 *    further still they run;
 *  - cars close by burst into their parts (body, cabin, roof, lights, wheels), burnt;
 *  - trees and lamps close by fall over;
 *  - a building that is hit is turned into solid chunks (as in the nuke and monster scripts: the
 *    facade with its windows outside, broken concrete inside); the chunks around the impact are
 *    blown out, leaving a ragged crater. After HITS_TO_COLLAPSE hits the building comes straight
 *    down, a jagged stump stays. Cutting the building starts when you fire, while the rocket flies.
 *  - the collapse starts where the last rocket hit: the floor there gives way first, the part above
 *    drops and tips towards the hole, the failure spreads outwards and the floors below the impact
 *    pancake one after the other. Dust rolls out over the ground as the debris lands; everyone
 *    inside and on the street right next to it dies (residents script 1.10: crush).
 */
(function () {
  'use strict';

  // ---- settings (tiles; 1 tile ≈ 20 m) ----
  const KEY = 'Digit3';            // select with 3 (or Q to cycle)
  const RELOAD = 1.2;              // seconds between rockets
  const ROCKET_SPEED = 6;          // tiles per second
  const RANGE = 30;
  const GIB_RADIUS = 0.22;         // residents this close are blown apart
  const CAR_RADIUS = 0.35;         // cars this close burst into parts
  const PROP_RADIUS = 0.45;        // trees and lamps this close fall over
  const HOLE_RADIUS = 0.16;        // chunks within this distance of the impact are blown out
  const CHUNK_SIZE = 0.2;          // a hit building is cut into chunks about this big (smaller = finer holes, but much heavier)
  const HITS_TO_COLLAPSE = 7;      // on this hit the building comes down
  const STUMP = 0.12;              // a jagged stump up to this high stays
  const PART_SPEED = 2.2;          // how hard car parts fly
  const COLLAPSE_SPREAD = 2.5;     // tiles per second: how fast the failure spreads from the last impact
  const COLLAPSE_LEAN = 0.6;       // how hard the part above the impact tips over towards the hole
  const DUST = 1;                  // amount of dust when a building comes down (0 = only the old puffs)
  // --------------------------------------------

  const rnd = (a, b) => a + Math.random() * (b - a);
  const W = () => window.scWalk;
  const JF = [0.04, 0.96];          // the facade texture's plain spot
  let K = null;                     // three.js classes (from walk mode)

  // ---------- the weapon ----------
  const def = {
    id: 'rocket', name: 'Raketwerper', key: KEY, interval: RELOAD, kick: 2.2,
    at: [0.15, -0.105, -0.16], aim: 1.2, roll: -0.03, muzzle: [0, 0, -0.44],
    build({ builder, mesh, makeFlash, colors }) {
      const OLIVE = '#56613f', OLIVE2 = '#46502f', { DARK, GRIP, SKIN, SLEEVE } = colors;
      const b = builder();
      b.prism(0, 0, -0.1, 0.042, 0.62, 10, OLIVE);                // tube
      b.prism(0, 0, -0.405, 0.048, 0.03, 10, DARK);               // muzzle ring
      b.prism(0, 0, 0.2, 0.052, 0.06, 10, DARK);                  // rear flare
      b.prism(0, 0, -0.05, 0.046, 0.025, 10, OLIVE2);             // bands
      b.prism(0, 0, -0.25, 0.046, 0.025, 10, OLIVE2);
      b.prism(0, 0, -0.41, 0.026, 0.04, 8, '#6f7d4c');            // the next rocket's warhead in the muzzle
      b.prism(0, 0, -0.435, 0.015, 0.02, 8, '#3a3f2a');
      b.box(-0.045, 0.035, -0.17, 0.014, 0.035, 0.05, DARK);      // sight
      b.box(-0.045, 0.058, -0.17, 0.02, 0.012, 0.012, '#c9a227');
      b.box(0, -0.072, -0.03, 0.026, 0.07, 0.032, GRIP, -0.25);   // rear grip + trigger
      b.box(0, -0.058, -0.075, 0.006, 0.02, 0.008, '#4a4e55');
      b.box(0.002, -0.08, -0.025, 0.044, 0.06, 0.05, SKIN, -0.25);// hand
      b.box(0.006, -0.13, 0.05, 0.06, 0.065, 0.16, SLEEVE, 0.45); // sleeve
      b.box(0, -0.065, -0.24, 0.024, 0.055, 0.03, GRIP, -0.1);    // front grip with the other hand
      b.box(-0.004, -0.07, -0.235, 0.044, 0.05, 0.05, SKIN, -0.1);
      b.box(-0.02, -0.13, -0.17, 0.06, 0.06, 0.16, SLEEVE, 0.6);
      return { root: mesh(b), flash: makeFlash(2.2) };
    },
    fire({ start, d }) { launch(start, d); },
  };
  (window.scWalkWeapons = window.scWalkWeapons || []).push(def);

  // ---------- rockets ----------
  const rockets = [];
  let rocketGeo = null, rocketMat = null, finMat = null, loopOn = false, last = 0;
  function classes() { if (!K) K = W() && W().classes(); return K; }
  function rocketModel() {
    if (!rocketGeo) {
      const P = [], N = [];
      const box = (x, y, z, w, h, d) => {
        const a = w / 2, b = h / 2, c = d / 2;
        const quad = (p, q, r, s, n) => { for (const v of [p, q, r, p, r, s]) { P.push(v[0] + x, v[1] + y, v[2] + z); N.push(...n); } };
        quad([-a, -b, c], [a, -b, c], [a, b, c], [-a, b, c], [0, 0, 1]); quad([a, -b, -c], [-a, -b, -c], [-a, b, -c], [a, b, -c], [0, 0, -1]);
        quad([a, -b, c], [a, -b, -c], [a, b, -c], [a, b, c], [1, 0, 0]); quad([-a, -b, -c], [-a, -b, c], [-a, b, c], [-a, b, -c], [-1, 0, 0]);
        quad([-a, b, c], [a, b, c], [a, b, -c], [-a, b, -c], [0, 1, 0]); quad([-a, -b, -c], [a, -b, -c], [a, -b, c], [-a, -b, c], [0, -1, 0]);
      };
      box(0, 0, 0, 0.014, 0.014, 0.06); box(0, 0, 0.036, 0.009, 0.009, 0.014); box(0, 0, -0.026, 0.03, 0.003, 0.012); box(0, 0, -0.026, 0.003, 0.03, 0.012);
      rocketGeo = new K.Geometry();
      rocketGeo.setAttribute('position', new K.Attr(new Float32Array(P), 3));
      rocketGeo.setAttribute('normal', new K.Attr(new Float32Array(N), 3));
      rocketMat = new K.Basic({ color: '#5d6a44' });
    }
    const m = new K.Mesh(rocketGeo, rocketMat);
    // flame behind the tail: a bright yellow core in an orange tongue, pointing backwards (-z)
    if (!flameGeo) {
      const P = [], N = [];
      const spike = (len, r) => {                                  // a pointed 6-sided cone from z = 0 back to z = -len
        for (let i = 0; i < 6; i++) {
          const a0 = (i / 6) * Math.PI * 2, a1 = ((i + 1) / 6) * Math.PI * 2;
          const p0 = [Math.cos(a0) * r, Math.sin(a0) * r, 0], p1 = [Math.cos(a1) * r, Math.sin(a1) * r, 0], tip = [0, 0, -len];
          for (const v of [p0, tip, p1]) { P.push(...v); N.push(0, 0, -1); }
          for (const v of [p0, p1, [0, 0, 0]]) { P.push(...v); N.push(0, 0, 1); }
        }
        const g = new K.Geometry();
        g.setAttribute('position', new K.Attr(new Float32Array(P.splice(0)), 3));
        g.setAttribute('normal', new K.Attr(new Float32Array(N.splice(0)), 3));
        return g;
      };
      flameGeo = [spike(0.07, 0.009), spike(0.04, 0.005)];
      flameMat = [new K.Basic({ color: '#ff7a14', side: 2, transparent: true, opacity: 0.9, blending: 2, depthWrite: false }), new K.Basic({ color: '#fff3a0', side: 2, transparent: true, blending: 2, depthWrite: false })];   // glowing (added light)
    }
    const flame = new K.Mesh(flameGeo[0], flameMat[0]), core = new K.Mesh(flameGeo[1], flameMat[1]);
    flame.position.z = -0.032; core.position.z = 0.002;
    flame.add(core); m.add(flame);
    m.userData.flame = flame;
    return m;
  }
  let flameGeo = null, flameMat = null;
  function launch(start, d) {
    if (!classes()) return;
    const w = W();
    w.sound('rocket');
    const m = rocketModel();
    m.position.set(start.x, start.y, start.z);
    m.lookAt(start.x + d.x, start.y + d.y, start.z + d.z);        // +z (the nose) forward
    m.frustumCulled = false;
    w.scene.add(m);
    rockets.push({ m, flame: m.userData.flame, p: { ...start }, d, travelled: 0, smoke: 0, speed: ROCKET_SPEED * 0.6 });
    // the building it is going to hit: start cutting it into chunks now, while the rocket flies
    try { const h = w.rayBuildings(start, d, RANGE); if (h) prepare(buildingAt({ x: start.x + d.x * h.t, y: start.y + d.y * h.t, z: start.z + d.z * h.t })); } catch (e) { console.warn('[rockets] prepare', e); }
    for (let k = 0; k < 5; k++) w.spawn('fire', start.x - d.x * 0.1, start.y, start.z - d.z * 0.1, { vx: -d.x * rnd(0.3, 0.8), vy: rnd(0, 0.1), vz: -d.z * rnd(0.3, 0.8), size: rnd(0.01, 0.018), life: rnd(0.06, 0.12) });   // a short flash out of the back
    w.startEffects();
    if (!loopOn) { loopOn = true; last = 0; requestAnimationFrame(loop); }
  }
  function loop(t) {
    const dt = Math.min(0.05, last ? (t - last) / 1000 : 0); last = t;
    const w = W();
    for (let k = rockets.length - 1; k >= 0; k--) {
      const r = rockets[k];
      r.speed = Math.min(ROCKET_SPEED, r.speed + ROCKET_SPEED * 3 * dt);   // the motor kicks in
      const len = r.speed * dt;
      if (len > 0) {
        const hit = firstHit(r.p, r.d, len);
        if (hit) { r.m.removeFromParent(); rockets.splice(k, 1); explode(hit); continue; }
      }
      r.p.x += r.d.x * len; r.p.y += r.d.y * len; r.p.z += r.d.z * len; r.travelled += len;
      r.m.position.set(r.p.x, r.p.y, r.p.z);
      // the flame out of its back flickers; now and then a spark is left behind (no smoke)
      const fl = 0.75 + Math.random() * 0.5;
      r.flame.scale.set(fl, fl, 0.7 + Math.random() * 0.8);
      r.smoke -= dt;
      while (r.smoke <= 0) {
        r.smoke += 0.03;
        w.spawn('fire', r.p.x - r.d.x * 0.06, r.p.y - r.d.y * 0.06, r.p.z - r.d.z * 0.06, { vx: rnd(-0.05, 0.05), vy: rnd(-0.05, 0.05), vz: rnd(-0.05, 0.05), size: rnd(0.006, 0.011), life: rnd(0.05, 0.12) });
      }
      w.startEffects();
      if (r.travelled > RANGE) { r.m.removeFromParent(); rockets.splice(k, 1); }
    }
    if (rockets.length) requestAnimationFrame(loop); else loopOn = false;
  }

  // what the rocket meets first on this stretch
  function firstHit(o, d, len) {
    const w = W();
    let best = null;
    const take = (t, kind, extra) => { if (t !== null && t !== undefined && t >= 0 && t <= len && (!best || t < best.t)) best = { t, kind, ...extra }; };
    const wall = w.rayBuildings(o, d, len); if (wall) take(wall.t, 'wall', { n: wall.n });
    if (d.y < 0) { const g = (o.y - 0.04) / -d.y; take(g, 'ground', { n: { x: 0, y: 1, z: 0 } }); }
    const car = w.hitCar(o, d, best ? best.t : len); if (car) take(car.t, 'car', { car: car.car });
    const res = window.scResidents; if (res && res.hit) { const h = res.hit(o, d, best ? best.t : len); if (h) take(h.t, 'person', {}); }
    const pr = w.hitProp(o, d, best ? best.t : len); if (pr) take(pr.t, 'prop', { prop: pr.prop });
    if (w.hitTargets) { const tg = w.hitTargets(o, d, best ? best.t : len); if (tg) take(tg.t, 'person', {}); }
    if (!best) return null;
    best.at = { x: o.x + d.x * best.t, y: o.y + d.y * best.t, z: o.z + d.z * best.t };
    best.d = d;
    return best;
  }

  // ---------- the explosion ----------
  function explode(hit) {
    const w = W(), { x, y, z } = hit.at;
    w.sound('boom');
    // pull the blast a little back out of what it hit
    const bx = x - hit.d.x * 0.03, by = Math.max(0.05, y - hit.d.y * 0.03), bz = z - hit.d.z * 0.03;
    w.spawn('flash', bx, by, bz, { size: 0.22, life: 0.18, grow: 2 });
    for (let k = 0; k < 28; k++) {
      const a = Math.random() * Math.PI * 2, up = Math.random(), sp = rnd(0.4, 1.1);
      w.spawn('fire', bx, by, bz, { vx: Math.cos(a) * sp * (1 - up * 0.5), vy: 0.3 + up * 1.2, vz: Math.sin(a) * sp * (1 - up * 0.5), g: 1.6, size: rnd(0.02, 0.045), life: rnd(0.3, 0.7) });
    }
    for (let k = 0; k < 4; k++) w.spawn('smoke', bx + rnd(-0.08, 0.08), by + 0.04, bz + rnd(-0.08, 0.08), { vy: rnd(0.12, 0.3), vx: rnd(-0.06, 0.06), vz: rnd(-0.06, 0.06), size: 0.05, grow: 3, life: rnd(2.5, 4) });
    for (let k = 0; k < 10; k++) { const a = Math.random() * Math.PI * 2, sp = rnd(0.4, 1); w.spawn('debris', bx, by, bz, { vx: Math.cos(a) * sp, vy: rnd(0.5, 1.3), vz: Math.sin(a) * sp, g: 3, size: rnd(0.008, 0.016), life: rnd(2, 3), land: true, spin: true }); }
    w.startEffects();
    // people
    const res = window.scResidents;
    if (res && res.gibAround) res.gibAround(bx, bz, GIB_RADIUS, 1.3);
    w.blastResidents(bx, bz, GIB_RADIUS);
    // trees and lamps
    for (const p of w.propsNear(bx, bz, PROP_RADIUS)) { const dx = p.x - bx, dz = p.z - bz, l = Math.hypot(dx, dz) || 1; w.knockProp(p, { x: dx / l, y: 0, z: dz / l }); }
    // cars
    try { burstCars(bx, by, bz, hit.kind === 'car' ? hit.car : null); } catch (e) { console.warn('[rockets] cars', e); }
    // a building: a crater of blown-out chunks, and after enough hits it comes down
    if (hit.kind === 'wall') {
      try { const bd = buildingAt(hit.at); if (bd) hitBuilding(bd, hit.at, hit.n); } catch (e) { console.warn('[rockets] building', e); }
    }
  }

  // ---------- cars burst into their parts ----------
  const parts = [];
  let partsOn = false, partsLast = 0;
  function burstCars(x, y, z, direct) {
    const w = W(), list = w.trafficCars(); if (!list) return;
    const proxies = w.carObjects();
    let batches = null;
    list.forEach((car, i) => {
      if (car.scBurst) return;
      const d = Math.hypot(car.x - x, car.z - z);
      if (car !== direct && d > CAR_RADIUS) return;
      const proxy = proxies.get(i); if (!proxy) return;
      if (!batches) { batches = []; w.scene.traverse((o) => { if (o.isInstancedMesh && Array.isArray(o.userData.cars)) batches.push(o); }); }
      const batch = batches.find((b) => b.userData.cars.includes(i)); if (!batch) return;
      car.scBurst = true;
      proxy.updateWorldMatrix(true, false);
      splitCar(batch.geometry, batch.material, proxy.matrixWorld, x, y, z, 1 - Math.min(1, d / CAR_RADIUS));
      proxy.scale.setScalar(0.0001);                               // the car itself: gone
      w.wreck(car);
      for (let k = 0; k < 16; k++) w.spawn('fire', car.x, 0.08, car.z, { vx: rnd(-0.4, 0.4), vy: rnd(0.4, 1.2), vz: rnd(-0.4, 0.4), g: 1.6, size: rnd(0.02, 0.04), life: rnd(0.4, 0.8) });
      if (w.blackSmoke) for (let k = 0; k < 16; k++) w.blackSmoke(car.x + rnd(-0.1, 0.1), rnd(0.08, 0.3), car.z + rnd(-0.1, 0.1), { vx: rnd(-0.3, 0.3), vy: rnd(0.5, 1.2), vz: rnd(-0.3, 0.3), rise: rnd(0.3, 0.6), size: rnd(0.07, 0.13), life: rnd(4, 8) });
    });
    if (parts.length && !partsOn) { partsOn = true; partsLast = 0; requestAnimationFrame(stepParts); }
  }
  // split the car model into its parts by colour and place (wheels and lights each on their own)
  function splitCar(geo, material, mw, x, y, z, near) {
    const pos = geo.attributes.position, nor = geo.attributes.normal, col = geo.attributes.color;
    if (!pos || !col) return;
    const groups = new Map(), e = mw.elements;
    for (let i = 0; i + 2 < pos.count; i += 3) {
      const cx = (pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3, cy = (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3, cz = (pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2)) / 3;
      const r = col.getX(i), g = col.getY(i), b = col.getZ(i), dark = r + g + b < 0.12;
      const key = [Math.round(r * 40), Math.round(g * 40), Math.round(b * 40)].join() + (cy > 0.1 ? 'top' : '') + (dark && cy < 0.045 ? ':' + Math.sign(cx) + Math.sign(cz) : '') + (r > 0.8 && g > 0.8 && b < 0.6 ? ':' + Math.sign(cz) : '');
      (groups.get(key) || groups.set(key, []).get(key)).push(i);
    }
    for (const tris of groups.values()) {
      // world positions, centred on the part
      const P = [], N = [], C = [];
      let mx = 0, my = 0, mz = 0;
      for (const i of tris) for (let v = i; v < i + 3; v++) {
        const lx = pos.getX(v), ly = pos.getY(v), lz = pos.getZ(v);
        const wx = e[0] * lx + e[4] * ly + e[8] * lz + e[12], wy = e[1] * lx + e[5] * ly + e[9] * lz + e[13], wz = e[2] * lx + e[6] * ly + e[10] * lz + e[14];
        P.push(wx, wy, wz); mx += wx; my += wy; mz += wz;
        const nx = nor ? nor.getX(v) : 0, ny = nor ? nor.getY(v) : 1, nz = nor ? nor.getZ(v) : 0;
        N.push(e[0] * nx + e[4] * ny + e[8] * nz, e[1] * nx + e[5] * ny + e[9] * nz, e[2] * nx + e[6] * ny + e[10] * nz);
        const burnt = 0.3 + Math.random() * 0.1;                  // burnt and sooty
        C.push(col.getX(v) * burnt, col.getY(v) * burnt, col.getZ(v) * burnt);
      }
      const n = P.length / 3; mx /= n; my /= n; mz /= n;
      let hx = 0, hy = 0, hz = 0;
      for (let k = 0; k < n; k++) { P[k * 3] -= mx; P[k * 3 + 1] -= my; P[k * 3 + 2] -= mz; hx = Math.max(hx, Math.abs(P[k * 3])); hy = Math.max(hy, Math.abs(P[k * 3 + 1])); hz = Math.max(hz, Math.abs(P[k * 3 + 2])); }
      const g = new K.Geometry();
      g.setAttribute('position', new K.Attr(new Float32Array(P), 3));
      g.setAttribute('normal', new K.Attr(new Float32Array(N), 3));
      g.setAttribute('color', new K.Attr(new Float32Array(C), 3));
      const m = new K.Mesh(g, material);
      m.position.set(mx, my, mz); m.castShadow = m.receiveShadow = true; m.frustumCulled = false;
      W().scene.add(m);
      const dx = mx - x, dz = mz - z, l = Math.hypot(dx, dz) || 1, power = PART_SPEED * (0.5 + near);
      parts.push({ m, v: [dx / l * power * rnd(0.4, 1.2) + rnd(-0.3, 0.3), power * rnd(0.5, 1.2), dz / l * power * rnd(0.4, 1.2) + rnd(-0.3, 0.3)],
        w: [rnd(-12, 12), rnd(-12, 12), rnd(-12, 12)], half: [hx, hy, hz], rest: false, smoke: Math.random() < 0.4 ? rnd(2, 6) : 0 });
    }
  }
  function stepParts(t) {
    const dt = Math.min(0.05, partsLast ? (t - partsLast) / 1000 : 0); partsLast = t;
    let busy = false;
    for (const p of parts) {
      if (p.smoke > 0) { p.smoke -= dt; if (Math.random() < dt * 8) { W().spawn('smoke', p.m.position.x, p.m.position.y + 0.02, p.m.position.z, { vy: rnd(0.1, 0.2), size: 0.02, grow: 3, life: rnd(1.5, 2.5) }); W().startEffects(); } busy = true; }
      if (p.rest || !dt) continue;
      busy = true;
      p.v[1] -= 3 * dt;
      p.m.position.x += p.v[0] * dt; p.m.position.y += p.v[1] * dt; p.m.position.z += p.v[2] * dt;
      p.m.rotation.x += p.w[0] * dt; p.m.rotation.y += p.w[1] * dt; p.m.rotation.z += p.w[2] * dt;
      p.m.updateMatrix();
      const e = p.m.matrix.elements, s = (k) => Math.hypot(e[k], e[k + 1], e[k + 2]) || 1;
      const low = p.half[0] * Math.abs(e[1] / s(0)) + p.half[1] * Math.abs(e[5] / s(4)) + p.half[2] * Math.abs(e[9] / s(8));
      if (p.m.position.y - low < 0.04) {
        p.m.position.y = 0.04 + low;
        if (p.v[1] < -0.2) { p.v[1] = -p.v[1] * 0.3; p.v[0] *= 0.5; p.v[2] *= 0.5; p.w = p.w.map((v) => v * 0.5); }
        else {
          p.v[1] = 0; const f = Math.exp(-12 * dt); p.v[0] *= f; p.v[2] *= f; p.w = p.w.map((v) => v * f);
          const snap = (a) => { const q = Math.round(a / (Math.PI / 2)) * (Math.PI / 2); return a + (q - a) * Math.min(1, dt * 6); };
          p.m.rotation.x = snap(p.m.rotation.x); p.m.rotation.z = snap(p.m.rotation.z);
          if (Math.hypot(p.v[0], p.v[2]) < 0.01 && Math.abs(p.w[0]) + Math.abs(p.w[2]) < 0.3) p.rest = true;
        }
      }
    }
    if (busy) requestAnimationFrame(stepParts); else partsOn = false;
  }

  // ---------- buildings: solid chunks, holes, collapse ----------
  // The first rocket that hits a building swaps it for solid chunks (as in the nuke and monster
  // scripts): the boxes its walls are made of, cut into convex pieces about CHUNK_SIZE big, with
  // the facade (windows, colours) outside and broken concrete inside. The cutting starts as soon
  // as you fire (the rocket is still flying), in small time slices, so nothing stutters.
  // Each hit blows out the chunks around the impact: a ragged crater with the chunks behind it
  // showing. On the HITS_TO_COLLAPSE-th hit the rest comes straight down; a jagged stump stays.
  const solids = new Map();          // projectId → state
  const outlines = [];               // known buildings (footprints), refreshed now and then
  let outlinesAt = -1e9;
  function buildingList() {
    const now = performance.now();
    if (now - outlinesAt < 2000) return outlines;
    outlinesAt = now; outlines.length = 0;
    W().scene.traverse((o) => {
      if (!o.isMesh || o.isInstancedMesh || !o.geometry || !o.geometry.index) return;
      if (!isFacade(Array.isArray(o.material) ? o.material[0] : o.material)) return;
      let grp = null; for (let p = o; p && !grp; p = p.parent) if (p.userData && p.userData.projectId !== undefined) grp = p;
      if (!grp || solids.has(grp.userData.projectId)) return;
      const boxes = massesOf(o); if (!boxes.length) return;
      outlines.push({ id: grp.userData.projectId, grp, mesh: o, boxes, x0: Math.min(...boxes.map((b) => b.x0)), x1: Math.max(...boxes.map((b) => b.x1)),
        z0: Math.min(...boxes.map((b) => b.z0)), z1: Math.max(...boxes.map((b) => b.z1)), top: Math.max(...boxes.map((b) => b.y1)) });
    });
    return outlines;
  }
  const massCache = new WeakMap();
  function massesOf(mesh) { if (!massCache.has(mesh)) massCache.set(mesh, readMasses(mesh)); return massCache.get(mesh); }
  // the building at a point (a little slack: the point is on its surface)
  function buildingAt(p) {
    const e = 0.03;
    for (const st of solids.values()) if (p.x >= st.bd.x0 - e && p.x <= st.bd.x1 + e && p.z >= st.bd.z0 - e && p.z <= st.bd.z1 + e && p.y <= st.bd.top + e) return st.bd;
    for (const bd of buildingList()) if (bd.boxes.some((b) => p.x >= b.x0 - e && p.x <= b.x1 + e && p.z >= b.z0 - e && p.z <= b.z1 + e && p.y >= b.y0 - e && p.y <= b.y1 + e)) return bd;
    return null;
  }

  // ---- cutting a building into chunks, in time slices ----
  function* cutBuilding(bd, st) {
    const pieces = [];
    for (const b of bd.boxes) {
      const wall = b.wallColor, concrete0 = [wall[0] * 0.55 + 0.15, wall[1] * 0.55 + 0.145, wall[2] * 0.55 + 0.14];
      const tags = { '+x': { side: '+x', ext: true }, '-x': { side: '-x', ext: true }, '+z': { side: '+z', ext: true }, '-z': { side: '-z', ext: true }, '+y': { side: '+y', ext: true }, '-y': { side: '-y', ext: false } };
      // in slabs of about two chunk heights, so one cut never has to deal with a whole tower
      const layers = Math.max(1, Math.round((b.y1 - b.y0) / (CHUNK_SIZE * 2)));
      for (let l = 0; l < layers; l++) {
        const ya = b.y0 + (b.y1 - b.y0) * l / layers, yb = b.y0 + (b.y1 - b.y0) * (l + 1) / layers;
        const t = { ...tags, '+y': { side: '+y', ext: l === layers - 1 }, '-y': { side: '-y', ext: false } };
        const chunks = [];
        shatter(boxPoly(b.x0, ya, b.z0, b.x1, yb, b.z1, t), CHUNK_SIZE, chunks);
        for (const ch of chunks) {
          const s2 = rnd(0.88, 1.1);
          let big = null, area = -1;
          for (const f of ch) { const a = Math.hypot(...newell(f.v)); if (a > area) { area = a; big = f.n; } }
          pieces.push({ tris: pieceTriangles(ch, b, concrete0.map((v) => v * s2)), normal: big });
        }
        yield;
      }
    }
    // one layer with the facade material; every chunk keeps its own vertex range
    const total = pieces.reduce((s, p) => s + p.tris.length * 3, 0);
    const g = new K.Geometry();
    const attr = (w) => { const at = new K.Attr(new Float32Array(Math.max(3, total) * w), w); if (at.setUsage) at.setUsage(35048); return at; };
    g.setAttribute('position', attr(3)); g.setAttribute('normal', attr(3)); g.setAttribute('color', attr(3)); g.setAttribute('uv', attr(2));
    const P = g.attributes.position, N = g.attributes.normal, C = g.attributes.color, U = g.attributes.uv;
    const frs = [];
    let k = 0;
    for (const pc of pieces) {
      let px = 0, py = 0, pz = 0, m = 0;
      for (const t of pc.tris) for (const v of t) { px += v.p[0]; py += v.p[1]; pz += v.p[2]; m++; }
      const pivot = [px / m, py / m, pz / m];
      const fr = { start: k, count: m, pivot, normal: pc.normal, orig: new Float32Array(m * 3), n0: new Float32Array(m * 3), state: 'still' };
      let q = 0;
      for (const t of pc.tris) for (const v of t) {
        P.setXYZ(k, v.p[0], v.p[1], v.p[2]); N.setXYZ(k, v.n[0], v.n[1], v.n[2]); C.setXYZ(k, v.c[0], v.c[1], v.c[2]); U.setXY(k, v.uv[0], v.uv[1]);
        fr.orig.set([v.p[0] - pivot[0], v.p[1] - pivot[1], v.p[2] - pivot[2]], q * 3); fr.n0.set(v.n, q * 3);
        k++; q++;
      }
      frs.push(fr);
      if (frs.length % 200 === 0) yield;
    }
    Object.assign(st, { g, pos: P, nor: N, frs, ready: true });
  }
  function prepare(bd) {
    if (!bd || solids.has(bd.id)) return solids.get(bd && bd.id);
    const st = { bd, hits: 0, ready: false, gen: null };
    st.gen = cutBuilding(bd, st);
    solids.set(bd.id, st);
    const slice = () => {
      if (st.ready || !st.gen) return;
      const t0 = performance.now();
      while (performance.now() - t0 < 6) { if (st.gen.next().done) { st.gen = null; return; } }
      setTimeout(slice, 0);
    };
    slice();
    return st;
  }
  function finish(st) { if (st.gen) { while (!st.gen.next().done); st.gen = null; } }

  // swap the building for its chunks: hide the original, show the chunks (also to walk mode's hits)
  function swapIn(st) {
    if (st.mesh) return;
    finish(st);
    const bd = st.bd, mat = Array.isArray(bd.mesh.material) ? bd.mesh.material[0] : bd.mesh.material;
    const mesh = new K.Mesh(st.g, mat);
    mesh.castShadow = mesh.receiveShadow = true; mesh.frustumCulled = false; mesh.userData.scRocketSolid = true;
    W().scene.add(mesh);
    hideBuilding(bd);
    st.mesh = mesh;
    // (walk mode keeps bumping into / shooting at the building's own hidden walls until it comes
    // down – cheaper than rebuilding its walls for every crater)
  }
  // hide the building's own triangles: everything above the lot within its footprint in the city
  // block meshes, and its hidden group (walk mode's walls)
  const hidden = [];
  function hideBuilding(bd) {
    const f = { x0: bd.x0 - 0.08, x1: bd.x1 + 0.08, z0: bd.z0 - 0.08, z1: bd.z1 + 0.08 };   // roof rims stick out a little
    hidden.push(f);
    removeIn([f]);
  }
  const cleaned = new WeakMap();
  function removeIn(foot) {
    W().scene.traverse((o) => {
      if (!o.isMesh || o.isInstancedMesh || !o.geometry || o.geometry.index || o.userData.scRocketSolid) return;
      if (!isFacade(Array.isArray(o.material) ? o.material[0] : o.material)) return;
      const g = o.geometry, pos = g.attributes.position; if (!pos) return;
      const done = cleaned.get(g) || []; const todo = foot.filter((f) => !done.includes(f)); if (!todo.length) return;
      cleaned.set(g, done.concat(todo));
      if (!g.boundingBox) g.computeBoundingBox();
      o.updateWorldMatrix(true, false);
      const e = o.matrixWorld.elements, bb = g.boundingBox;
      const near = todo.filter((f) => bb.max.x + e[12] >= f.x0 && bb.min.x + e[12] <= f.x1 && bb.max.z + e[14] >= f.z0 && bb.min.z + e[14] <= f.z1);
      if (!near.length) return;
      const a = pos.array, tx = e[12], ty = e[13], tz = e[14];      // city block meshes are only moved, not turned
      let lo = Infinity, hi = -1;
      for (let i = 0; i + 8 < a.length; i += 9) {
        // the triangle's middle inside the footprint, and above the lot
        const x = (a[i] + a[i + 3] + a[i + 6]) / 3 + tx, y = Math.max(a[i + 1], a[i + 4], a[i + 7]) + ty, z = (a[i + 2] + a[i + 5] + a[i + 8]) / 3 + tz;
        if (y <= 0.036) continue;
        let inside = false; for (const f of near) if (x >= f.x0 && x <= f.x1 && z >= f.z0 && z <= f.z1) { inside = true; break; }
        if (!inside) continue;
        for (let v = 3; v < 9; v++) a[i + v] = a[i + (v % 3)];
        lo = Math.min(lo, i); hi = Math.max(hi, i + 9);
      }
      if (hi > 0) { if (pos.addUpdateRange) { pos.addUpdateRange(lo, hi - lo); } pos.needsUpdate = true; }
    });
  }

  // a rocket hit the building at p (n: the surface's direction out of it)
  function hitBuilding(bd, p, n) {
    const st = prepare(bd);
    swapIn(st);
    st.hits++;
    const R = HOLE_RADIUS * rnd(0.85, 1.15);
    const out = n || { x: 0, y: 0, z: 0 };
    for (const fr of st.frs) {
      if (fr.state !== 'still') continue;
      const dx = fr.pivot[0] - p.x, dy = fr.pivot[1] - p.y, dz = fr.pivot[2] - p.z, d = Math.hypot(dx, dy, dz);
      if (d > R * rnd(0.85, 1.15)) continue;
      const l = d || 1, sp = rnd(0.6, 2.2) * (1 - d / (R * 1.2) * 0.5);
      launchChunk(st, fr, [(dx / l) * 0.5 * sp + out.x * sp + rnd(-0.3, 0.3), (dy / l) * 0.4 * sp + rnd(0.2, 1), (dz / l) * 0.5 * sp + out.z * sp + rnd(-0.3, 0.3)], 0, rnd(4, 12));
    }
    if (st.hits >= HITS_TO_COLLAPSE) comeDown(st, p, out);
    run();
  }
  // The building comes down from the last impact p (n: out of the wall there): the floor at the
  // impact fails first and the failure spreads outwards at COLLAPSE_SPREAD; what's above drops and
  // tips towards the hole, the floors below go one after the other. A low jagged stump stays.
  function comeDown(st, p, n) {
    if (st.down) return;
    st.down = true;
    const bd = st.bd, cx = (bd.x0 + bd.x1) / 2, cz = (bd.z0 + bd.z1) / 2;
    p = p || { x: cx, y: bd.top / 2, z: cz };
    let nx = n ? n.x : 0, nz = n ? n.z : 0; const nl = Math.hypot(nx, nz);
    if (nl < 0.3) { nx = p.x - cx; nz = p.z - cz; } const l2 = Math.hypot(nx, nz) || 1; nx /= l2; nz /= l2;
    const H = Math.max(0.1, bd.top - p.y);
    let last = 0;
    for (const fr of st.frs) {
      if (fr.state !== 'still') continue;
      if (fr.pivot[1] < 0.03 + Math.random() * STUMP) continue;
      const dh = Math.hypot(fr.pivot[0] - p.x, fr.pivot[2] - p.z), dy = fr.pivot[1] - p.y;
      let delay, v;
      if (dy > -0.06) {
        // above the impact: loses its support, drops, and leans over towards the hole
        const up = Math.min(1, Math.max(0, dy) / H);
        delay = 0.12 + dh / COLLAPSE_SPREAD * 0.6 + rnd(0, 0.08);
        const lean = COLLAPSE_LEAN * (0.25 + up) * rnd(0.7, 1.2);
        v = [nx * lean + (fr.pivot[0] - cx) * rnd(0, 0.3) + rnd(-0.08, 0.08), rnd(-0.3, 0), nz * lean + (fr.pivot[2] - cz) * rnd(0, 0.3) + rnd(-0.08, 0.08)];
      } else {
        // below the impact: crushed floor by floor by what comes down on it
        delay = 0.35 + dh / COLLAPSE_SPREAD + (-dy) * 1.8 + rnd(0, 0.15);
        v = [(fr.pivot[0] - cx) * rnd(0, 0.5) + rnd(-0.1, 0.1), rnd(-0.2, 0.05), (fr.pivot[2] - cz) * rnd(0, 0.5) + rnd(-0.1, 0.1)];
      }
      last = Math.max(last, delay);
      launchChunk(st, fr, v, delay, rnd(0.5, 3));
    }
    const w = W();
    w.sound('crack');
    setTimeout(() => w.sound('boom'), 250);
    setTimeout(() => w.sound('boom'), 900 + last * 400);
    // a burst of dust and concrete out of the hole
    if (DUST > 0) for (let k = 0; k < 18 * DUST; k++) w.spawn('dust', p.x + nx * 0.05, p.y + rnd(-0.05, 0.1), p.z + nz * 0.05, { fade: true, vx: nx * rnd(0.3, 1) + rnd(-0.3, 0.3), vy: rnd(-0.1, 0.4), vz: nz * rnd(0.3, 1) + rnd(-0.3, 0.3), rise: 0.05, drag: 0.9, size: rnd(0.06, 0.12), grow: 6, life: rnd(5, 9), alpha: 0.75 });
    else for (let k = 0; k < 40; k++) {
      const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * 0.7;
      w.spawn('smoke', cx + Math.cos(a) * r, 0.06 + Math.random() * 0.2, cz + Math.sin(a) * r, { vx: Math.cos(a) * rnd(0.1, 0.4), vy: rnd(0.02, 0.15), vz: Math.sin(a) * rnd(0.1, 0.4), size: rnd(0.06, 0.12), grow: 4, life: rnd(3, 6), color: k % 2 ? '#b9aa96' : '#a39684' });
    }
    st.wave = { t: 0, until: 1.5 + last, at: 0.3 };   // the dust wave rolling out over the ground (stepSolids)
    w.startEffects();
    crushed(bd, 600);
    // walk mode: the building's own (hidden) walls go now, once
    st.bd.grp.traverse((o) => { if (o.isMesh && o.geometry) o.geometry = new K.Geometry(); });
    setTimeout(() => window.dispatchEvent(new Event('sc:geometry-changed')), 4000 + last * 1000);
  }
  // casualties: everyone inside, and on the street right next to it (residents + cops)
  function crushed(bd, ms) {
    setTimeout(() => {
      const res = window.scResidents;
      if (res && res.crush) res.crush(bd.x0, bd.z0, bd.x1, bd.z1);
      window.dispatchEvent(new CustomEvent('sc:crush', { detail: { x0: bd.x0, z0: bd.z0, x1: bd.x1, z1: bd.z1, margin: 0.3 } }));
    }, ms);
  }
  // dust rolling out over the ground from a collapsing building
  function stepDust(st, dt) {
    const wv = st.wave; if (!wv || DUST <= 0) return false;
    wv.t += dt;
    if (wv.t > wv.until) { st.wave = null; return false; }
    const w = W(), bd = st.bd, cx = (bd.x0 + bd.x1) / 2, cz = (bd.z0 + bd.z1) / 2;
    const per = 2 * ((bd.x1 - bd.x0) + (bd.z1 - bd.z0));
    wv.at -= dt;
    while (wv.at <= 0) {
      wv.at += 1 / (12 * DUST * Math.min(3, 0.5 + per));
      // a point on the footprint's edge, moving out from the middle
      let u = Math.random() * per, x, z;
      const wx = bd.x1 - bd.x0, wz = bd.z1 - bd.z0;
      if (u < wx) { x = bd.x0 + u; z = bd.z0; } else if ((u -= wx) < wz) { x = bd.x1; z = bd.z0 + u; } else if ((u -= wz) < wx) { x = bd.x1 - u; z = bd.z1; } else { u -= wx; x = bd.x0; z = bd.z1 - u; }
      let dx = x - cx, dz = z - cz; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
      const sp = rnd(0.5, 1.4), high = Math.random() < 0.3;
      w.spawn('dust', x, rnd(0.05, 0.15), z, { fade: true, vx: dx * sp + rnd(-0.15, 0.15), vy: high ? rnd(0.2, 0.6) : rnd(0, 0.05), vz: dz * sp + rnd(-0.15, 0.15),
        rise: high ? rnd(0.08, 0.2) : 0.01, drag: high ? 0.7 : 0.45, flat: high ? 1 : 1.8, size: rnd(0.1, 0.2), grow: rnd(5, 8), life: rnd(7, 12), alpha: rnd(0.6, 0.85) });
    }
    w.startEffects();
    return true;
  }
  function launchChunk(st, fr, v, delay, spin) {
    let ax = rnd(-1, 1), ay = rnd(-0.5, 0.5), az = rnd(-1, 1); const al = Math.hypot(ax, ay, az) || 1;
    Object.assign(fr, { state: 'flying', v, delay, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], off: [0, 0, 0], axis: [ax / al, ay / al, az / al], w: spin, landed: false, age: 0 });
    st.active = true;
  }

  let runOn = false, runLast = 0;
  function run() { if (!runOn) { runOn = true; runLast = 0; requestAnimationFrame(stepSolids); } }
  function stepSolids(t) {
    const dt = Math.min(0.05, runLast ? (t - runLast) / 1000 : 0); runLast = t;
    let any = false;
    for (const st of solids.values()) {
      if (st.wave && stepDust(st, dt)) any = true;
      if (!st.active || !st.frs) continue;
      let lo = Infinity, hi = -1, busy = false;
      for (const fr of st.frs) {
        if (fr.state !== 'flying') continue;
        busy = true;
        if (fr.delay > 0) { fr.delay -= dt; continue; }
        fr.age += dt;
        fr.v[1] -= 6 * dt;
        for (let a = 0; a < 3; a++) fr.off[a] += fr.v[a] * dt;
        if (!fr.landed) fr.R = mul(rot(...fr.axis, fr.w * dt), fr.R);
        else {
          const [x, y, z] = fr.normal, R = fr.R;
          const n = [R[0] * x + R[1] * y + R[2] * z, R[3] * x + R[4] * y + R[5] * z, R[6] * x + R[7] * y + R[8] * z];
          const tilt = Math.acos(Math.min(1, Math.max(-1, -n[1])));   // comes to rest on its largest face
          if (tilt > 0.01) { let ax = n[2], az = -n[0]; let l = Math.hypot(ax, az); if (l < 1e-6) { ax = 1; az = 0; l = 1; } fr.R = mul(rot(ax / l, 0, az / l, Math.min(tilt, 6 * dt)), R); }
          const f = Math.exp(-5 * dt); fr.v[0] *= f; fr.v[2] *= f;
          if ((tilt <= 0.01 && Math.hypot(fr.v[0], fr.v[2]) < 0.05) || fr.age > 10) fr.state = 'rest';
        }
        let minY = writeChunk(st, fr);
        if (minY < 0.04) {
          fr.off[1] += 0.04 - minY;
          if (!fr.landed) {
            fr.landed = true;
            // a puff of dust where debris of a collapsing building hits the ground, pushed outwards
            if (st.down && DUST > 0 && Math.random() < 0.3 * DUST) {
              const x = fr.pivot[0] + fr.off[0], z = fr.pivot[2] + fr.off[2], bd = st.bd;
              let dx = x - (bd.x0 + bd.x1) / 2, dz = z - (bd.z0 + bd.z1) / 2; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
              W().spawn('dust', x, 0.06, z, { fade: true, vx: dx * rnd(0.3, 0.9) + fr.v[0] * 0.3, vy: rnd(0.02, 0.15), vz: dz * rnd(0.3, 0.9) + fr.v[2] * 0.3, rise: 0.03, drag: 0.6, flat: 1.5, size: rnd(0.08, 0.16), grow: rnd(4, 7), life: rnd(6, 10), alpha: 0.7 });
              W().startEffects();
            }
            fr.v[0] *= 0.4; fr.v[2] *= 0.4;
          }
          fr.v[1] = Math.max(0, fr.v[1]) * 0.1;
          minY = writeChunk(st, fr);
        }
        lo = Math.min(lo, fr.start); hi = Math.max(hi, fr.start + fr.count);
      }
      if (hi > 0) for (const a of [st.pos, st.nor]) { if (a.addUpdateRange) { a.addUpdateRange(lo * 3, (hi - lo) * 3); } a.needsUpdate = true; }
      if (busy) any = true; else st.active = false;
    }
    if (any) requestAnimationFrame(stepSolids); else runOn = false;
  }
  function writeChunk(st, fr) {
    const { orig, n0, R, pivot, off } = fr, pos = st.pos, nor = st.nor;
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
  // keep hidden buildings hidden if the app redraws a city block
  setInterval(() => { if (hidden.length && W() && W().scene) try { removeIn(hidden); } catch (e) { /* next time */ } }, 1500);

  // for the monster script: buildings already turned into chunks by rockets
  window.scRocketSolids = {
    list: () => [...solids.values()].filter((st) => !st.down).map((st) => ({ id: st.bd.id, x0: st.bd.x0, x1: st.bd.x1, z0: st.bd.z0, z1: st.bd.z1, top: st.bd.top })),
    collapse(id, dir, force) {
      const st = solids.get(id); if (!st || st.down) return false;
      swapIn(st); st.down = true;
      st.bd.grp.traverse((o) => { if (o.isMesh && o.geometry) o.geometry = new K.Geometry(); });
      st.wave = { t: 0, until: 2.5, at: 0.3 };
      crushed(st.bd, 500);
      for (const fr of st.frs) {
        if (fr.state !== 'still' || fr.pivot[1] < 0.03 + Math.random() * STUMP) continue;
        const up = Math.min(1, fr.pivot[1] / Math.max(0.1, st.bd.top));
        const push = force * (0.25 + 0.75 * up) * rnd(0.6, 1.2);
        launchChunk(st, fr, [dir[0] * push + rnd(-0.2, 0.2), rnd(-0.2, 0.5), dir[2] * push + rnd(-0.2, 0.2)], rnd(0, 0.3), rnd(1, 5));
      }
      run();
      return true;
    },
  };

  const isFacade = (m) => m && m.map && typeof m.customProgramCacheKey === 'function' && m.customProgramCacheKey() === 'facade';

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
        walls.push({ ax, along, sign, at: P[0][ax], s0: Math.min(...P.map((p) => p[along])), s1: Math.max(...P.map((p) => p[along])),
          y0: Math.min(...P.map((p) => p[1])), y1: Math.max(...P.map((p) => p[1])), c,
          u: (s) => U[a][0] + (s - P[a][along]) * du, v: (y) => U[0][1] + (y - P[0][1]) * dv });
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
            if (w) { c = w.c; uvOf = (p) => [w.u(p[w.along]), w.v(p[1])]; }
          }
        }
      }
      const vs = f.v.map((p) => ({ p, n: f.n, c, uv: uvOf(p) }));
      for (let i = 1; i + 1 < vs.length; i++) tris.push([vs[0], vs[i], vs[i + 1]]);
    }
    return tris;
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

})();
