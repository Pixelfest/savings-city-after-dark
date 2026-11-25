// ==UserScript==
// @name         Savings City – helicopter and cranes (walk mode)
// @namespace    savings-city-tweaks
// @version      1.1
// @description  In walk mode the helicopter and the construction cranes can be destroyed: 2 shots or a rocket. The helicopter explodes and spins down, the crane topples over.
// @match        https://your-savings-city-host.example/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * Needs the core script (frame loop) and the walk-mode script (1.22 or newer): window.scWalk.addTarget makes them shootable,
 * sc:blast events (car explosions, rockets – rocket launcher 1.5+ tells the height) reach them.
 *
 * - The app's helicopter is one object (userData.kind === 'helicopter') that the app moves every
 *   frame. Destroyed: the original is hidden for good (its `visible` is pinned to false, so the app
 *   can't show it again) and a burnt copy takes its place: an explosion, then it spins down with
 *   fire and smoke, crashes (on the ground or a roof) with a second explosion and burns out.
 *   The pilot counts as a death (sc:kill).
 * - A crane is a group per building under construction: a mast and a turning head with hook and
 *   cable (found by the hook's box size). Destroyed: a copy pivots at the foot of the mast and
 *   falls over, away from the shot or the blast, speeding up like a real fall; where it lands,
 *   dust, and people underneath are crushed (residents' crush, sc:crush for the cops). If the app
 *   rebuilds the building, its new crane is hidden straight away (remembered by position).
 * - Hit tests: the ray against every part's own box (in the part's coordinates), so the thin
 *   crane jib is only hit where it really is.
 */
(function () {
  'use strict';

  // ---- settings (tiles; 1 tile ≈ 20 m) ----
  const HITS = 2;                  // shots it takes (a rocket or a blast close by: at once)
  const BLAST_REACH = 0.35;        // a blast this close to any part destroys it (plus the blast's knock radius / 2)
  const HELI_GRAVITY = 2.2;        // tiles/s² while it falls
  const HELI_SPIN = 4;             // rad/s spin as it goes down (and it speeds up)
  const BURN_SECONDS = 25;         // the helicopter wreck burns this long
  const CRANE_FALL = 9;            // how fast a crane tips over (higher = faster)
  // -----------------------------------------

  const rnd = (a, b) => a + Math.random() * (b - a);
  const W = () => window.scWalk;
  let K = null;
  const things = [];               // { kind: 'heli' | 'crane', obj, hits, key }
  const gone = new Set();          // crane positions (and 'heli') that were destroyed
  const wrecks = [];               // animated copies

  function hideForever(o) {
    try { Object.defineProperty(o, 'visible', { get() { return false; }, set() {}, configurable: true }); } catch { o.visible = false; }
  }
  const shown = (o) => { for (let q = o; q; q = q.parent) if (!q.visible) return false; return true; };

  // ---------- finding them ----------
  let scanAt = 0;
  function scan() {
    const w = W(); if (!w || !w.scene) return;
    things.length = 0;
    w.scene.traverse((o) => {
      for (let q = o; q; q = q.parent) if (q.userData && q.userData.scWreck) return;   // our own wrecks
      if (o.userData && o.userData.kind === 'helicopter') {
        if (gone.has('heli')) hideForever(o); else things.push(prev(o) || { kind: 'heli', obj: o, hits: 0, key: 'heli' });
      }
      const p = o.geometry && o.geometry.parameters;
      if (o.isMesh && p && Math.abs(p.width - 0.22) < 1e-6 && Math.abs(p.height - 0.06) < 1e-6 && Math.abs(p.depth - 0.1) < 1e-6) {   // a crane's hook
        const head = o.parent, crane = head && head.parent; if (!crane) return;
        crane.updateWorldMatrix(true, true);
        const b = worldBox(crane), key = 'crane:' + Math.round((b.lo[0] + b.hi[0]) * 10) + ',' + Math.round(b.lo[2] * 10);
        const mast = crane.children.find((c) => c !== head && c.isMesh);
        if (gone.has(key)) hideForever(crane); else things.push(prev(crane) || { kind: 'crane', obj: crane, head, mast, hits: 0, key });
      }
    });
  }
  let before = [];
  const prev = (o) => before.find((t) => t.obj === o);

  // world box of an object (all meshes)
  function worldBox(o) {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    o.traverse((m) => {
      if (!m.isMesh || !m.geometry) return;
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      const bb = m.geometry.boundingBox, e = m.matrixWorld.elements;
      for (let i = 0; i < 8; i++) {
        const x = i & 1 ? bb.max.x : bb.min.x, y = i & 2 ? bb.max.y : bb.min.y, z = i & 4 ? bb.max.z : bb.min.z;
        const v = [e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]];
        for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], v[k]); hi[k] = Math.max(hi[k], v[k]); }
      }
    });
    return { lo, hi };
  }

  // ---------- shooting them ----------
  // the ray in each part's own coordinates against the part's box
  function hitObject(obj, o, d, maxT) {
    let best = null;
    obj.updateWorldMatrix(true, true);
    obj.traverse((m) => {
      if (!m.isMesh || !m.geometry) return;
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      const bb = m.geometry.boundingBox, inv = new K.M4().copy(m.matrixWorld).invert();
      const O = new K.V3(o.x, o.y, o.z).applyMatrix4(inv), D = new K.V3(o.x + d.x, o.y + d.y, o.z + d.z).applyMatrix4(inv).sub(O);
      const lo = [bb.min.x - 0.004, bb.min.y - 0.004, bb.min.z - 0.004], hi = [bb.max.x + 0.004, bb.max.y + 0.004, bb.max.z + 0.004], OO = [O.x, O.y, O.z], DD = [D.x, D.y, D.z];
      let t0 = 0, t1 = best ? best.t : maxT;
      for (let k = 0; k < 3; k++) {
        if (Math.abs(DD[k]) < 1e-12) { if (OO[k] < lo[k] || OO[k] > hi[k]) return; continue; }
        let a = (lo[k] - OO[k]) / DD[k], b = (hi[k] - OO[k]) / DD[k]; if (a > b) [a, b] = [b, a];
        t0 = Math.max(t0, a); t1 = Math.min(t1, b); if (t0 > t1) return;
      }
      if (t0 > 0) best = { t: t0 };
    });
    return best;
  }
  function register() {
    const w = W();
    if (register.done || !w || !w.addTarget) return;
    register.done = true;
    w.addTarget({
      hit(o, d, maxT) {
        if (!K && !(K = w.classes())) return null;
        let best = null;
        for (const th of things) {
          if (th.dead || !shown(th.obj)) continue;
          const h = hitObject(th.obj, o, d, best ? best.t : maxT);
          if (h) best = { t: h.t, th, at: { x: o.x + d.x * h.t, y: o.y + d.y * h.t, z: o.z + d.z * h.t } };
        }
        return best;
      },
      onHit(h, d) {
        const th = h.th, w = W();
        if (th.dead) return;
        th.hits++;
        for (let k = 0; k < 8; k++) w.spawn('spark', h.at.x, h.at.y, h.at.z, { vx: rnd(-0.5, 0.5) - d.x * 0.3, vy: rnd(0, 0.6), vz: rnd(-0.5, 0.5) - d.z * 0.3, g: 3, size: 0.004, life: rnd(0.2, 0.5) });
        w.startEffects();
        w.sound('glass');
        if (th.hits >= HITS) destroy(th, d);
      },
    });
  }
  window.addEventListener('sc:blast', (e) => {
    const { x, y = 0.08, z, knock = 0.6 } = e.detail || {};
    const reach = BLAST_REACH + knock / 2;
    for (const th of things.slice()) {
      if (th.dead || !shown(th.obj)) continue;
      const b = worldBox(th.obj);
      const dx = Math.max(b.lo[0] - x, 0, x - b.hi[0]), dy = Math.max(b.lo[1] - y, 0, y - b.hi[1]), dz = Math.max(b.lo[2] - z, 0, z - b.hi[2]);
      if (Math.hypot(dx, dy, dz) > reach) continue;
      const cx = (b.lo[0] + b.hi[0]) / 2 - x, cz = (b.lo[2] + b.hi[2]) / 2 - z, l = Math.hypot(cx, cz) || 1;
      destroy(th, { x: cx / l, y: 0, z: cz / l });
    }
  });

  // ---------- destroying them ----------
  function destroy(th, d) {
    const w = W();
    if (th.dead || !(K || (K = w.classes()))) return;
    th.dead = true;
    gone.add(th.key);
    if (th.kind === 'heli') destroyHeli(th, d); else destroyCrane(th, d);
  }
  function boom(x, y, z, big) {
    const w = W();
    w.sound('boom');
    w.spawn('flash', x, y, z, { size: big ? 0.5 : 0.35, life: 0.3, grow: 2 });
    for (let k = 0; k < (big ? 50 : 30); k++) {
      const a = Math.random() * Math.PI * 2, up = Math.random(), sp = rnd(0.5, 1.4);
      w.spawn('fire', x, y, z, { vx: Math.cos(a) * sp * (1 - up * 0.5), vy: 0.3 + up * 1.4, vz: Math.sin(a) * sp * (1 - up * 0.5), g: 1.6, size: rnd(0.03, 0.06), life: rnd(0.4, 0.9) });
    }
    for (let k = 0; k < 16; k++) { const a = Math.random() * Math.PI * 2, sp = rnd(0.4, 1.2); w.spawn('debris', x, y, z, { vx: Math.cos(a) * sp, vy: rnd(0.4, 1.4), vz: Math.sin(a) * sp, g: 3, size: rnd(0.01, 0.022), life: rnd(3, 5), land: true, spin: true }); }
    if (w.blackSmoke) for (let k = 0; k < 16; k++) w.blackSmoke(x + rnd(-0.1, 0.1), y + rnd(0, 0.15), z + rnd(-0.1, 0.1), { vx: rnd(-0.3, 0.3), vy: rnd(0.4, 1), vz: rnd(-0.3, 0.3), rise: rnd(0.3, 0.6), size: rnd(0.07, 0.13), life: rnd(4, 7) });
    w.startEffects();
  }

  function destroyHeli(th, d) {
    const w = W(), o = th.obj;
    o.updateWorldMatrix(true, true);
    const wreck = o.clone(true);
    wreck.userData = { scWreck: true };
    o.matrixWorld.decompose(wreck.position, wreck.quaternion, wreck.scale);
    wreck.traverse((m) => {   // burnt
      if (!m.isMesh) return;
      m.material = Array.isArray(m.material) ? m.material.map((x) => x.clone()) : m.material.clone();
      for (const mt of Array.isArray(m.material) ? m.material : [m.material]) if (mt.color) mt.color.multiplyScalar(0.15);
      m.castShadow = true;
    });
    hideForever(o);
    w.scene.add(wreck);
    const p = wreck.position;
    boom(p.x, p.y, p.z, false);
    window.dispatchEvent(new CustomEvent('sc:kill', { detail: { x: p.x, z: p.z, cause: 'crash', who: 'pilot' } }));
    wrecks.push({ kind: 'heli', m: wreck, v: [d.x * 0.3, 0.1, d.z * 0.3], spin: HELI_SPIN * (Math.random() < 0.5 ? -1 : 1), state: 'falling', fx: 0, t: 0 });
    run();
  }

  function destroyCrane(th, d) {
    const w = W(), g = th.obj;
    g.updateWorldMatrix(true, true);
    const box = worldBox(g), mb = th.mast ? worldBox(th.mast) : box;
    const bx = (mb.lo[0] + mb.hi[0]) / 2, by = mb.lo[1], bz = (mb.lo[2] + mb.hi[2]) / 2;
    const copy = g.clone(true);
    copy.matrixAutoUpdate = false;
    copy.matrix.copy(g.matrixWorld);
    copy.matrix.elements[12] -= bx; copy.matrix.elements[13] -= by; copy.matrix.elements[14] -= bz;
    const pivot = new g.constructor();
    pivot.userData.scWreck = true;
    pivot.position.set(bx, by, bz);
    pivot.add(copy);
    hideForever(g);
    w.scene.add(pivot);
    const l = Math.hypot(d.x, d.z) || 1, dir = [d.x / l, d.z / l];
    for (let k = 0; k < 10; k++) w.spawn('debris', bx, by + 0.1, bz, { color: k % 2 ? '#f2b134' : '#7b7b7b', vx: rnd(-0.4, 0.4), vy: rnd(0.2, 0.7), vz: rnd(-0.4, 0.4), g: 3, size: rnd(0.008, 0.016), life: rnd(2, 4), land: true, spin: true });
    w.sound('crack');
    w.startEffects();
    wrecks.push({ kind: 'crane', m: pivot, axis: new K.V3(dir[1], 0, -dir[0]), dir, angle: 0.02, w: 0.15, H: Math.max(0.5, box.hi[1] - by), state: 'falling', base: [bx, bz] });
    run();
  }

  // ---------- animation ----------
  let on = false, last = 0;
  function run() { if (!on) { on = true; last = 0; requestAnimationFrame(step); } }
  function step(t) {
    const dt = Math.min(0.05, last ? (t - last) / 1000 : 0); last = t;
    const w = W();
    let busy = false;
    for (const wr of wrecks) {
      if (wr.state === 'out') continue;
      busy = true;
      if (wr.kind === 'heli') stepHeli(wr, dt, w); else stepCrane(wr, dt, w);
    }
    if (busy) requestAnimationFrame(step); else on = false;
  }
  function floorAt(x, y, z) {
    const h = W().rayBuildings({ x, y: y + 0.05, z }, { x: 0, y: -1, z: 0 }, y + 0.05);
    return h ? y + 0.05 - h.t : 0.04;
  }
  function stepHeli(wr, dt, w) {
    const p = wr.m.position;
    wr.t += dt;
    if (wr.state === 'falling') {
      wr.v[1] -= HELI_GRAVITY * dt;
      p.x += wr.v[0] * dt; p.y += wr.v[1] * dt; p.z += wr.v[2] * dt;
      wr.spin *= 1 + 0.6 * dt;
      wr.m.rotation.y += wr.spin * dt;
      wr.m.rotation.z = Math.min(0.5, wr.m.rotation.z + 0.25 * dt);   // nose dips
      wr.fx -= dt;
      while (wr.fx <= 0) {                                              // a trail of fire and smoke
        wr.fx += 0.04;
        w.spawn('fire', p.x + rnd(-0.04, 0.04), p.y + 0.03, p.z + rnd(-0.04, 0.04), { vy: rnd(0.1, 0.3), size: rnd(0.025, 0.045), life: rnd(0.3, 0.6) });
        if (w.blackSmoke && Math.random() < 0.5) w.blackSmoke(p.x, p.y + 0.05, p.z, { vy: 0.2, rise: 0.35, size: rnd(0.05, 0.08), life: rnd(4, 6) });
      }
      w.startEffects();
      const floor = floorAt(p.x, p.y, p.z);
      if (p.y <= floor + 0.01) {
        p.y = floor + 0.01;
        wr.state = 'burning'; wr.t = 0; wr.m.rotation.z = 0.35;
        boom(p.x, p.y + 0.05, p.z, true);
        const res = window.scResidents;
        if (res && res.gibAround) res.gibAround(p.x, p.z, 0.2, 1);
        if (floor < 0.1 && w.blastResidents) w.blastResidents(p.x, p.z, 0.2, p.y);
      }
    } else if (wr.state === 'burning') {
      const heat = Math.max(0, 1 - wr.t / BURN_SECONDS);
      if (heat <= 0) { wr.state = 'out'; return; }
      wr.fx -= dt;
      while (wr.fx <= 0) {
        wr.fx += 0.07 / heat;
        w.spawn('fire', p.x + rnd(-0.08, 0.08), p.y + 0.06, p.z + rnd(-0.08, 0.08), { vy: rnd(0.2, 0.45), size: rnd(0.025, 0.05) * (0.5 + heat / 2), life: rnd(0.5, 1) });
        if (w.blackSmoke && Math.random() < 0.6) w.blackSmoke(p.x + rnd(-0.06, 0.06), p.y + 0.1, p.z + rnd(-0.06, 0.06), { vy: rnd(0.3, 0.5), rise: rnd(0.35, 0.55), size: rnd(0.04, 0.07), life: rnd(5, 8), alpha: 0.85 * (0.5 + heat / 2) });
      }
      w.startEffects();
    }
  }
  function stepCrane(wr, dt, w) {
    if (wr.state !== 'falling') return;
    wr.w += (CRANE_FALL / wr.H) * Math.sin(wr.angle + 0.05) * dt * 3;
    wr.angle += wr.w * dt;
    const max = Math.PI / 2 - 0.04;
    if (wr.angle >= max) {
      wr.angle = max;
      if (wr.w > 0.4 && !wr.bounced) { wr.bounced = true; wr.w = -wr.w * 0.12; crashCrane(wr, w); }
      else { wr.state = 'out'; }
    }
    wr.m.quaternion.setFromAxisAngle(wr.axis, wr.angle);
  }
  // the crane hits the ground: dust along its length, people underneath crushed
  function crashCrane(wr, w) {
    w.sound('boom'); w.sound('crack');
    const [bx, bz] = wr.base, [dx, dz] = wr.dir, res = window.scResidents;
    for (let s = 0.2; s <= wr.H; s += 0.25) {
      const x = bx + dx * s, z = bz + dz * s;
      for (let k = 0; k < 2; k++) w.spawn('dust', x + rnd(-0.1, 0.1), 0.06, z + rnd(-0.1, 0.1), { fade: true, vx: rnd(-0.3, 0.3), vy: rnd(0, 0.1), vz: rnd(-0.3, 0.3), rise: 0.02, drag: 0.6, flat: 1.6, size: rnd(0.08, 0.14), grow: 5, life: rnd(4, 7), alpha: 0.7 });
      if (res && res.crush) res.crush(x - 0.08, z - 0.08, x + 0.08, z + 0.08, 0.05, 1.5);
      window.dispatchEvent(new CustomEvent('sc:crush', { detail: { x0: x - 0.08, z0: z - 0.08, x1: x + 0.08, z1: z + 0.08, margin: 0.05 } }));
    }
    w.startEffects();
  }

  // ---------- loop: keep the list fresh while walking ----------
  function frame(dt, t) {
    const w = W();
    if (!w || !w.walking || !w.scene) return;
    register();
    if (t - scanAt > 1000) { scanAt = t; before = things.slice(); try { scan(); } catch (e) { console.warn('[heli-crane]', e); } }
  }
  const whenCore = (fn) => (window.scCore ? fn(window.scCore) : (window.scCoreWaiting = window.scCoreWaiting || []).push(fn));
  whenCore((c) => c.onFrame(frame));
  window.scHeliCrane = { things: () => things.map((t) => ({ kind: t.kind, hits: t.hits, dead: !!t.dead, box: worldBox(t.obj) })) };
})();
