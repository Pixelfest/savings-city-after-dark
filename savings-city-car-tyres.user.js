// ==UserScript==
// @name         Savings City – car tyres (wider, optionally round)
// @namespace    savings-city-tweaks
// @version      1.3
// @description  Makes car tyres stick out slightly from the car body (no more flicker) and optionally round.
// @match        https://your-savings-city-host.example/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * Why it flickers
 * ---------------
 * In the app's car model the body is 0.105 wide (z from -0.0525 to +0.0525), and each tyre is a
 * box 0.044 × 0.04 × 0.016 whose outer face is at exactly the same z = ±0.0525. Two surfaces in
 * the same plane fight over which one is drawn ("z-fighting").
 *
 * The fix
 * -------
 * three.js creates every shape through BufferGeometry. When the first shape is made, this script
 * finds BufferGeometry's prototype (via a one-time setter trap on the "isBufferGeometry" flag that
 * three.js sets in its constructor) and wraps translate(). When a box with the exact tyre size is
 * moved to a tyre position, it is first made TYRE_OUT wider on its outer side. This happens before
 * the car models are built and cached, so driving and parked cars all get the fix.
 */
(function () {
  'use strict';

  const TYRE_OUT = 0.005;      // how far tyres stick out from the body (car is 0.105 wide)
  const ROUND_TYRES = true;    // true = round tyres (cylinders), false = the original square blocks
  const TYRE_SEGMENTS = 12;    // roundness: more = smoother circle, 8 = chunky low-poly look

  const TYRE = { w: 0.044, h: 0.04, d: 0.016 };
  const TYRE_Z = 0.0445;       // centre of a tyre box: ±(0.105/2 − 0.016/2)
  const near = (a, b) => Math.abs(a - b) < 1e-4;

  function patch(proto) {
    const orig = proto.translate;
    proto.translate = function (x, y, z) {
      const p = this.parameters;
      if (p && near(p.width, TYRE.w) && near(p.height, TYRE.h) && near(p.depth, TYRE.d) && near(Math.abs(z), TYRE_Z) && !this.userData.scTyre) {
        this.userData.scTyre = true;
        if (ROUND_TYRES) makeRound(this, TYRE.h / 2, TYRE.d + TYRE_OUT);
        else this.scale(1, 1, (TYRE.d + TYRE_OUT) / TYRE.d);   // still centred: grows equally both ways…
        z += Math.sign(z) * TYRE_OUT / 2;                       // …then shift so only the outer side grows
      }
      return orig.call(this, x, y, z);
    };
  }

  // Turns the (still centred) tyre box into a cylinder lying along z, same height (touches the
  // ground, same axle height). Built by hand so no extra three.js classes are needed.
  function makeRound(geo, r, len) {
    const { pos, nor } = cylinder(r, len);
    const Attr = geo.attributes.position.constructor;                     // three's BufferAttribute
    for (const k of Object.keys(geo.attributes)) geo.deleteAttribute(k);
    geo.setIndex(null);
    geo.setAttribute('position', new Attr(new Float32Array(pos), 3));
    geo.setAttribute('normal', new Attr(new Float32Array(nor), 3));
    geo.clearGroups();
    geo.boundingBox = geo.boundingSphere = null;
  }
  // a cylinder lying along z, centred on the origin
  function cylinder(r, len) {
    const n = TYRE_SEGMENTS, z0 = -len / 2, z1 = len / 2;
    const pos = [], nor = [];
    const tri = (a, b, c, na, nb, nc) => { pos.push(...a, ...b, ...c); nor.push(...na, ...nb, ...nc); };
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
      const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
      const p0 = [r * c0, r * s0, z0], p1 = [r * c1, r * s1, z0], p2 = [r * c1, r * s1, z1], p3 = [r * c0, r * s0, z1];
      const n0 = [c0, s0, 0], n1 = [c1, s1, 0];
      tri(p0, p1, p2, n0, n1, n1); tri(p0, p2, p3, n0, n1, n0);            // tread (smooth)
      tri([0, 0, z1], p3, p2, [0, 0, 1], [0, 0, 1], [0, 0, 1]);           // outer side wall
      tri([0, 0, z0], p1, p0, [0, 0, -1], [0, 0, -1], [0, 0, -1]);        // inner side wall
    }
    return { pos, nor };
  }

  // ---- Route 2: repair car models that were built without the fix ----
  // If route 1 (below) did not get in first (another script's hook, an older version of this
  // script, a changed load order), the cars are built with flat tyres. Every two seconds the car
  // models in the scene are checked; the dark tyre blocks of any unfixed model are replaced by
  // wider (round) tyres in place. All cars of that model share the geometry, so they all change.
  const TYRE_RGB = (() => { const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }; return [lin(0x2a), lin(0x2a), lin(0x2e)]; })();
  let scene = null, repaired = 0;
  const hook = window.__THREE_DEVTOOLS__ || (window.__THREE_DEVTOOLS__ = new EventTarget());
  hook.addEventListener('observe', (e) => {
    const r = e.detail;
    if (!r || !r.isWebGLRenderer || r.__scTyres) return;
    r.__scTyres = true;
    const orig = r.render;
    r.render = function (sc, cam) { if (!scene && sc && sc.isScene) scene = sc; return orig.apply(this, arguments); };
  });
  const checked = new WeakSet();
  setInterval(() => {
    if (!scene) return;
    scene.traverse((o) => {
      const isCar = (o.isInstancedMesh && Array.isArray(o.userData.cars)) || (o.userData && o.userData.car);
      if (!isCar || !o.geometry || checked.has(o.geometry)) return;
      checked.add(o.geometry);
      try { if (repair(o.geometry)) { repaired++; console.info('[car tyres] repaired car model', repaired, '(built without the fix)'); } } catch (e) { console.warn('[car tyres] repair failed', e); }
    });
  }, 2000);

  function repair(geo) {
    const pos = geo.attributes.position, col = geo.attributes.color;
    if (!pos || !col || geo.index) return false;
    const isTyre = (i) => Math.abs(col.getX(i) - TYRE_RGB[0]) < 0.004 && Math.abs(col.getY(i) - TYRE_RGB[1]) < 0.004 && Math.abs(col.getZ(i) - TYRE_RGB[2]) < 0.004 && pos.getY(i) < 0.045;
    const tyres = new Map();                                    // "sx,sz" → triangle starts
    let fixed = false;
    for (let i = 0; i + 2 < pos.count; i += 3) {
      if (!(isTyre(i) && isTyre(i + 1) && isTyre(i + 2))) continue;
      const cx = (pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3, cz = (pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2)) / 3;
      for (let v = i; v < i + 3; v++) if (Math.abs(pos.getZ(v)) > 0.0525 + 1e-4) fixed = true;   // sticks out already: fixed
      const k = Math.sign(cx) + ',' + Math.sign(cz);
      (tyres.get(k) || tyres.set(k, []).get(k)).push(i);
    }
    if (fixed || tyres.size !== 4) return false;
    const drop = new Set(), extra = [];
    for (const list of tyres.values()) {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const i of list) for (let v = i; v < i + 3; v++) {
        drop.add(v);
        x0 = Math.min(x0, pos.getX(v)); x1 = Math.max(x1, pos.getX(v)); y0 = Math.min(y0, pos.getY(v)); y1 = Math.max(y1, pos.getY(v)); z0 = Math.min(z0, pos.getZ(v)); z1 = Math.max(z1, pos.getZ(v));
      }
      const out = Math.sign(z0 + z1), len = z1 - z0 + TYRE_OUT, cz = (z0 + z1) / 2 + out * TYRE_OUT / 2;
      const t = ROUND_TYRES ? cylinder((y1 - y0) / 2, len) : block(x1 - x0, y1 - y0, len);
      for (let v = 0; v < t.pos.length; v += 3) extra.push([t.pos[v] + (x0 + x1) / 2, t.pos[v + 1] + (y0 + y1) / 2, t.pos[v + 2] + cz, t.nor[v], t.nor[v + 1], t.nor[v + 2]]);
    }
    // new attribute arrays: everything that isn't a tyre, then the new tyres
    const keep = pos.count - drop.size, n = keep + extra.length, Attr = pos.constructor;
    const names = Object.keys(geo.attributes), arrays = {};
    for (const name of names) arrays[name] = new Float32Array(n * geo.attributes[name].itemSize);
    let k = 0;
    for (let v = 0; v < pos.count; v++) {
      if (drop.has(v)) continue;
      for (const name of names) { const a = geo.attributes[name], w = a.itemSize; for (let c = 0; c < w; c++) arrays[name][k * w + c] = a.array[v * w + c]; }
      k++;
    }
    for (const e of extra) {
      arrays.position.set(e.slice(0, 3), k * 3);
      if (arrays.normal) arrays.normal.set(e.slice(3), k * 3);
      arrays.color.set(TYRE_RGB, k * 3);
      k++;                                                      // other attributes (uv …) stay 0
    }
    for (const name of names) geo.setAttribute(name, new Attr(arrays[name], geo.attributes[name].itemSize));
    geo.boundingBox = geo.boundingSphere = null;
    return true;
  }
  function block(w, h, d) {
    const x = w / 2, y = h / 2, z = d / 2, pos = [], nor = [];
    const quad = (a, b, c, e, n) => { for (const v of [a, b, c, a, c, e]) { pos.push(...v); nor.push(...n); } };
    quad([-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z], [0, 0, 1]); quad([x, -y, -z], [-x, -y, -z], [-x, y, -z], [x, y, -z], [0, 0, -1]);
    quad([x, -y, z], [x, -y, -z], [x, y, -z], [x, y, z], [1, 0, 0]); quad([-x, -y, -z], [-x, -y, z], [-x, y, z], [-x, y, -z], [-1, 0, 0]);
    quad([-x, y, z], [x, y, z], [x, y, -z], [-x, y, -z], [0, 1, 0]); quad([-x, -y, -z], [x, -y, -z], [x, -y, z], [-x, -y, z], [0, -1, 0]);
    return { pos, nor };
  }

  // ---- Route 1: fix the tyres while the car models are being built ----
  // One-time trap: the first `this.isBufferGeometry = true` reveals BufferGeometry.prototype.
  // If another script (walk mode) already set the same trap, chain it so both run.
  const KEY = 'isBufferGeometry';
  const prev = Object.getOwnPropertyDescriptor(Object.prototype, KEY);
  if (prev && !prev.set) return;                        // (route 2 still repairs the cars)
  Object.defineProperty(Object.prototype, KEY, {
    configurable: true,
    set(v) {
      if (prev) prev.set.call(this, v);
      delete Object.prototype[KEY];                       // remove the trap straight away
      if (!Object.prototype.hasOwnProperty.call(this, KEY)) Object.defineProperty(this, KEY, { value: v, writable: true, enumerable: true, configurable: true });
      let p = Object.getPrototypeOf(this);
      while (p && !Object.prototype.hasOwnProperty.call(p, 'translate')) p = Object.getPrototypeOf(p);
      if (p) { patch(p); console.info('[car tyres] fixing tyres while cars are built'); } else console.warn('[car tyres] BufferGeometry.translate not found');
    },
  });
})();
