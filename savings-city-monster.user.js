// ==UserScript==
// @name         Savings City – giant monster
// @namespace    savings-city-tweaks
// @version      1.4
// @description  A 👾 button releases a giant green monster with round glasses that walks into the city and smashes buildings into solid chunks. Only in your browser – reload to rebuild.
// @match        https://your-savings-city-host.example/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * How it works
 * ------------
 * - The creature is built from simple shapes (egg-shaped body, tufts, big eyes, round glasses,
 *   short arms, stubby legs with claws) with mottled green colours, animated by hand: it walks
 *   with swaying body and swinging arms, blinks, and looks at what it is about to smash.
 * - It enters from outside the city, walks to the nearest building, and punches it. The building
 *   is pushed over by the solid-buildings script (needs savings-city-core and
 *   savings-city-buildings): cut into convex chunks with the facade (windows, colours) on the
 *   outside and broken concrete inside; a low, jagged stump stays. The chunks break loose starting
 *   where the fist hit, are pushed away from the monster (upper floors more), tumble, land and come
 *   to rest. Dust rolls out.
 * - Every footstep shakes the view; residents underfoot are squashed (residents script), others
 *   flee; cars underfoot are flattened.
 * - Click the button again to send the monster away. Nothing is sent to the server: reload the
 *   page and the city is back.
 */
(function () {
  'use strict';

  // sound through the core's output, which follows the app's own sound button (mute + volume)
  const out = (ctx) => (window.scCore ? window.scCore.out(ctx) : ctx.destination);

  // ---- settings (tiles; 1 tile ≈ 20 m) ----
  const MONSTER_HEIGHT = 2.6;      // top of the head (≈ 50 m); the tallest buildings are ~3
  const WALK_SPEED = 0.55;         // tiles per second
  const TURN_SPEED = 1.4;          // radians per second
  const PUNCH_FORCE = 3;           // how hard the chunks are pushed away (tiles per second, top floors)
  const CRACK_SPEED = 2.5;         // how fast the break runs through a building from where it was hit
  const SHAKE = 10;                // camera shake per footstep (pixels)
  const SOUND = true;
  // -------------------------------------------

  const rnd = (a, b) => a + Math.random() * (b - a);
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  // the scene, renderer, traffic and three.js classes come from the core script
  const core = () => window.scCore;
  const sceneOf = () => core() && core().scene;
  let K = null;
  function classes() { return K || (K = core() && core().classes()); }

  // ---------- the creature ----------
  // Built from simple shapes in unit size (1 = top of the head without the hair tufts), then
  // scaled to MONSTER_HEIGHT. Every shape gets slightly varied green per vertex, so the body looks
  // mottled like fur without being fur. Animated parts are separate objects:
  // root (position, heading) → hips → body (bob, sway, lean) → face, glasses, arms (shoulder pivots); legs (hip pivots).
  function shapes() {
    const P = [], N = [], C = [];
    let col = [1, 1, 1], vary = 0, low = null;
    // colour (with mottling amount v); `under` = a second colour that takes over towards the bottom
    const colour = (hex, v = 0, under = null) => { const c = new K.Color(hex); col = [c.r, c.g, c.b]; vary = v; low = under ? (() => { const u = new K.Color(under); return [u.r, u.g, u.b]; })() : null; };
    // smooth mottling: a little 3D wave noise, so neighbouring points get similar shades
    const noise = (p) => (Math.sin(p[0] * 23 + 1.7) + Math.sin(p[1] * 19 + p[0] * 7) + Math.sin(p[2] * 21 + p[1] * 5 + 0.4) + Math.sin((p[0] + p[2]) * 37)) / 4;
    const vtx = (p, n) => {
      const f = 1 + noise(p) * vary * 2;
      let c = col;
      if (low) { const t = Math.min(1, Math.max(0, (0.42 - p[1]) / 0.3 + noise([p[2], p[0], p[1]]) * 0.6)); c = col.map((v, k) => v + (low[k] - v) * t); }
      P.push(...p); N.push(...n); C.push(c[0] * f, c[1] * f, c[2] * f);
    };
    const api = {
      P, N, C, colour,
      // ellipsoid at c with radii r; taper > 0 makes it wider at the bottom (an egg / a pear)
      ellipsoid(c, r, seg = 18, taper = 0, rot = null) {
        const rows = Math.max(6, Math.round(seg * 0.6));
        const pt = (i, j) => {
          const th = (i / rows) * Math.PI, ph = (j / seg) * Math.PI * 2;
          const y0 = Math.cos(th), s = Math.sin(th) * (1 + taper * (-y0));
          let p = [s * Math.cos(ph) * r[0], y0 * r[1], s * Math.sin(ph) * r[2]];
          let n = [s * Math.cos(ph) / r[0], y0 / r[1], s * Math.sin(ph) / r[2]];
          if (rot) { p = rot(p); n = rot(n); }
          const l = Math.hypot(...n) || 1;
          return [[p[0] + c[0], p[1] + c[1], p[2] + c[2]], [n[0] / l, n[1] / l, n[2] / l]];
        };
        for (let i = 0; i < rows; i++) for (let j = 0; j < seg; j++) {
          const a = pt(i, j), b = pt(i + 1, j), d = pt(i + 1, j + 1), e = pt(i, j + 1);
          if (i > 0) { vtx(...a); vtx(...e); vtx(...d); }           // (no slivers at the poles)
          if (i < rows - 1) { vtx(...a); vtx(...d); vtx(...b); }
        }
      },
      // torus in the xy plane around c (facing +z), radius R, tube t, over `arc` radians from `start`
      torus(c, R, t, segU = 32, segV = 8, arc = Math.PI * 2, start = 0, rot = null) {
        const pt = (u, v) => {
          const a = start + (u / segU) * arc, b = (v / segV) * Math.PI * 2;
          const cx = Math.cos(a) * R, cy = Math.sin(a) * R;
          let n = [Math.cos(a) * Math.cos(b), Math.sin(a) * Math.cos(b), Math.sin(b)];
          let p = [cx + n[0] * t, cy + n[1] * t, n[2] * t];
          if (rot) { p = rot(p); n = rot(n); }
          return [[p[0] + c[0], p[1] + c[1], p[2] + c[2]], n];
        };
        for (let u = 0; u < segU; u++) for (let v = 0; v < segV; v++) {
          const a = pt(u, v), b = pt(u + 1, v), d = pt(u + 1, v + 1), e = pt(u, v + 1);
          vtx(...a); vtx(...b); vtx(...d); vtx(...a); vtx(...d); vtx(...e);
        }
      },
      // a cone from base centre c (radius r) to the tip at c + dir·h
      cone(c, dir, r, h, seg = 7) {
        const l = Math.hypot(...dir); const d = dir.map((x) => x / l);
        const u0 = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
        let u = [d[1] * u0[2] - d[2] * u0[1], d[2] * u0[0] - d[0] * u0[2], d[0] * u0[1] - d[1] * u0[0]]; const ul = Math.hypot(...u); u = u.map((x) => x / ul);
        const w = [d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]];
        const tip = [c[0] + d[0] * h, c[1] + d[1] * h, c[2] + d[2] * h];
        for (let i = 0; i < seg; i++) {
          const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
          const q = (a) => [c[0] + (u[0] * Math.cos(a) + w[0] * Math.sin(a)) * r, c[1] + (u[1] * Math.cos(a) + w[1] * Math.sin(a)) * r, c[2] + (u[2] * Math.cos(a) + w[2] * Math.sin(a)) * r];
          const nrm = (a) => { const n = [u[0] * Math.cos(a) + w[0] * Math.sin(a) + d[0] * r / h, u[1] * Math.cos(a) + w[1] * Math.sin(a) + d[1] * r / h, u[2] * Math.cos(a) + w[2] * Math.sin(a) + d[2] * r / h]; const nl = Math.hypot(...n); return n.map((x) => x / nl); };
          const am = (a0 + a1) / 2;
          vtx(q(a0), nrm(a0)); vtx(q(a1), nrm(a1)); vtx(tip, nrm(am));
        }
      },
      // a cylinder between two points
      rod(a, b, r, seg = 8) {
        const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], l = Math.hypot(...d), e = d.map((x) => x / l);
        const u0 = Math.abs(e[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
        let u = [e[1] * u0[2] - e[2] * u0[1], e[2] * u0[0] - e[0] * u0[2], e[0] * u0[1] - e[1] * u0[0]]; const ul = Math.hypot(...u); u = u.map((x) => x / ul);
        const w = [e[1] * u[2] - e[2] * u[1], e[2] * u[0] - e[0] * u[2], e[0] * u[1] - e[1] * u[0]];
        for (let i = 0; i < seg; i++) {
          const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
          const n = (q) => [u[0] * Math.cos(q) + w[0] * Math.sin(q), u[1] * Math.cos(q) + w[1] * Math.sin(q), u[2] * Math.cos(q) + w[2] * Math.sin(q)];
          const at = (p, q) => { const nn = n(q); return [p[0] + nn[0] * r, p[1] + nn[1] * r, p[2] + nn[2] * r]; };
          vtx(at(a, a0), n(a0)); vtx(at(b, a0), n(a0)); vtx(at(b, a1), n(a1));
          vtx(at(a, a0), n(a0)); vtx(at(b, a1), n(a1)); vtx(at(a, a1), n(a1));
        }
      },
    };
    return api;
  }
  function toMesh(sh, material) {
    const g = new K.Geometry();
    g.setAttribute('position', new K.Attr(new Float32Array(sh.P), 3));
    g.setAttribute('normal', new K.Attr(new Float32Array(sh.N), 3));
    g.setAttribute('color', new K.Attr(new Float32Array(sh.C), 3));
    const m = new K.Mesh(g, material);
    m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false;
    return m;
  }
  const rotX = (a) => (p) => [p[0], p[1] * Math.cos(a) - p[2] * Math.sin(a), p[1] * Math.sin(a) + p[2] * Math.cos(a)];
  const rotY = (a) => (p) => [p[0] * Math.cos(a) + p[2] * Math.sin(a), p[1], -p[0] * Math.sin(a) + p[2] * Math.cos(a)];

  const GREEN = '#3fae4a', GREEN_DARK = '#2b8a46', GREEN_LIGHT = '#69c85e', TEAL = '#2f8f70';
  function buildCreature() {
    const mat = new K.Lambert({ vertexColors: true });
    const G = () => new K.Object3D();
    const root = G(), hips = G(), body = G();
    root.add(hips); hips.add(body);
    const LEG = 0.15;                                     // hip height (unit size)
    hips.position.y = LEG;

    // body: a big egg, widest low down, with darker teal patches in the lower half
    const b = shapes();
    b.colour(GREEN, 0.14, TEAL); b.ellipsoid([0, 0.36, 0], [0.38, 0.44, 0.34], 32, 0.16);   // green, darker teal towards the bottom
    b.colour(GREEN_LIGHT, 0.1); b.ellipsoid([0, 0.63, 0.07], [0.26, 0.19, 0.25], 24);     // lighter face area
    // shaggy tufts all over (cones pointing outwards and a little down), wild ones on top
    for (let k = 0; k < 110; k++) {                                  // shaggy tufts, hanging down
      const th = Math.acos(1 - Math.random() * 1.8), ph = Math.random() * Math.PI * 2;
      const n = [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)];
      if (n[2] > 0.45 && n[1] > -0.25 && n[1] < 0.8) continue;    // keep the face and belly front smooth
      const p = [n[0] * 0.355, 0.36 + n[1] * 0.41, n[2] * 0.315];
      const y = p[1];
      b.colour(y < 0.35 ? (k % 2 ? TEAL : GREEN_DARK) : (k % 3 ? GREEN : GREEN_DARK), 0.1);
      b.cone(p, [n[0] * 0.6, n[1] * 0.4 - 1, n[2] * 0.6], rnd(0.045, 0.07), rnd(0.06, 0.1), 7);
    }
    for (let k = 0; k < 30; k++) {                                   // wild, thin hair sticking up on top
      const ph = Math.random() * Math.PI * 2, s = Math.sqrt(Math.random()) * 0.24;
      b.colour(k % 3 ? GREEN : GREEN_DARK, 0.1);
      b.cone([Math.cos(ph) * s, 0.75 + (0.24 - s) * 0.3, Math.sin(ph) * s * 0.85 - 0.04], [Math.cos(ph) * rnd(0.3, 1.1), 1, Math.sin(ph) * rnd(0.2, 0.8)], rnd(0.014, 0.026), rnd(0.06, 0.14), 5);
    }
    // eyebrow ridges, nose, smile
    b.colour(GREEN_DARK, 0.08);
    b.ellipsoid([-0.1, 0.785, 0.245], [0.07, 0.022, 0.03], 12, 0, rotX(-0.2));
    b.ellipsoid([0.11, 0.79, 0.24], [0.07, 0.022, 0.03], 12, 0, rotX(-0.2));
    b.colour('#3d3f3c', 0.05); b.ellipsoid([0.005, 0.645, 0.305], [0.032, 0.022, 0.022], 12);
    b.colour('#1f5a2c', 0.03); b.torus([0.01, 0.65, 0.255], 0.13, 0.008, 24, 6, Math.PI * 0.55, Math.PI * 1.22, rotX(-0.35));
    body.add(toMesh(b, mat));

    // eyes: white balls with a dark iris and pupil and a little shine; the iris+pupil can turn
    const eyes = [];
    for (const [x, sz] of [[-0.09, 1.08], [0.1, 1.14]]) {
      const e = shapes(); e.colour('#f4f4ef', 0.01); e.ellipsoid([0, 0, 0], [0.064 * sz, 0.07 * sz, 0.05 * sz], 24);
      const eye = toMesh(e, mat); eye.position.set(x, 0.705, 0.27); body.add(eye);
      const i = shapes(); i.colour('#3c4a25', 0.05); i.ellipsoid([0, 0, 0.042 * sz], [0.036 * sz, 0.038 * sz, 0.012], 14);
      i.colour('#0d0d0d', 0); i.ellipsoid([0, 0, 0.05 * sz], [0.021 * sz, 0.022 * sz, 0.008], 12);
      i.colour('#ffffff', 0); i.ellipsoid([0.012 * sz, 0.014 * sz, 0.056 * sz], [0.006, 0.006, 0.003], 6);
      const iris = toMesh(i, mat); eye.add(iris);
      iris.rotation.set(-0.25, 0.3, 0);                                // looking up and to the side, like in the picture
      // an eyelid (green) for blinking: closed = scaled up over the eye
      const l = shapes(); l.colour(GREEN_LIGHT, 0.06); l.ellipsoid([0, 0, 0], [0.068 * sz, 0.074 * sz, 0.054 * sz], 16);
      const lid = toMesh(l, mat); lid.scale.set(1, 0.001, 1); lid.position.y = 0.07 * sz; eye.add(lid);
      eyes.push({ eye, iris, lid, sz });
    }
    // glasses: two big round coral rims, a bridge, hinges and arms going back into the fur
    const gl = shapes(); gl.colour('#ef6a55', 0.04);
    const rims = [[-0.1, 0.71, 0.335], [0.115, 0.715, 0.33]];
    for (const c of rims) gl.torus(c, 0.112, 0.01, 44, 8);
    gl.rod([rims[0][0] + 0.105, 0.745, 0.338], [rims[1][0] - 0.105, 0.748, 0.334], 0.009, 6);   // the bridge
    for (const s of [-1, 1]) {
      const c = rims[s < 0 ? 0 : 1], hx = c[0] + s * 0.112;
      gl.ellipsoid([hx, c[1] + 0.012, c[2] - 0.005], [0.018, 0.014, 0.014], 8);              // hinge
      gl.rod([hx + s * 0.005, c[1] + 0.015, c[2] - 0.01], [s * 0.285, c[1] + 0.03, c[2] - 0.2], 0.008, 6);   // arm
    }
    body.add(toMesh(gl, mat));

    // arms: short and furry, hanging from the shoulders
    const arms = [];
    for (const s of [-1, 1]) {
      const pivot = G(); pivot.position.set(s * 0.3, 0.46, 0.04); body.add(pivot);
      const a = shapes(); a.colour(GREEN, 0.12, TEAL);
      a.ellipsoid([s * 0.04, -0.16, 0.02], [0.1, 0.21, 0.1], 18, 0.25, rotX(0.15));
      a.colour(TEAL, 0.12); a.ellipsoid([s * 0.05, -0.3, 0.06], [0.085, 0.07, 0.09], 14);         // hand
      a.colour('#2a2f2a', 0.05);
      for (let k = 0; k < 3; k++) a.cone([s * 0.05 + (k - 1) * 0.03, -0.33, 0.12], [0, -0.4, 1], 0.012, 0.03, 5);
      for (let k = 0; k < 8; k++) { a.colour(k % 2 ? GREEN_DARK : TEAL, 0.12); a.cone([s * (0.07 + Math.random() * 0.03), -0.05 - k * 0.03, rnd(-0.05, 0.08)], [s, -0.8, rnd(-0.3, 0.3)], 0.03, rnd(0.05, 0.09), 5); }
      pivot.add(toMesh(a, mat));
      arms.push({ pivot, s });
    }
    // legs: stubby, with big feet and dark claws
    const legs = [];
    for (const s of [-1, 1]) {
      const pivot = G(); pivot.position.set(s * 0.16, 0, 0.0); hips.add(pivot);
      const l = shapes(); l.colour(TEAL, 0.14);
      l.ellipsoid([0, -0.07, 0], [0.11, 0.1, 0.11], 16);
      l.colour(GREEN, 0.12); l.ellipsoid([0, -0.125, 0.045], [0.12, 0.05, 0.16], 18);          // foot
      l.colour('#232823', 0.05);
      for (let k = 0; k < 4; k++) l.ellipsoid([(k - 1.5) * 0.05, -0.15, 0.19], [0.02, 0.016, 0.022], 8);
      pivot.add(toMesh(l, mat));
      legs.push({ pivot, s });
    }
    return { root, hips, body, eyes, arms, legs, LEG };
  }

  // ---------- buildings (the solid-buildings script breaks them) ----------
  const B = () => window.scBuildings;
  function buildings() { const b = B(); return b ? b.list() : []; }
  const gone = (bd) => !B() || !B().alive(bd);
  // a punch or a step: the building is pushed over, a crack running from where it was hit
  function smash(bd, hit, dir) {
    const b = B(); if (!b) return;
    if (b.collapse(bd, { at: hit, push: dir, force: PUNCH_FORCE, spread: CRACK_SPEED })) sound('crash');
  }
  function puff(x, y, z, o) { const c = core(); if (c) c.puff(x, y, z, o); }

  // ---------- the monster ----------
  let mon = null;
  function release() {
    if (!core()) { alert('Het monster heeft het core-script nodig (savings-city-core).'); return; }
    if (!B()) { alert('Het monster heeft het gebouwen-script nodig (savings-city-buildings).'); return; }
    if (!sceneOf() || !classes()) { alert('De 3D-stad is nog niet geladen.'); return; }
    const c = buildCreature();
    c.root.scale.setScalar(MONSTER_HEIGHT);
    c.root.traverse((o) => { o.userData.scMonster = true; });
    // start just outside the city, on a random side, facing the middle
    const all = buildings();
    let x0 = -5, x1 = 5, z0 = -5, z1 = 5;
    if (all.length) { x0 = Math.min(...all.map((b) => b.x0)); x1 = Math.max(...all.map((b) => b.x1)); z0 = Math.min(...all.map((b) => b.z0)); z1 = Math.max(...all.map((b) => b.z1)); }
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, R = Math.hypot(x1 - x0, z1 - z0) / 2 + 3, a = Math.random() * Math.PI * 2;
    mon = { c, x: cx + Math.cos(a) * R, z: cz + Math.sin(a) * R, yaw: 0, phase: 0, state: 'walk', target: null, t: 0, arm: 0, blink: 2, look: [0, 0], lastStep: 0, alarmAt: 0, shake: 0 };
    mon.yaw = Math.atan2(cx - mon.x, cz - mon.z);
    sceneOf().add(c.root);
    sound('roar');
    if (!looping) { looping = true; last = 0; requestAnimationFrame(loop); }
    updateButton();
  }
  function sendAway() {
    if (!mon) return;
    mon.c.root.removeFromParent();
    mon = null;
    const el = core() && core().renderer && core().renderer.domElement; if (el) el.style.transform = '';
    updateButton();
  }

  // the closest point of a building to (x, z), and how far that is
  const closest = (bd, x, z) => { const px = Math.max(bd.x0, Math.min(bd.x1, x)), pz = Math.max(bd.z0, Math.min(bd.z1, z)); return { px, pz, d: Math.hypot(px - x, pz - z) }; };
  const REACH = () => MONSTER_HEIGHT * 0.5;           // from its middle to where its fist lands

  // anything it walks into is trampled: collapses, pushed the way it walks
  let nearList = [], nearAt = -1e9;
  function trample(now) {
    if (now - nearAt > 800) { nearAt = now; nearList = buildings(); }
    const body = MONSTER_HEIGHT * 0.3;
    for (const bd of nearList) {
      if (gone(bd) || bd === mon.target) continue;
      const cp = closest(bd, mon.x, mon.z);
      if (cp.d > body) continue;
      const dx = bd.cx - mon.x, dz = bd.cz - mon.z, l = Math.hypot(dx, dz) || 1;
      try { smash(bd, [cp.px, 0.15, cp.pz], [(dx / l + Math.sin(mon.yaw)) / 2, 0, (dz / l + Math.cos(mon.yaw)) / 2]); } catch (e) { console.warn('[monster] trample', e); }
      mon.shake = Math.max(mon.shake, SHAKE * 1.5);
    }
  }

  function think(dt) {
    const m = mon;
    if (m.state === 'walk' || m.state === 'idle') {
      if (!m.target || gone(m.target)) {
        const all = buildings();
        m.target = all.length ? all.reduce((best, b) => (closest(b, m.x, m.z).d < closest(best, m.x, m.z).d ? b : best)) : null;
        m.state = m.target ? 'walk' : 'idle';
      }
      if (m.state === 'idle') { m.speed = 0; return; }
      const cp = closest(m.target, m.x, m.z);
      const want = Math.atan2(cp.px - m.x, cp.pz - m.z);
      let dy = want - m.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      m.yaw += Math.max(-TURN_SPEED * dt, Math.min(TURN_SPEED * dt, dy));
      if (cp.d <= REACH() && Math.abs(dy) < 0.35) { m.state = 'punch'; m.t = 0; m.arm = 1 - m.arm; m.speed = 0; m.hitDone = false; return; }
      m.speed = WALK_SPEED * (Math.abs(dy) < 0.8 ? 1 : 0.3);
      // don't walk into the building: stop at arm's length
      const step = Math.min(m.speed * dt, Math.max(0, cp.d - REACH() * 0.9));
      m.x += Math.sin(m.yaw) * step; m.z += Math.cos(m.yaw) * step;
      m.phase += step / (MONSTER_HEIGHT * 0.22) * Math.PI;
    } else if (m.state === 'punch') {
      m.t += dt;
      if (!m.hitDone && m.t >= 0.62) {
        m.hitDone = true;
        const bd = m.target;
        if (bd && !gone(bd)) {
          const cp = closest(bd, m.x, m.z), hy = Math.min(bd.top * 0.8, MONSTER_HEIGHT * 0.5);
          const dx = bd.cx - m.x, dz = bd.cz - m.z, l = Math.hypot(dx, dz) || 1;
          try { smash(bd, [cp.px, hy, cp.pz], [dx / l, 0, dz / l]); } catch (e) { console.warn('[monster] collapse', e); }
          m.shake = Math.max(m.shake, SHAKE * 2.2);
        }
      }
      if (m.t > 1.4) { m.state = 'walk'; m.target = null; }
    }
  }

  function animate(dt) {
    const m = mon, c = m.c;
    c.root.position.set(m.x, 0.03, m.z);
    c.root.rotation.y = m.yaw;
    const walking = m.state === 'walk' && m.speed > 0.01;
    const s = Math.sin(m.phase), amp = walking ? 1 : 0;
    // legs swing, body bobs and rolls from foot to foot
    m.legAmp = (m.legAmp || 0) + (amp - (m.legAmp || 0)) * Math.min(1, dt * 5);
    c.legs[0].pivot.rotation.x = 0.55 * s * m.legAmp; c.legs[1].pivot.rotation.x = -0.55 * s * m.legAmp;
    c.hips.position.y = c.LEG + Math.abs(Math.cos(m.phase)) * 0.025 * m.legAmp;
    c.body.rotation.z = s * 0.07 * m.legAmp;
    let lean = 0.04 * m.legAmp;
    // arms: swing while walking; a punch: wind back, swing forward fast, recover
    const swing = 0.35 * s * m.legAmp;
    let a0 = -swing, a1 = swing, tw = 0, side0 = 0, side1 = 0;
    if (m.state === 'punch') {
      const t = m.t;
      const p = t < 0.45 ? -(t / 0.45) * 0.9 : t < 0.65 ? -0.9 + ((t - 0.45) / 0.2) * 2.6 : 1.7 * Math.max(0, 1 - (t - 0.65) / 0.75);
      const ang = -p * 1.1;                                       // forward = negative x rotation
      if (m.arm === 0) { a0 = ang; side0 = -0.35 * clamp01(p); } else { a1 = ang; side1 = 0.35 * clamp01(p); }
      tw = (m.arm === 0 ? -1 : 1) * 0.25 * (t < 0.45 ? -t / 0.45 : t < 0.65 ? -1 + (t - 0.45) / 0.2 * 2 : Math.max(0, 1 - (t - 0.65) / 0.75));
      lean = 0.1 * clamp01(p);
    }
    c.arms[0].pivot.rotation.set(a0, 0, side0); c.arms[1].pivot.rotation.set(a1, 0, side1);
    c.body.rotation.y = tw; c.body.rotation.x = lean;
    // blinking and looking at the target
    m.blink -= dt;
    const closed = m.blink < 0.12 && m.blink > 0 ? 1 : 0;
    if (m.blink <= 0) m.blink = rnd(2.5, 6);
    let lookY = 0.3, lookX = -0.25;
    if (m.target) { const a = Math.atan2(m.target.cx - m.x, m.target.cz - m.z) - m.yaw; lookY = Math.max(-0.5, Math.min(0.5, Math.atan2(Math.sin(a), Math.cos(a)))); lookX = -0.15; }
    m.look[0] += (lookX - m.look[0]) * Math.min(1, dt * 4); m.look[1] += (lookY - m.look[1]) * Math.min(1, dt * 4);
    for (const e of c.eyes) {
      e.iris.rotation.set(m.look[0], m.look[1], 0);
      e.lid.scale.y = closed ? 1 : 0.001; e.lid.position.y = closed ? 0 : 0.07 * e.sz;
    }
    // footsteps: when a foot comes down
    const footDown = Math.floor(m.phase / Math.PI);
    if (footDown !== m.lastStep) {
      m.lastStep = footDown;
      const leg = c.legs[footDown % 2 ? 0 : 1];
      leg.pivot.updateWorldMatrix(true, false);
      const e = leg.pivot.matrixWorld.elements;
      stomp(e[12] + e[8] * 0.05 * MONSTER_HEIGHT, e[14] + e[10] * 0.05 * MONSTER_HEIGHT);
    }
  }

  function stomp(x, z) {
    mon.shake = Math.max(mon.shake, SHAKE);
    sound('stomp');
    for (let k = 0; k < 6; k++) { const a = Math.random() * Math.PI * 2; puff(x + Math.cos(a) * 0.15, 0.05, z + Math.sin(a) * 0.15, { vx: Math.cos(a) * 0.4, vy: 0.05, vz: Math.sin(a) * 0.4, size: rnd(0.08, 0.14), life: rnd(1, 2) }); }
    const foot = MONSTER_HEIGHT * 0.1;
    const res = window.scResidents;
    if (res) {
      if (res.gibAround) res.gibAround(x, z, foot, 0.5);           // squashed
      if (res.blast) res.blast(x, z, foot * 2.2, 0, 0);             // knocked over
    }
    // cars underfoot: flattened
    const trafficCars = core().traffic();
    if (trafficCars) {
      let proxies = null;
      trafficCars.forEach((car, i) => {
        if (car.scFlat || Math.hypot(car.x - x, car.z - z) > foot * 1.3) return;
        if (!proxies) { proxies = new Map(); sceneOf().traverse((o) => { const cc = o.userData && o.userData.car; if (cc && typeof cc.index === 'number') proxies.set(cc.index, o); }); }
        car.scFlat = true; car.parked = Infinity; car.speed = 0;
        const p = proxies.get(i); if (p) p.scale.set(1.15, 0.22, 1.2);
      });
    }
  }

  function stepShake(dt) {
    const el = core() && core().renderer && core().renderer.domElement; if (!el || !mon) return;
    mon.shake *= Math.exp(-6 * dt);
    const a = mon.shake;
    if (a < 0.3) { el.style.transform = ''; return; }
    el.style.transform = `translate(${((Math.random() * 2 - 1) * a).toFixed(1)}px, ${((Math.random() * 2 - 1) * a).toFixed(1)}px)`;
  }

  // ---------- loop ----------
  let looping = false, last = 0, lastCheck = 0;
  function loop(t) {
    requestAnimationFrame(loop);
    const dt = Math.min(0.05, last ? (t - last) / 1000 : 0); last = t;
    const safe = (name, fn) => { try { fn(); } catch (e) { if (!loop.warned) loop.warned = {}; if (!loop.warned[name]) { loop.warned[name] = 1; console.warn('[monster] ' + name, e); } } };
    if (mon) {
      safe('think', () => think(dt));
      safe('trample', () => trample(t));
      safe('animate', () => animate(dt));
      safe('shake', () => stepShake(dt));
      if (t - mon.alarmAt > 2000) { mon.alarmAt = t; const r = window.scResidents; if (r && r.alarm) r.alarm(mon.x, mon.z, MONSTER_HEIGHT * 2.5, 8); }
    }
  }

  // ---------- sound ----------
  let audio = null;
  function sound(kind) {
    if (!SOUND) return;
    try {
      audio = audio || new AudioContext();
      const a = audio, t = a.currentTime, g = a.createGain(); g.connect(out(a));
      if (kind === 'stomp') {
        const o = a.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(70, t); o.frequency.exponentialRampToValueAtTime(30, t + 0.35);
        g.gain.setValueAtTime(0.7, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.4); o.connect(g); o.start(t); o.stop(t + 0.45);
      } else if (kind === 'crash') {
        const len = 2.2, buf = a.createBuffer(1, Math.floor(a.sampleRate * len), a.sampleRate), ch = buf.getChannelData(0);
        for (let i = 0; i < ch.length; i++) { const x = i / ch.length; ch[i] = (Math.random() * 2 - 1) * (1 - x) ** 1.5 * (0.6 + 0.4 * Math.sin(x * 90) ** 2); }
        const src = a.createBufferSource(), f = a.createBiquadFilter(); f.type = 'lowpass'; f.frequency.setValueAtTime(1800, t); f.frequency.exponentialRampToValueAtTime(200, t + len);
        src.buffer = buf; src.connect(f); f.connect(g); g.gain.setValueAtTime(0.8, t); src.start(t);
      } else if (kind === 'roar') {
        const o = a.createOscillator(), o2 = a.createOscillator(), f = a.createBiquadFilter(); o.type = 'sawtooth'; o2.type = 'sawtooth';
        o.frequency.setValueAtTime(90, t); o.frequency.linearRampToValueAtTime(140, t + 0.5); o.frequency.linearRampToValueAtTime(70, t + 1.8);
        o2.frequency.setValueAtTime(93, t); o2.frequency.linearRampToValueAtTime(137, t + 0.5); o2.frequency.linearRampToValueAtTime(72, t + 1.8);
        f.type = 'lowpass'; f.frequency.value = 700; o.connect(f); o2.connect(f); f.connect(g);
        g.gain.setValueAtTime(0.001, t); g.gain.exponentialRampToValueAtTime(0.35, t + 0.25); g.gain.exponentialRampToValueAtTime(0.001, t + 2);
        o.start(t); o2.start(t); o.stop(t + 2); o2.stop(t + 2);
      }
    } catch {}
  }

  // ---------- button ----------
  const SVG = 'xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="g-ico" aria-hidden="true"';
  const ICON = `<svg ${SVG}><path d="M12 3c4.5 0 7 3.5 7 8v8a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-8c0-4.5 2.5-8 7-8z"/><circle cx="9" cy="10" r="2.2"/><circle cx="15" cy="10" r="2.2"/><path d="M11.2 10h1.6"/><path d="M9.5 15.5c1.5 1 3.5 1 5 0"/></svg>`;
  function updateButton() {
    const b = document.getElementById('sc-monster'); if (!b) return;
    const label = mon ? 'Monster wegsturen' : 'Monster loslaten';
    b.title = label; b.setAttribute('aria-label', label);
    b.style.color = mon ? '#2b8a46' : '';
  }
  function ensureButton() {
    if (document.getElementById('sc-monster')) return;
    const row = document.querySelector('.hz-tr .menu-mini'); if (!row) return;
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'icon-btn small'; b.id = 'sc-monster';
    b.innerHTML = '<b class="s-bg"></b>' + ICON;
    b.addEventListener('click', () => { try { audio = audio || new AudioContext(); } catch {} if (mon) sendAway(); else release(); });
    row.appendChild(b);
    updateButton();
  }
  const start = () => { ensureButton(); new MutationObserver(ensureButton).observe(document.body, { childList: true, subtree: true }); };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
