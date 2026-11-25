// ==UserScript==
// @name         Savings City – rocket launcher (walk mode)
// @namespace    savings-city-tweaks
// @version      1.6
// @description  Adds a rocket launcher to walk mode (key 3). Residents and cars are blown apart, walls get holes blown in them.
// @match        https://your-savings-city-host.example/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * Needs the walk-mode script (1.18 or newer): this script hands it a weapon (model, key, firing)
 * through window.scWalkWeapons, and uses window.scWalk for hit tests and effects. Buildings break
 * through the core and solid-buildings scripts: every explosion is a damage event
 * (scCore.damage({ kind: 'blast', … })); the buildings script makes the crater and brings the
 * building down after enough hits.
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
  const HOLE_RADIUS = 0.16;        // chunks within this distance of the impact are blown out (chunk size, hits to collapse: buildings script)
  const PART_SPEED = 2.2;          // how hard car parts fly
  // --------------------------------------------

  const rnd = (a, b) => a + Math.random() * (b - a);
  const W = () => window.scWalk;
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
    // the building it will hit starts being cut into chunks now, while the rocket flies
    try { const B = window.scBuildings, h = B && w.rayBuildings(start, d, RANGE); if (h) B.prepare(B.at({ x: start.x + d.x * h.t, y: start.y + d.y * h.t, z: start.z + d.z * h.t })); } catch (e) { console.warn('[rockets] prepare', e); }
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
    w.blastResidents(bx, bz, GIB_RADIUS, by);
    // trees and lamps
    for (const p of w.propsNear(bx, bz, PROP_RADIUS)) { const dx = p.x - bx, dz = p.z - bz, l = Math.hypot(dx, dz) || 1; w.knockProp(p, { x: dx / l, y: 0, z: dz / l }); }
    // cars
    try { burstCars(bx, by, bz, hit.kind === 'car' ? hit.car : null); } catch (e) { console.warn('[rockets] cars', e); }
    // a building close by: a crater of blown-out chunks, and after enough hits it comes down
    const core = window.scCore;
    if (core) core.damage({ kind: 'blast', source: 'rocket', x: hit.at.x, y: hit.at.y, z: hit.at.z, n: hit.n, radius: HOLE_RADIUS });
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

})();
