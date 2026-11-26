/*
 * Savings City – pedestrians (base)
 * ---------------------------------
 * A proposal for the app itself: little figures that walk the sidewalks of the city, cross the
 * road at junctions only when no car is coming, keep out of the way of each other, go in and out
 * of front doors now and then, walk with a child now and then, and pause for a moment at times.
 *
 * Not in here, on purpose: anything violent or gory. Nobody gets hurt, knocked down, shot or run
 * over; there is no blood and no fire, no screams and no sound. This file is the calm base only.
 *
 * Standalone: it needs nothing else (no core script, no Tampermonkey header). It is a plain script
 * that runs at document-start, before the app. It finds what it needs by itself:
 *   - the scene: the first render with an orthographic camera (through three.js' devtools hook,
 *     window.__THREE_DEVTOOLS__, which it creates if it isn't there yet);
 *   - the city data: the /api/city response (Response.prototype.json is wrapped);
 *   - the traffic cars: the list the app loops over with forEach (Array.prototype.forEach is
 *     wrapped, the same trick the scripts use for the drive and walk modes);
 *   - the front doors: two of the app's own helpers, found by the shape of their code in the
 *     main module (its export names change with every build, so they are found by their code).
 *   - three.js classes: borrowed from objects already in the scene (no second copy of three.js).
 * When it is merged into the app itself, those hooks can be replaced by direct access to the
 * app's own state (scene, city, traffic, helpers); the walking code does not change.
 *
 * How it works
 * ------------
 * - Roads lie on the lines between tiles: asphalt within 0.16 of the line, sidewalk from 0.16 to
 *   0.25. People walk along the road lines, SIDEWALK_OFFSET to one side. At a corner they walk to
 *   the corner of the sidewalk and on from there, so the only time they stand on the asphalt is a
 *   real crossing, straight across.
 * - At every junction they pick a way on (only turning back at a dead end) and which side of that
 *   street to take: normally the one that needs the fewest crossings, now and then (CROSS_CHANCE)
 *   the other one. Decided once, in advance, so nobody turns back halfway.
 * - Traffic: before stepping onto the road a person looks at the moving cars. If one would reach
 *   the crossing while they are on it (with CROSSING_MARGIN to spare), they wait on the kerb.
 * - Highways (drawn as wider asphalt, 0.48 across, without sidewalks) are never walked on: no path
 *   along them, no door onto them, and no road that runs into one. Found from the drawn road boxes,
 *   once a second, because the app redraws its roads after a change.
 * - Passing: someone close in front on the sidewalk makes room (both step to their right when
 *   coming towards each other), someone standing still or walking the same way is queued behind.
 * - Front doors come from the app's own code (exact door position per building). Walking past a
 *   door on that side of the street, a person sometimes goes in, stays inside for a while, and
 *   later comes out of some (other) door.
 * - Children: smaller bodies that walk right beside an adult and follow them everywhere (in and
 *   out of buildings too).
 * - Wandering: now and then someone stops for a second or more on the pavement (never on the
 *   road), and everyone walks at a slightly different pace.
 * - Figures: four instanced meshes (trousers, shirt, head, hair): a few thousand people cost four
 *   draw calls. Every person has their own colour combination (seeded, the same after a reload).
 *   No animation: they are static shapes that glide.
 *
 * Exposes window.scPedestrians = { people (the live list, read-only), count }.
 */
(function () {
  'use strict';
  if (window.scPedestrians) return;                              // loaded twice: the first one wins

  // ---------- settings ----------
  const PER_ROAD = 2;             // people per road tile
  const MAX_PEOPLE = 4000;
  const SPEED = 0.15;             // tiles per second (cars drive about 1–2)
  const SPEED_VARIATION = 0.35;   // ±35 %
  const PAUSE_CHANCE = 0.03;      // per second on the pavement: chance to stop for a moment
  const PAUSE_SECONDS = [1, 4];   // how long that stop lasts
  const SIDEWALK_OFFSET = 0.205;  // distance from the road line (middle of the sidewalk)
  const CROSS_CHANCE = 0.2;       // at a corner: chance to take the far side of the next street
  const PASS_SHIFT = 0.022;       // how far people step aside to pass each other (the sidewalk is 0.09 wide)
  const PASS_LOOKAHEAD = 0.12;    // they start stepping aside when someone is this close in front
  const CHILD_SHARE = 0.18;       // share of adults walking with a child
  const CHILD_HEIGHT = 0.62;      // a child's body is this much of an adult's (the head stays the same size)
  const CHILD_WIDTH = 0.78;
  const CHILD_GAP = 0.03;         // how far beside the parent (on the building side)
  const SIDEWALK_HEIGHT = 0.036;  // the sidewalks are blocks this high: people stand on top
  const ASPHALT = 0.16;           // the asphalt reaches this far from the road line
  const ASPHALT_HEIGHT = 0.04;    // top of the road surface
  const HIGHWAY_WIDTH = 0.48;     // highway boxes are this wide (normal roads 0.32, with sidewalks)
  const CROSSING_MARGIN = 0.5;    // seconds of extra room they keep from cars when crossing
  const ENTER_CHANCE = 0.25;      // chance to go in when passing a front door on that side
  const INSIDE_SECONDS = [8, 45]; // how long someone stays inside
  const START_INSIDE = 0.2;       // share of people that start inside a building
  const SCALE = 1;                // size of the figures
  const SHIRTS = ['#e25d5d', '#4f8fd8', '#f0a24a', '#7bc77b', '#f2f2f2', '#9b6fd8', '#f6e46f', '#3cb7b0',
                  '#555b66', '#d87bb0', '#2f3a56', '#a8423f', '#6f8f4e', '#c9b38a', '#1f1f24', '#8fb8de'];
  const TROUSERS = ['#2f4a7a', '#3b5d94', '#1f2a44', '#26262b', '#5a5d66', '#8b7d62', '#6b4f3a', '#3e4a3a', '#a9a196'];
  // Realistic skin tones, light to dark. Each has the hair colours that suit it, with weights.
  const SKINS = [
    { c: '#f6dcc6', hair: { '#e6c77a': 3, '#b08a4f': 3, '#6b4a2e': 3, '#a0522d': 1, '#2b1d14': 1, '#c9c6c2': 1 } },
    { c: '#eec4a2', hair: { '#b08a4f': 2, '#6b4a2e': 4, '#3d2a1c': 3, '#e6c77a': 1, '#a0522d': 1, '#c9c6c2': 1 } },
    { c: '#dba97f', hair: { '#3d2a1c': 4, '#2b1d14': 4, '#6b4a2e': 2, '#c9c6c2': 1 } },
    { c: '#c68e63', hair: { '#2b1d14': 6, '#3d2a1c': 3, '#1c1410': 2 } },
    { c: '#a8714b', hair: { '#1c1410': 6, '#2b1d14': 3 } },
    { c: '#7d4f33', hair: { '#1c1410': 7, '#2b1d14': 2 } },
  ];
  const BALD = 0.07;              // share of people without hair
  const LEG = 0.048, TORSO = 0.055, HEAD = 0.022, HEAD_Y = LEG + TORSO + 0.002;   // body sizes (tiles)
  const PASS_CELL = 0.25;         // crowd grid cell (tiles)

  // ---------- the scene, city data, traffic and the app's helpers ----------
  let scene = null, trafficCars = null;
  let city = null, cityVersion = 0, appHelpers = null, helpersArrived = false;

  // Scene: the first render with an orthographic camera (the app's view).
  const hook = window.__THREE_DEVTOOLS__ || (window.__THREE_DEVTOOLS__ = new EventTarget());
  hook.addEventListener('observe', (e) => {
    const o = e.detail;
    if (!o || !o.isWebGLRenderer || o.__scPedestrians) return;
    o.__scPedestrians = true;
    const render = o.render;
    o.render = function (s, c) {
      if (!scene && s && s.isScene && c && c.isOrthographicCamera) scene = s;
      return render.call(this, s, c);
    };
  });

  // City data: every /api/city response the app reads.
  const origJson = Response.prototype.json;
  Response.prototype.json = async function () {
    const d = await origJson.apply(this, arguments);
    if (d && Array.isArray(d.projects) && Array.isArray(d.roads)) {
      city = d; cityVersion++;
      if (!helpersPromise) helpersPromise = loadAppHelpers();
    }
    return d;
  };

  // Traffic: the app's car list (objects with base, heading, from, to, x, z, speed …), revealed by
  // the first forEach over it.
  const origForEach = Array.prototype.forEach;
  Array.prototype.forEach = function () {
    if (this !== trafficCars && this.length) {
      const c = this[0];
      if (c && typeof c === 'object' && typeof c.base === 'number' && typeof c.heading === 'number' && 'from' in c && 'to' in c) trafficCars = this;
    }
    return origForEach.apply(this, arguments);
  };

  // The app's helpers: the main module is imported again (the same URL gives the loaded instance).
  // Its export names are minified and change with every build, so they are found by their code:
  //   v = placed projects → [{ id, fp, gx, gy, facing }]
  //   a = front-door road keys (gx, gy, footprint, facing)
  let helpersPromise = null;
  function loadAppHelpers() {
    const s = [...document.querySelectorAll('script[type="module"][src]')].find((x) => /\/index-[^/]*\.js/.test(x.src));
    if (!s) return Promise.reject(new Error('main module not found'));
    return import(s.src).then((m) => {
      const fns = Object.values(m).filter((f) => typeof f === 'function');
      const code = (f) => { try { return Function.prototype.toString.call(f); } catch { return ''; } };
      const find = (re) => fns.find((f) => re.test(code(f)));
      const h = {
        v: find(/\.filter\(\w+\)\.map\(\w+=>\(\{id:\w+\.id,fp:/),
        a: find(/^function\s*\w*\(\w+,\w+,\w+,\w+\)\{\w+=\w+\(\w+,\w+\);let \w+=\[\];for\(let\[\w+,\w+\]of /),
      };
      if (typeof h.v !== 'function' || typeof h.a !== 'function') throw new Error('app internals changed (new build?)');
      appHelpers = h;
      helpersArrived = true;
    }).catch((e) => { console.warn('[pedestrians] no front doors:', e); helpersArrived = true; });
  }

  // ---------- road network ----------
  const tk = (x, y) => x + ',' + y;
  const NORMALS = [[0, -1], [1, 0], [0, 1], [-1, 0]];   // door facing 0=N 1=E 2=S 3=W → outward
  let net = null;                                       // { adj, xy, edges, doors, doorList, cells }
  let hwSig = null, hwCheckedAt = -Infinity;            // which roads are highways (rechecked each second)

  // Highway boxes: 1 long and 0.48 wide, at asphalt height. Nobody walks on them.
  function highwayKeys() {
    const out = new Set();
    if (!scene) return out;
    const near = (v, t) => Math.abs(v - t) < 0.002;
    scene.traverse((o) => {
      if (!o.isInstancedMesh || !o.instanceMatrix) return;
      const e = o.instanceMatrix.array;
      for (let i = 0; i < o.count; i++) {
        const b = i * 16;
        const sx = Math.hypot(e[b], e[b + 1], e[b + 2]), sy = Math.hypot(e[b + 4], e[b + 5], e[b + 6]), sz = Math.hypot(e[b + 8], e[b + 9], e[b + 10]);
        if (!near(sy, ASPHALT_HEIGHT)) continue;
        const cx = e[b + 12], cz = e[b + 14];                 // the box's centre: the middle of its road segment
        if (near(sx, 1) && near(sz, HIGHWAY_WIDTH)) out.add(`${Math.round(cx - 0.5)},${Math.round(cz)},h`);
        else if (near(sz, 1) && near(sx, HIGHWAY_WIDTH)) out.add(`${Math.round(cx)},${Math.round(cz - 0.5)},v`);
      }
    });
    return out;
  }

  function buildNetwork() {
    const adj = new Map(), edges = [], xy = new Map(), all = [];
    const add = (a, b) => { if (!adj.has(a)) adj.set(a, []); adj.get(a).push(b); };
    const highways = highwayKeys(), hwNodes = new Set();
    for (const k of city.roads) {
      const [x, y, t] = String(k).split(','); const X = +x, Y = +y;
      if (!Number.isFinite(X) || !Number.isFinite(Y)) continue;
      const a = tk(X, Y), b = t === 'h' ? tk(X + 1, Y) : tk(X, Y + 1);
      xy.set(a, [X, Y]); xy.set(b, t === 'h' ? [X + 1, Y] : [X, Y + 1]);
      all.push([a, b, k]);
      if (highways.has(String(k))) { hwNodes.add(a); hwNodes.add(b); }
    }
    // people walk only on the roads that don't touch a highway
    const walkKeys = new Set();
    for (const [a, b, k] of all) {
      if (highways.has(String(k)) || hwNodes.has(a) || hwNodes.has(b)) continue;
      add(a, b); add(b, a); edges.push([a, b, k]); walkKeys.add(String(k));
    }
    const doors = new Map(), doorList = [];
    if (appHelpers) {
      try {
        for (const b of appHelpers.v(city.projects)) {
          const n = NORMALS[b.facing]; if (!n) continue;
          for (const k of appHelpers.a(b.gx, b.gy, b.fp.base ?? b.fp, b.facing)) {
            if (!walkKeys.has(k)) continue;                   // no door onto a highway
            doors.set(k, n); doorList.push(k);
          }
        }
      } catch (e) { console.warn('[pedestrians] no doors:', e); }
    }
    // road segments per tile, to tell quickly whether a point is on the asphalt (highways too)
    const cells = new Map();
    for (const [a, b] of all) {
      const [ax, ay] = xy.get(a), [bx, by] = xy.get(b);
      for (let x = Math.min(ax, bx) - 1; x <= Math.max(ax, bx); x++) for (let y = Math.min(ay, by) - 1; y <= Math.max(ay, by); y++) {
        const k = tk(x, y); (cells.get(k) || cells.set(k, []).get(k)).push([ax, ay, bx, by]);
      }
    }
    net = { adj, xy, edges, doors, doorList, cells };
  }

  const edgeKeyOf = (a, b) => {                           // road key for the segment between two neighbouring nodes
    const [ax, ay] = net.xy.get(a), [bx, by] = net.xy.get(b);
    return ay === by ? `${Math.min(ax, bx)},${ay},h` : `${ax},${Math.min(ay, by)},v`;
  };
  const rightOf = (dx, dz) => [-dz, dx];                  // right-hand normal of a walking direction
  const midOf = (k) => { const [x, y, t] = k.split(','); return t === 'h' ? [+x + 0.5, +y] : [+x, +y + 0.5]; };

  // ---------- helpers ----------
  const rnd = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  // p.side = 1: to the right of the road line (seen walking a → b), −1: to the left of it
  function placeOnEdge(p, a, b, s, side) {
    p.a = a; p.b = b; p.s = s;
    const [ax, ay] = net.xy.get(a), [bx, by] = net.xy.get(b);
    p.dir = [bx - ax, by - ay];
    p.side = side || p.side || 1;
    p.planFor = null;
  }
  // which side of the road line someone walks on, as a direction (pointing away from the road)
  const sideOffset = (p) => { const r = rightOf(p.dir[0], p.dir[1]); return [r[0] * p.side, r[1] * p.side]; };
  // the point on the sidewalk line of edge (a, dir), at s along it
  function edgePoint(a, dir, side, s) {
    const [ax, ay] = net.xy.get(a), r = rightOf(dir[0], dir[1]);
    return [ax + dir[0] * s + r[0] * side * SIDEWALK_OFFSET, ay + dir[1] * s + r[1] * side * SIDEWALK_OFFSET];
  }

  // Is the point on the asphalt (not the sidewalk)?
  function onAsphalt(x, z) {
    const list = net.cells.get(tk(Math.floor(x), Math.floor(z)));
    if (!list) return false;
    for (const [ax, ay, bx, by] of list) {
      const cx = Math.max(Math.min(ax, bx), Math.min(Math.max(ax, bx), x)), cz = Math.max(Math.min(ay, by), Math.min(Math.max(ay, by), z));
      if (Math.hypot(x - cx, z - cz) < ASPHALT + 0.015) return true;
    }
    return false;
  }

  // ---------- people ----------
  let people = [];
  function newPerson() {
    return { speed: SPEED * (1 + rnd(-SPEED_VARIATION, SPEED_VARIATION)), state: 'walk', x: 0, z: 0, h: 0, lat: 0, ox: 0, oz: 0 };
  }
  // a child that walks next to adult p (and goes where p goes)
  function makeChild(p) {
    const c = { speed: p.speed, state: p.state, x: p.x, z: p.z, h: p.h, parent: p, k: CHILD_HEIGHT, cside: 1, fresh: true };
    p.child = c;
    return c;
  }

  function spawn() {
    people = [];
    if (!net.edges.length) return;
    const count = Math.min(MAX_PEOPLE, Math.round(net.edges.length * PER_ROAD));
    while (people.length < count) {
      const p = newPerson();
      const [a, b] = pick(net.edges);
      const s0 = rnd(0.25, 0.75), side = Math.random() < 0.5 ? 1 : -1;   // start on the sidewalk, not in a junction
      if (Math.random() < 0.5) placeOnEdge(p, a, b, s0, side); else placeOnEdge(p, b, a, s0, side);
      if (net.doorList.length && Math.random() < START_INSIDE) {
        p.state = 'inside'; p.timer = rnd(0, INSIDE_SECONDS[1]);
      }
      people.push(p);
      if (people.length < count && Math.random() < CHILD_SHARE) people.push(makeChild(p));
    }
  }

  // Walk into the building of door edge k (the building is on the −n side).
  function startEnter(p, k) {
    const n = net.doors.get(k), mid = midOf(k);
    p.state = 'enter';
    p.from = [p.x, p.z];
    p.to = [mid[0] - n[0] * 0.35, mid[1] - n[1] * 0.35];
    p.t = 0; p.dur = Math.hypot(p.to[0] - p.x, p.to[1] - p.z) / p.speed;
    p.h = Math.atan2(p.to[0] - p.x, p.to[1] - p.z);
  }

  // Come out of a random door, onto the sidewalk on the building's side, then walk on.
  function startExit(p) {
    const k = pick(net.doorList);
    const n = net.doors.get(k), mid = midOf(k);
    const [x, y, t] = k.split(',').map((v, i) => (i < 2 ? +v : v));
    let a = tk(x, y), b = t === 'h' ? tk(x + 1, y) : tk(x, y + 1);
    // walk the direction that keeps the building on our right
    const [ax, ay] = net.xy.get(a), [bx, by] = net.xy.get(b);
    const r = rightOf(bx - ax, by - ay);
    if (r[0] * -n[0] + r[1] * -n[1] < 0) [a, b] = [b, a];
    p.state = 'exit';
    p.side = 1;
    p.from = [mid[0] - n[0] * 0.35, mid[1] - n[1] * 0.35];
    p.to = [mid[0] - n[0] * SIDEWALK_OFFSET, mid[1] - n[1] * SIDEWALK_OFFSET];
    p.t = 0; p.dur = Math.hypot(p.to[0] - p.from[0], p.to[1] - p.from[1]) / p.speed;
    p.h = Math.atan2(n[0], n[1]);
    p.next = [a, b];
  }

  // A child next to its parent, on the building side while walking.
  function follow(c, dt) {
    const p = c.parent;
    c.state = p.state;
    if (p.state === 'inside') { c.fresh = true; return; }
    const hx = Math.sin(p.h), hz = Math.cos(p.h), r = rightOf(hx, hz);
    if (p.state === 'walk') { const o = sideOffset(p); c.cside = r[0] * o[0] + r[1] * o[1] >= 0 ? 1 : -1; }
    const tx = p.x + r[0] * c.cside * CHILD_GAP - hx * 0.006, tz = p.z + r[1] * c.cside * CHILD_GAP - hz * 0.006;
    if (c.fresh) { c.x = tx; c.z = tz; c.fresh = false; }
    else { const k = Math.min(1, dt * 10); c.x += (tx - c.x) * k; c.z += (tz - c.z) * k; }
    c.h = p.h;
  }

  const hasChild = (p) => p.child && p.child.state !== 'inside';

  // ---------- passing each other ----------
  // Everyone outside, per cell of 0.25 tiles, rebuilt every frame.
  function crowdCells() {
    const cells = new Map();
    for (let i = 0; i < people.length; i++) {
      const p = people[i];
      if (p.state === 'inside') continue;
      const k = Math.floor(p.x / PASS_CELL) + ',' + Math.floor(p.z / PASS_CELL);
      (cells.get(k) || cells.set(k, []).get(k)).push(p);
    }
    return cells;
  }
  // Someone close in front (or right beside): step aside, away from them (straight towards each
  // other: both to their own right). Next to a parent with a child there's less room, so step
  // aside further. Right behind someone who stands still (waiting, or pausing) or walks the same
  // way: wait behind them instead of walking into them (p.queue).
  function steer(p, cells, dt) {
    p.queue = false;
    if (p.state !== 'walk' || p.parent) return;
    const f = p.dir, r = rightOf(f[0], f[1]);
    const cx = Math.floor(p.x / PASS_CELL), cz = Math.floor(p.z / PASS_CELL);
    const kid = hasChild(p) ? p.child : null;
    // a parent looks out for the child beside them too
    const kidLat = kid ? (kid.x - p.x) * r[0] + (kid.z - p.z) * r[1] : 0;
    let block = null;
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const list = cells.get((cx + i) + ',' + (cz + j)); if (!list) continue;
      for (const q of list) {
        if (q === p || q === kid) continue;
        const dx = q.x - p.x, dz = q.z - p.z, along = dx * f[0] + dz * f[1];
        if (along <= -0.025 || along > PASS_LOOKAHEAD) continue;
        const lat = dx * r[0] + dz * r[1];
        const gap = kid ? Math.min(Math.abs(lat), Math.abs(lat - kidLat)) : Math.abs(lat);
        if (gap > 0.045) continue;
        if (!block || along < block.along) block = { q, along, gap };
      }
    }
    if (block && block.along > 0.004 && block.along < 0.04 && block.gap < 0.028) {
      const q = block.q.parent || block.q;
      const same = q.state === 'walk' && q.dir && q.dir[0] * f[0] + q.dir[1] * f[1] > 0.5;
      if (same && (q.waiting > 0 || q.queue || q.speed <= p.speed)) p.queue = true;
    }
    if (block) {
      // the whole group (parent + child) counts as one obstacle
      let q = block.q, gx = q.x, gz = q.z, wide = !!kid;
      if (q.parent) { gx = (q.x + q.parent.x) / 2; gz = (q.z + q.parent.z) / 2; wide = true; q = q.parent; }
      else if (hasChild(q)) { gx = (q.x + q.child.x) / 2; gz = (q.z + q.child.z) / 2; wide = true; }
      const lat = (gx - p.x) * r[0] + (gz - p.z) * r[1] - kidLat / 2;   // seen from the middle of our own pair
      const oncoming = q.state === 'walk' && q.dir && q.dir[0] * f[0] + q.dir[1] * f[1] < -0.5;
      const dirn = Math.abs(lat) > 0.004 ? -Math.sign(lat) : oncoming ? 1 : (p.lat >= 0 ? 1 : -1);
      p.lat = dirn * PASS_SHIFT * (wide ? 1.8 : 1);
      p.latHold = 0.6;
    } else if ((p.latHold = (p.latHold || 0) - dt) <= 0) p.lat = 0;
  }

  // ---------- junctions ----------
  // The next street at the coming junction and which side of it to take, decided in advance (so we
  // can look where we'll walk, and nobody changes their mind halfway across). Also where the two
  // sidewalk lines meet: this edge ends at s1, the next one starts at planS0.
  function plan(p) {
    const key = p.a + '>' + p.b + '/' + p.side;
    if (p.planFor === key) return;
    p.planFor = key;
    const options = (net.adj.get(p.b) || []).filter((c) => c !== p.a);
    const next = options.length ? pick(options) : p.a;       // dead end: turn around
    const [bx, by] = net.xy.get(p.b), [nx, ny] = net.xy.get(next), dN = [nx - bx, ny - by];
    const o = sideOffset(p), rN = rightOf(dN[0], dN[1]), dot = dN[0] * p.dir[0] + dN[1] * p.dir[1];
    let side;
    if (dot > 0.5) side = p.side;                            // straight on: same side of the street
    else if (dot < -0.5) side = -p.side;                     // back the way we came: same sidewalk
    else {
      // round a corner: the side of the new street towards where we came from needs the fewest crossings
      side = rN[0] * -p.dir[0] + rN[1] * -p.dir[1] > 0 ? 1 : -1;
      if (Math.random() < CROSS_CHANCE) side = -side;        // …or cross over to the other side
    }
    if (Math.abs(dot) > 0.5) { p.s1 = 1; p.planS0 = 0; }
    else {
      const oN = [rN[0] * side, rN[1] * side];
      p.s1 = 1 + SIDEWALK_OFFSET * (oN[0] * p.dir[0] + oN[1] * p.dir[1]);
      p.planS0 = SIDEWALK_OFFSET * (o[0] * dN[0] + o[1] * dN[1]);
    }
    p.plan = next; p.planSide = side;
  }

  // Where this person will be after walking `dist` further (on their sidewalk line, without stepping aside).
  function positionAhead(p, dist) {
    plan(p);
    const s = p.s + dist;
    if (s <= p.s1) return edgePoint(p.a, p.dir, p.side, s);
    const [bx, by] = net.xy.get(p.b), [nx, ny] = net.xy.get(p.plan);
    return edgePoint(p.b, [nx - bx, ny - by], p.planSide, Math.min(p.planS0 + s - p.s1, 0.999));
  }

  // Standing on the sidewalk with the next step on the asphalt: wait if a moving car would come
  // near any point of the crossing while we're there (with CROSSING_MARGIN to spare).
  function mustWait(p, stepLen, pace = p.speed) {
    if (onAsphalt(...positionAhead(p, 0))) return false;     // already crossing: keep going
    const first = positionAhead(p, Math.max(stepLen, 0.01) + 0.01);
    if (!onAsphalt(first[0], first[1])) return false;       // not about to cross
    const path = [];
    for (let d = 0.02; d < 1.2; d += 0.04) {
      const q = positionAhead(p, d), on = onAsphalt(q[0], q[1]);
      if (on) path.push([q[0], q[1], d / pace]);
      else if (path.length) { path.push([q[0], q[1], d / pace]); break; }   // back on the kerb
    }
    if (!path.length) return false;
    for (const c of trafficCars) {
      if (!(c.speed > 0.08) || !Number.isFinite(c.x)) continue;
      if (Math.hypot(c.x - path[0][0], c.z - path[0][1]) > 8) continue;   // (path is never empty here)
      const fx = Math.cos(c.heading), fz = Math.sin(c.heading);
      for (const [x, z, t] of path) {
        // does the car's line pass this point, and when is it there?
        const along = (x - c.x) * fx + (z - c.z) * fz, side = Math.abs(-(x - c.x) * fz + (z - c.z) * fx);
        if (side > 0.16 || along < -0.2) continue;           // not in its way, or already past
        const when = along / c.speed, busy = 0.2 / c.speed;  // the car covers the point for ±busy seconds
        if (Math.abs(when - t) < busy + CROSSING_MARGIN) return true;
      }
    }
    return false;
  }

  // Put p at its place on the sidewalk, stepping aside a little when passing (eased in world space).
  function place(p, dt = 0) {
    const [x, z] = edgePoint(p.a, p.dir, p.side, p.s);
    // stepping aside, measured away from the road (+) or towards it (−); with a child on the
    // building side the parent keeps a bit closer to the road
    const child = hasChild(p);
    const u = Math.max(-0.04, Math.min(child ? 0.008 : 0.03, (p.lat || 0) * p.side + (child ? -0.014 : 0)));
    const o = sideOffset(p), k = Math.min(1, dt * 6);
    p.ox = (p.ox || 0) + (o[0] * u - (p.ox || 0)) * k;
    p.oz = (p.oz || 0) + (o[1] * u - (p.oz || 0)) * k;
    p.x = x + p.ox; p.z = z + p.oz;
    p.h = Math.atan2(p.dir[0], p.dir[1]);
  }

  // One step of one person. dt in seconds.
  function step(p, dt) {
    if (p.parent) { follow(p, dt); return; }
    if (p.state === 'inside') {
      p.timer -= dt;
      if (p.timer <= 0 && net.doorList.length) startExit(p);
      return;
    }
    if (p.state === 'enter' || p.state === 'exit') {
      p.t += dt;
      const f = Math.min(1, p.t / Math.max(0.01, p.dur));
      p.x = p.from[0] + (p.to[0] - p.from[0]) * f;
      p.z = p.from[1] + (p.to[1] - p.from[1]) * f;
      p.ox = p.oz = 0;
      if (f >= 1) {
        if (p.state === 'enter') { p.state = 'inside'; p.timer = rnd(...INSIDE_SECONDS); }
        else { p.state = 'walk'; placeOnEdge(p, p.next[0], p.next[1], 0.5); }
      }
      return;
    }
    // walking along a sidewalk
    // a moment's stop on the pavement (never on the road): people stand still for a while
    if (!(p.pause > 0) && Math.random() < PAUSE_CHANCE * dt && !onAsphalt(p.x, p.z)) p.pause = rnd(...PAUSE_SECONDS);
    if (p.pause > 0) { p.pause -= dt; p.waiting = (p.waiting || 0) + dt; place(p, dt); return; }
    const before = p.s;
    // about to step onto the road? look left and right first
    const pace = p.speed;
    if (trafficCars && mustWait(p, pace * dt, pace)) { p.waiting = (p.waiting || 0) + dt; place(p, dt); return; }
    p.waiting = 0;
    if (p.queue) { place(p, dt); return; }                   // someone right in front: wait a moment
    p.s += p.speed * dt;
    // passing the middle of a door on our side: maybe go in
    if (before < 0.5 && p.s >= 0.5 && net.doorList.length) {
      const k = edgeKeyOf(p.a, p.b), n = net.doors.get(k);
      const r = sideOffset(p);
      if (n && r[0] * -n[0] + r[1] * -n[1] > 0 && Math.random() < ENTER_CHANCE) { place(p, dt); startEnter(p, k); return; }
    }
    plan(p);
    while (p.s >= p.s1) {                                    // round the corner, onto the next street
      const over = p.s - p.s1;
      placeOnEdge(p, p.b, p.plan, p.planS0 + over, p.planSide);
      plan(p);
    }
    place(p, dt);
  }

  // ---------- 3D figures ----------
  let legs = null, torsos = null, heads = null, hairs = null, parts = [], bald = null, M = null, group = null;
  let tip = null, bodyM = null, headM = null, childBody = null, childHead = null;

  // Box (min corner x0,y0,z0, size w,h,d) as plain triangles, with one vertex colour.
  function box(pos, nor, col, x0, y0, z0, w, h, d, c) {
    const x1 = x0 + w, y1 = y0 + h, z1 = z0 + d;
    const quad = (a, b, cc, dd, n) => { for (const v of [a, b, cc, a, cc, dd]) { pos.push(...v); nor.push(...n); col.push(...c); } };
    quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1]);
    quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1]);
    quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0]);
    quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0]);
    quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0]);
    quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0]);
  }
  const findBase = (proto, name) => {
    while (proto && !Object.prototype.hasOwnProperty.call(proto, name)) proto = Object.getPrototypeOf(proto);
    return proto && proto.constructor;
  };

  function buildMeshes() {
    // Borrow three.js classes from objects already in the scene (no second copy of three.js).
    let inst = null, lambert = null, anyGeo = null, color = null;
    scene.traverse((o) => {
      if (o.isInstancedMesh && !inst) inst = o;
      if (o.isMesh && o.geometry && !anyGeo) anyGeo = o.geometry;
      const m = o.material;
      if (m && !Array.isArray(m) && m.isMeshLambertMaterial && !lambert) lambert = m;
      if (m && !Array.isArray(m) && m.color && m.color.isColor && !color) color = m.color;
    });
    if (!inst || !lambert || !anyGeo || !color) return false;
    const InstancedMesh = inst.constructor;
    const Geometry = findBase(Object.getPrototypeOf(anyGeo), 'translate');
    const Attr = anyGeo.attributes.position.constructor;
    const Material = lambert.constructor, Color = color.constructor;
    M = inst.matrix.constructor;

    const geo = (build) => {
      const pos = [], nor = [], col = []; build(pos, nor, col);
      const g = new Geometry();
      g.setAttribute('position', new Attr(new Float32Array(pos), 3));
      g.setAttribute('normal', new Attr(new Float32Array(nor), 3));
      g.setAttribute('color', new Attr(new Float32Array(col), 3));
      return g;
    };
    const s = SCALE, W = [1, 1, 1];
    const legsGeo = geo((p, n, c) => box(p, n, c, -0.013 * s, 0, -0.008 * s, 0.026 * s, LEG * s, 0.016 * s, W));
    const torsoGeo = geo((p, n, c) => box(p, n, c, -0.016 * s, LEG * s, -0.01 * s, 0.032 * s, TORSO * s, 0.02 * s, W));
    const hy = HEAD_Y;
    const headGeo = geo((p, n, c) => box(p, n, c, -0.011 * s, hy * s, -0.011 * s, HEAD * s, HEAD * s, HEAD * s, W));
    const hairGeo = geo((p, n, c) => {
      box(p, n, c, -0.012 * s, (hy + HEAD - 0.003) * s, -0.012 * s, 0.024 * s, 0.009 * s, 0.024 * s, W);   // top
      box(p, n, c, -0.012 * s, (hy + 0.006) * s, -0.012 * s, 0.024 * s, (HEAD - 0.006) * s, 0.006 * s, W); // back
    });
    const mat = new Material({ vertexColors: true });

    const n = MAX_PEOPLE;
    legs = new InstancedMesh(legsGeo, mat, n);
    torsos = new InstancedMesh(torsoGeo, mat, n);
    heads = new InstancedMesh(headGeo, mat, n);
    hairs = new InstancedMesh(hairGeo, mat, n);
    parts = [legs, torsos, heads, hairs];
    for (const m of parts) { m.frustumCulled = false; m.castShadow = true; m.receiveShadow = true; m.count = 0; }

    // a fixed, varied look per person (seeded, so it's the same after every reload)
    let seed = 12345;
    const r = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const choose = (arr) => arr[Math.floor(r() * arr.length)];
    const weighted = (obj) => {
      const e = Object.entries(obj), tot = e.reduce((a, [, w]) => a + w, 0); let x = r() * tot;
      for (const [k, w] of e) { if ((x -= w) < 0) return k; }
      return e[0][0];
    };
    const c = new Color();
    bald = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const skin = choose(SKINS);
      torsos.setColorAt(i, c.set(choose(SHIRTS)));
      legs.setColorAt(i, c.set(choose(TROUSERS)));
      heads.setColorAt(i, c.set(skin.c));
      hairs.setColorAt(i, c.set(weighted(skin.hair)));
      bald[i] = r() < BALD ? 1 : 0;
    }
    group = new (findBase(Object.getPrototypeOf(scene), 'add'))();   // a plain Object3D as container
    group.name = 'sc-pedestrians';
    group.add(...parts);
    scene.add(group);
    tip = new M(); bodyM = new M(); headM = new M();
    childBody = new M().makeScale(CHILD_WIDTH, CHILD_HEIGHT, CHILD_WIDTH);
    childHead = new M().makeTranslation(0, -(1 - CHILD_HEIGHT) * HEAD_Y * SCALE, 0);
    return true;
  }

  // ---------- network and people: rebuilt when the city or the road layout changes ----------
  let seenVersion = 0, built = false;
  function rebuildIfNeeded(now) {
    // the app redraws its roads a moment after the city changes: check which roads are highways once a second
    if (now - hwCheckedAt > 1000) {
      hwCheckedAt = now;
      const sig = [...highwayKeys()].sort().join(';');
      if (sig !== hwSig) { hwSig = sig; seenVersion = -1; }
    }
    if (seenVersion === cityVersion && !helpersArrived) return;
    seenVersion = cityVersion;
    helpersArrived = false;
    buildNetwork();
    spawn();
  }

  // ---------- loop ----------
  function frame(dt, now) {
    if (!scene || !city) return;
    if (!built) { built = buildMeshes(); if (!built) return; }
    if (!group.parent) scene.add(group);                       // in case the app rebuilt its scene
    rebuildIfNeeded(now);

    const hidden = new M().makeScale(0, 0, 0);
    const m = new M();
    const n = Math.min(people.length, MAX_PEOPLE);
    const crowd = dt > 0 ? crowdCells() : null;
    for (let i = 0; i < n; i++) {
      const p = people[i];
      if (crowd) steer(p, crowd, dt);
      step(p, dt);
      if (p.state === 'inside') { for (const part of parts) part.setMatrixAt(i, hidden); continue; }
      m.makeRotationY(p.h);
      m.setPosition(p.x, SIDEWALK_HEIGHT, p.z);
      if (p.k) {                                              // a child: smaller body, the same head on top of it
        bodyM.multiplyMatrices(m, childBody); headM.multiplyMatrices(m, childHead);
        legs.setMatrixAt(i, bodyM); torsos.setMatrixAt(i, bodyM); heads.setMatrixAt(i, headM);
        hairs.setMatrixAt(i, bald[i] ? hidden : headM);
      } else {
        legs.setMatrixAt(i, m); torsos.setMatrixAt(i, m); heads.setMatrixAt(i, m);
        hairs.setMatrixAt(i, bald[i] ? hidden : m);
      }
    }
    for (const part of parts) { part.count = n; part.instanceMatrix.needsUpdate = true; }
  }

  let last = null;
  function loop(now) {
    requestAnimationFrame(loop);
    const dt = last === null ? 0 : Math.min(0.1, (now - last) / 1000);
    last = now;
    frame(dt, now);
  }
  requestAnimationFrame(loop);

  window.scPedestrians = {
    get people() { return people; },
    get count() { return people.length; },
  };
})();
