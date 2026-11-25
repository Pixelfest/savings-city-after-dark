// ==UserScript==
// @name         Savings City – residents
// @namespace    savings-city-tweaks
// @version      1.15
// @description  Simple, static little figures (some adults with a child) that slowly walk the sidewalks, step aside for each other, cross the road at junctions and now and then go into or come out of buildings.
// @match        https://your-savings-city-host.example/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * How it works
 * ------------
 * - Needs the core script (savings-city-core): the scene, the city data (roads, buildings – what
 *   the app itself reads, so it also follows the auto-layout script), traffic, the app's helpers,
 *   sound and the frame loop come from there.
 * - Roads lie on the lines between tiles: asphalt ±0.16 from the line, sidewalk from 0.16 to
 *   0.25. Residents walk along the road lines, SIDEWALK_OFFSET to one side (p.side), on either
 *   side of the street in either direction. Their path is the road network shifted onto the
 *   sidewalk: round a corner they walk to the corner of the sidewalk and on from there, so the only
 *   time they're on the asphalt is a real crossing, straight across, all the way.
 * - At every junction they pick a way on (only turning back at a dead end) and which side of that
 *   street to take: normally the one that needs the fewest crossings, now and then (CROSS_CHANCE)
 *   the other one: they cross. Decided once, in advance, so nobody turns back halfway.
 * - Someone in front of you on the sidewalk: oncoming people both step to their right, someone
 *   slower (or lying there) is passed on the free side.
 * - Children: smaller bodies with the same head; each walks right next to a parent and follows
 *   them everywhere (in and out of buildings too); if the parent dies, the child runs off.
 * - Front doors come from the app's own code (exact door position per building). Walking past
 *   a door on that side of the street, a resident sometimes goes in, stays inside for a while,
 *   and later comes out of some (other) door.
 * - Figures are four instanced meshes (trousers, shirt, head, hair): a few hundred people cost
 *   four draw calls. Each resident has their own colour combination.
 *   No animation: they're static shapes that glide.
 */
(function () {
  'use strict';

  // the core script, also when this script loads before it; sound through its output, which
  // follows the app's own sound button (mute + volume)
  const whenCore = (fn) => (window.scCore ? fn(window.scCore) : (window.scCoreWaiting = window.scCoreWaiting || []).push(fn));
  const out = (ctx) => (window.scCore ? window.scCore.out(ctx) : ctx.destination);


  // ---- settings -------------------------------------------------------------------------
  const PER_ROAD = 2;             // residents per road tile
  const MAX_PEOPLE = 2000;
  const SPEED = 0.15;             // tiles per second (cars drive about 1–2)
  const SPEED_VARIATION = 0.35;   // ±35 %
  const SIDEWALK_OFFSET = 0.205;  // distance from the road line (middle of the sidewalk)
  const CROSS_CHANCE = 0.2;       // at a corner: chance to take the far side of the next street (cross over)
  const PASS_SHIFT = 0.022;       // how far people step aside to pass each other (the sidewalk is 0.09 wide)
  const PASS_LOOKAHEAD = 0.12;    // they start stepping aside when someone is this close in front
  const CHILD_SHARE = 0.18;       // share of adults walking with a child
  const CHILD_HEIGHT = 0.62;      // a child's body is this much of an adult's (the head stays the same size)
  const CHILD_WIDTH = 0.78;
  const CHILD_GAP = 0.03;         // how far beside the parent (on the building side)
  const SIDEWALK_HEIGHT = 0.036;  // the app's sidewalks are blocks this high: residents stand on top
  const ASPHALT = 0.16;           // the asphalt reaches this far from the road line
  const LOOK_BEFORE_CROSSING = true;   // calm residents wait at the kerb when a car is coming
  const CROSSING_MARGIN = 0.5;    // seconds of extra room they keep from cars
  const ENTER_CHANCE = 0.25;      // chance to go in when passing a front door on that side
  const INSIDE_SECONDS = [8, 45]; // how long someone stays inside
  const START_INSIDE = 0.2;       // share of people that start inside a building
  const SCALE = 1;                // size of the figures
  // Every resident gets their own combination: shirt, trousers, skin and hair are picked separately.
  const SHIRTS = ['#e25d5d', '#4f8fd8', '#f0a24a', '#7bc77b', '#f2f2f2', '#9b6fd8', '#f6e46f', '#3cb7b0',
                  '#555b66', '#d87bb0', '#2f3a56', '#a8423f', '#6f8f4e', '#c9b38a', '#1f1f24', '#8fb8de'];
  const TROUSERS = ['#2f4a7a', '#3b5d94', '#1f2a44', '#26262b', '#5a5d66', '#8b7d62', '#6b4f3a', '#3e4a3a', '#a9a196'];
  // Realistic skin tones, light to dark. Each has the hair colours that suit it, with weights.
  const SKINS = [
    { c: '#f6dcc6', hair: { '#e6c77a': 3, '#b08a4f': 3, '#6b4a2e': 3, '#a0522d': 1, '#2b1d14': 1, '#c9c6c2': 1 } },
    { c: '#eec4a2', hair: { '#b08a4f': 2, '#6b4a2e': 4, '#3d2a1c': 3, '#e6c77a': 1, '#a0522d': 1, '#c9c6c2': 1 } },
    { c: '#dba97f', hair: { '#3d2a1c': 4, '#2b1d14': 4, '#6b4a2e': 2, '#c9c6c2': 1 } },
    { c: '#c08a5e', hair: { '#2b1d14': 5, '#1a1410': 3, '#3d2a1c': 2, '#c9c6c2': 1 } },
    { c: '#9a6440', hair: { '#1a1410': 6, '#2b1d14': 3, '#c9c6c2': 1 } },
    { c: '#6e4329', hair: { '#1a1410': 7, '#2b1d14': 2, '#c9c6c2': 1 } },
    { c: '#4b2c1c', hair: { '#1a1410': 8, '#c9c6c2': 1 } },
  ];
  const BALD = 0.07;              // share of residents without hair
  const FALL_SECONDS = 0.45;      // how long falling over takes when shot (walk mode)
  const PANIC_SPEED = 2.8;        // running away: this many times faster than walking
  const PANIC_ENTER_CHANCE = 0.7; // while running away, chance to dive into a building passing its door
  const CAR_COLLISIONS = true;    // a moving car that touches a resident knocks them over
  const BLOOD = true;             // blood spatters when someone is knocked down, and a pool grows under them
  const BLOOD_DROPS = 22;         // drops per person knocked down
  const BLOOD_SPEED = 0.7;        // how hard the drops fly (tiles per second)
  const BLOOD_POOL_SIZE = 0.065;  // final radius of the pool (a person is 0.135 tall)
  const BLOOD_POOL_SECONDS = 10;  // how long the pool keeps growing
  const MAX_BLOOD_DROPS = 5000;   // drops + stains on the ground; the oldest stains disappear after this
  const ASPHALT_HEIGHT = 0.04;    // top of the road surface
  const HEADSHOTS = true;         // shot in the head (walk mode): the head pops off and flies on its own
  const HEAD_SPEED = 0.8;         // how hard a head is knocked away (tiles per second; 1 tile ≈ 20 m)
  const NECK_SQUIRT_SECONDS = 3.5;// blood keeps squirting from the neck in pulses this long
  const MAX_LOOSE_HEADS = 300;    // the oldest loose heads disappear after this many
  const SCREAMS = true;           // people in a panic scream (synthesised, no sound files)
  const SCREAM_CHANCE = 0.45;     // chance someone screams when they start to panic…
  const SCREAM_REPEAT = 0.12;     // …and per second while they keep running
  const MAX_SCREAMS = 6;          // at most this many at the same time
  const SCREAM_VOLUME = 0.45;
  const SCREAM_HEARING = 9;       // walk mode: tiles; further away you don't hear them
  const CRUSH_MARGIN = 0.3;       // a building coming down kills people outside this close to its walls
  // ---------------------------------------------------------------------------------------

  // ---------- the scene, city data, traffic and the app's helpers: from the core ----------
  let scene = null, built = false, trafficCars = null;
  let city = null, cityVersion = 0, appModule = null;
  whenCore((c) => c.onCity((d) => { city = d; cityVersion++; c.app().then((m) => { appModule = m; }).catch(() => {}); }));

  // ---------- road network ----------
  const tk = (x, y) => x + ',' + y;
  const NORMALS = [[0, -1], [1, 0], [0, 1], [-1, 0]];   // door facing 0=N 1=E 2=S 3=W → outward
  let net = null;   // { adj: Map(node → [node]), nodes: [[x,y]], edges: [[a,b,key]], doors: Map(edgeKey → n), doorList }

  function buildNetwork() {
    const adj = new Map(), edges = [], xy = new Map();
    const add = (a, b) => { if (!adj.has(a)) adj.set(a, []); adj.get(a).push(b); };
    for (const k of city.roads) {
      const [x, y, t] = String(k).split(','); const X = +x, Y = +y;
      if (!Number.isFinite(X) || !Number.isFinite(Y)) continue;
      const a = tk(X, Y), b = t === 'h' ? tk(X + 1, Y) : tk(X, Y + 1);
      xy.set(a, [X, Y]); xy.set(b, t === 'h' ? [X + 1, Y] : [X, Y + 1]);
      add(a, b); add(b, a); edges.push([a, b, k]);
    }
    const roadSet = new Set(city.roads.map(String));
    const doors = new Map(), doorList = [];
    if (appModule) {
      try {
        for (const b of appModule.v(city.projects)) {
          const n = NORMALS[b.facing]; if (!n) continue;
          for (const k of appModule.a(b.gx, b.gy, b.fp.base ?? b.fp, b.facing)) {
            if (!roadSet.has(k)) continue;
            doors.set(k, n); doorList.push(k);
          }
        }
      } catch (e) { console.warn('[residents] no doors:', e); }
    }
    // road segments per tile, to tell quickly whether a point is on the asphalt
    const cells = new Map();
    for (const [a, b] of edges) {
      const [ax, ay] = xy.get(a), [bx, by] = xy.get(b);
      for (let x = Math.min(ax, bx) - 1; x <= Math.max(ax, bx); x++) for (let y = Math.min(ay, by) - 1; y <= Math.max(ay, by); y++) {
        const k = tk(x, y); (cells.get(k) || cells.set(k, []).get(k)).push([ax, ay, bx, by]);
      }
    }
    net = { adj, xy, edges, doors, doorList, cells };
  }

  const edgeKeyOf = (a, b) => {   // road key for the segment between two neighbouring nodes
    const [ax, ay] = net.xy.get(a), [bx, by] = net.xy.get(b);
    return ay === by ? `${Math.min(ax, bx)},${ay},h` : `${ax},${Math.min(ay, by)},v`;
  };
  // right-hand normal of walking direction (dx, dz)
  const rightOf = (dx, dz) => [-dz, dx];

  // ---------- people ----------
  let people = [];
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

  // Run away from (x, z): turn round if heading towards it (unless halfway across the road: then
  // on to the other side first); faster and away at junctions for a while.
  function panic(p, x, z, seconds) {
    if (!(p.panic > 0) && p.state !== 'inside' && Math.random() < SCREAM_CHANCE) scream(p, rnd(0, 0.5));
    p.panic = seconds * (0.8 + Math.random() * 0.4);
    p.fleeFrom = [x, z];
    if (p.state !== 'walk' || p.parent) return;
    p.planFor = null;                                            // think again about where to go
    if (p.dir[0] * (x - p.x) + p.dir[1] * (z - p.z) > 0 && !onAsphalt(...edgePoint(p.a, p.dir, p.side, p.s))) {
      // turn round on the spot: same sidewalk, other direction
      placeOnEdge(p, p.b, p.a, 1 - p.s, -p.side);
    }
  }

  function newPerson() {
    return { speed: SPEED * (1 + rnd(-SPEED_VARIATION, SPEED_VARIATION)), state: 'walk', x: 0, z: 0, h: 0, lat: 0, ox: 0, oz: 0 };
  }
  // a child that walks next to adult p (and goes where p goes)
  function makeChild(p) {
    const c = { speed: p.speed, state: p.state, x: p.x, z: p.z, h: p.h, parent: p, k: CHILD_HEIGHT, kw: CHILD_WIDTH, cside: 1, fresh: true,
      insideAt: p.insideAt, voice: rnd(1150, 1450) };
    p.child = c;
    return c;
  }

  function spawn() {
    people = [];
    drops.length = 0;
    loose.length = 0; for (const set of looseSets) { set.list.length = 0; set.ring = 0; }
    if (!net.edges.length) return;
    const count = Math.min(MAX_PEOPLE, Math.round(net.edges.length * PER_ROAD));
    while (people.length < count) {
      const p = newPerson();
      const [a, b] = pick(net.edges);
      const s0 = rnd(0.25, 0.75), side = Math.random() < 0.5 ? 1 : -1;   // start on the sidewalk, not in a junction
      if (Math.random() < 0.5) placeOnEdge(p, a, b, s0, side); else placeOnEdge(p, b, a, s0, side);
      if (net.doorList.length && Math.random() < START_INSIDE) {
        p.state = 'inside'; p.timer = rnd(0, INSIDE_SECONDS[1]);
        const k = pick(net.doorList), n = net.doors.get(k), mid = midOf(k);
        p.insideAt = [mid[0] - n[0] * 0.35, mid[1] - n[1] * 0.35];
      }
      people.push(p);
      if (people.length < count && Math.random() < CHILD_SHARE) people.push(makeChild(p));
    }
  }

  // Walk into the building of door edge k (building is on the −n side).
  function startEnter(p, k) {
    const n = net.doors.get(k);
    const mid = midOf(k);
    p.state = 'enter';
    p.from = [p.x, p.z];
    p.to = [mid[0] - n[0] * 0.35, mid[1] - n[1] * 0.35];
    p.insideAt = p.to;                                           // where they are while inside (for collapses)
    p.t = 0; p.dur = Math.hypot(p.to[0] - p.x, p.to[1] - p.z) / p.speed;
    p.h = Math.atan2(p.to[0] - p.x, p.to[1] - p.z);
  }

  // Come out of a random door, onto the sidewalk on the building's side, then walk on.
  function startExit(p) {
    const k = pick(net.doorList), n = net.doors.get(k), mid = midOf(k);
    const [x, y, t] = k.split(',').map((v, i) => (i < 2 ? +v : v));
    let a = tk(x, y), b = t === 'h' ? tk(x + 1, y) : tk(x, y + 1);
    // walk the direction that keeps the building on our right
    const [ax, ay] = net.xy.get(a), [bx, by] = net.xy.get(b);
    const r = rightOf(bx - ax, by - ay);
    if (r[0] * -n[0] + r[1] * -n[1] < 0) [a, b] = [b, a];
    p.state = 'exit';
    p.insideAt = null;
    p.side = 1;
    p.panic = 0;                                                 // comes out calm
    p.from = [mid[0] - n[0] * 0.35, mid[1] - n[1] * 0.35];
    p.to = [mid[0] - n[0] * SIDEWALK_OFFSET, mid[1] - n[1] * SIDEWALK_OFFSET];
    p.t = 0; p.dur = Math.hypot(p.to[0] - p.from[0], p.to[1] - p.from[1]) / p.speed;
    p.h = Math.atan2(n[0], n[1]);
    p.next = [a, b];
  }

  function midOf(k) {
    const [x, y, t] = k.split(',');
    return t === 'h' ? [+x + 0.5, +y] : [+x, +y + 0.5];
  }

  function step(p, dt) {
    if (p.state === 'gone') return;
    if (p.state === 'down') { p.fall = Math.min(1, p.fall + dt / FALL_SECONDS); return; }   // lies still
    if (p.parent) { follow(p, dt); return; }
    if (p.panic > 0) p.panic -= dt;                              // calms down, indoors too
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
        else { p.state = 'walk'; placeOnEdge(p, p.next[0], p.next[1], p.nextS ?? 0.5); p.nextS = undefined; }
      }
      return;
    }
    // walking along a sidewalk
    const before = p.s;
    const panicking = p.panic > 0;
    if (panicking && Math.random() < SCREAM_REPEAT * dt) scream(p, 0);
    // about to step onto the road? look left and right first (people in a panic don't)
    if (!panicking && LOOK_BEFORE_CROSSING && trafficCars && mustWait(p, p.speed * dt)) { p.waiting = (p.waiting || 0) + dt; place(p, dt); return; }
    p.waiting = 0;
    if (p.queue && !panicking) { place(p, dt); return; }          // someone right in front: wait a moment
    p.s += p.speed * (panicking ? PANIC_SPEED : 1) * dt;
    // passing the middle of a door on our side: maybe go in
    if (before < 0.5 && p.s >= 0.5 && net.doorList.length) {
      const k = edgeKeyOf(p.a, p.b), n = net.doors.get(k);
      const r = sideOffset(p);   // the side of the street we're on; panicking people like to hide indoors
      if (n && r[0] * -n[0] + r[1] * -n[1] > 0 && Math.random() < (panicking ? PANIC_ENTER_CHANCE : ENTER_CHANCE)) { place(p, dt); startEnter(p, k); return; }
    }
    plan(p);
    while (p.s >= p.s1) {                                        // round the corner, onto the next street
      const over = p.s - p.s1;
      placeOnEdge(p, p.b, p.plan, p.planS0 + over, p.planSide);
      plan(p);
    }
    place(p, dt);
  }

  // A child next to its parent, on the building side while walking. Parent dead: the child runs.
  function follow(c, dt) {
    const p = c.parent;
    if (p.state === 'down' || p.state === 'gone') { orphan(c); return; }
    c.state = p.state; c.panic = p.panic; c.fleeFrom = p.fleeFrom; c.insideAt = p.insideAt;
    if (p.state === 'inside') { c.fresh = true; return; }
    const hx = Math.sin(p.h), hz = Math.cos(p.h), r = rightOf(hx, hz);
    if (p.state === 'walk') { const o = sideOffset(p); c.cside = r[0] * o[0] + r[1] * o[1] >= 0 ? 1 : -1; }
    const tx = p.x + r[0] * c.cside * CHILD_GAP - hx * 0.006, tz = p.z + r[1] * c.cside * CHILD_GAP - hz * 0.006;
    if (c.fresh) { c.x = tx; c.z = tz; c.fresh = false; }
    else { const k = Math.min(1, dt * 10); c.x += (tx - c.x) * k; c.z += (tz - c.z) * k; }
    c.h = p.h;
  }
  function orphan(c) {
    const p = c.parent;
    c.parent = null; if (p.child === c) p.child = null;
    if (c.state === 'inside') { c.timer = rnd(...INSIDE_SECONDS); return; }
    const e = nearestEdge(c.x, c.z); if (!e) { c.state = 'gone'; return; }
    const [ax, ay] = net.xy.get(e.a), [bx, by] = net.xy.get(e.b);
    const away = Math.hypot(bx - p.x, by - p.z) > Math.hypot(ax - p.x, ay - p.z);
    if (away) placeOnEdge(c, e.a, e.b, e.s); else placeOnEdge(c, e.b, e.a, 1 - e.s);
    const r = rightOf(c.dir[0], c.dir[1]), lx = ax + (bx - ax) * e.s, lz = ay + (by - ay) * e.s;
    c.side = r[0] * (c.x - lx) + r[1] * (c.z - lz) >= 0 ? 1 : -1;
    const [px, pz] = edgePoint(c.a, c.dir, c.side, c.s);
    c.ox = c.x - px; c.oz = c.z - pz; c.lat = 0;                // eases from where they stand onto the sidewalk
    c.state = 'walk';
    panic(c, p.x, p.z, 15);
  }
  function nearestEdge(x, z) {
    let best = null;
    for (const [a, b] of net.edges) {
      const [ax, ay] = net.xy.get(a), [bx, by] = net.xy.get(b), ex = bx - ax, ey = by - ay, l2 = ex * ex + ey * ey || 1;
      const s0 = Math.max(0, Math.min(1, ((x - ax) * ex + (z - ay) * ey) / l2)), d = Math.hypot(ax + ex * s0 - x, ay + ey * s0 - z);
      if (!best || d < best.d) best = { a, b, s: s0, d };
    }
    return best;
  }

  // ---------- passing each other ----------
  // Everyone outside, per cell of 0.25 tiles, rebuilt every frame.
  const PASS_CELL = 0.25;
  function crowdCells() {
    const cells = new Map();
    for (let i = 0; i < people.length && i < MAX_PEOPLE; i++) {
      const p = people[i];
      if (p.state === 'inside' || p.state === 'gone') continue;
      const k = Math.floor(p.x / PASS_CELL) + ',' + Math.floor(p.z / PASS_CELL);
      (cells.get(k) || cells.set(k, []).get(k)).push(p);
    }
    return cells;
  }
  const hasChild = (p) => p.child && p.child.state !== 'down' && p.child.state !== 'gone' && p.child.state !== 'inside';
  // Someone close in front (or right beside): step aside, away from them (straight towards each
  // other: both to their own right). Next to a parent with a child there's less room, so step
  // aside further. Right behind someone who stands still (waiting at the kerb) or walks the same
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

  // ---------- looking before crossing ----------
  function onAsphalt(x, z) {
    const list = net.cells.get(tk(Math.floor(x), Math.floor(z)));
    if (!list) return false;
    for (const [ax, ay, bx, by] of list) {
      const cx = Math.max(Math.min(ax, bx), Math.min(Math.max(ax, bx), x)), cz = Math.max(Math.min(ay, by), Math.min(Math.max(ay, by), z));
      if (Math.hypot(x - cx, z - cz) < ASPHALT + 0.015) return true;
    }
    return false;
  }

  // The next street at the coming junction and which side of it to take, decided in advance (so
  // we can look where we'll walk, and nobody changes their mind halfway across). Also where the
  // two sidewalk lines meet: this edge ends at s1, the next one starts at planS0.
  function plan(p) {
    const key = p.a + '>' + p.b + '/' + p.side;
    if (p.planFor === key) return;
    p.planFor = key;
    const options = (net.adj.get(p.b) || []).filter((c) => c !== p.a);
    let next;
    if (!options.length) next = p.a;                             // dead end: turn around
    else if (p.panic > 0 && p.fleeFrom) {
      // fleeing: the way that leads furthest from the danger (now and then the second best)
      const far = (n) => { const [x, y] = net.xy.get(n); return Math.hypot(x - p.fleeFrom[0], y - p.fleeFrom[1]); };
      const sorted = options.slice().sort((u, v) => far(v) - far(u));
      next = sorted.length > 1 && Math.random() < 0.2 ? sorted[1] : sorted[0];
    } else next = pick(options);
    const [bx, by] = net.xy.get(p.b), [nx, ny] = net.xy.get(next), dN = [nx - bx, ny - by];
    const o = sideOffset(p), rN = rightOf(dN[0], dN[1]), dot = dN[0] * p.dir[0] + dN[1] * p.dir[1];
    let side;
    if (dot > 0.5) side = p.side;                                // straight on: same side of the street
    else if (dot < -0.5) side = -p.side;                         // back the way we came: same sidewalk
    else {
      // round a corner: the side of the new street towards where we came from needs the fewest crossings
      side = rN[0] * -p.dir[0] + rN[1] * -p.dir[1] > 0 ? 1 : -1;
      if (!(p.panic > 0) && Math.random() < CROSS_CHANCE) side = -side;   // …or cross over to the other side
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
  function mustWait(p, stepLen) {
    if (onAsphalt(...positionAhead(p, 0))) return false;        // already crossing: keep going
    const first = positionAhead(p, Math.max(stepLen, 0.01) + 0.01);
    if (!onAsphalt(first[0], first[1])) return false;          // not about to cross
    const path = [];
    for (let d = 0.02; d < 1.2; d += 0.04) {
      const q = positionAhead(p, d), on = onAsphalt(q[0], q[1]);
      if (on) path.push([q[0], q[1], d / p.speed]);
      else if (path.length) { path.push([q[0], q[1], d / p.speed]); break; }   // back on the kerb
    }
    for (const c of trafficCars) {
      if (!(c.speed > 0.08) || !Number.isFinite(c.x)) continue;
      if (Math.hypot(c.x - path[0][0], c.z - path[0][1]) > 8) continue;
      const fx = Math.cos(c.heading), fz = Math.sin(c.heading);
      for (const [x, z, t] of path) {
        // does the car's line pass this point, and when is it there?
        const along = (x - c.x) * fx + (z - c.z) * fz, side = Math.abs(-(x - c.x) * fz + (z - c.z) * fx);
        if (side > 0.16 || along < -0.2) continue;                // not in its way, or already past
        const when = along / c.speed, busy = 0.2 / c.speed;      // the car covers the point for ±busy seconds
        if (Math.abs(when - t) < busy + CROSSING_MARGIN) return true;
      }
    }
    return false;
  }

  function place(p, dt = 0) {
    const [x, z] = edgePoint(p.a, p.dir, p.side, p.s);
    // stepping aside, measured away from the road (+) or towards it (−); with a child on the
    // building side the parent keeps a bit closer to the road. Eased in world space, so it doesn't
    // jump round corners.
    const child = hasChild(p);
    const u = Math.max(-0.04, Math.min(child ? 0.008 : 0.03, (p.lat || 0) * p.side + (child ? -0.014 : 0)));
    const o = sideOffset(p), k = Math.min(1, dt * 6);
    p.ox = (p.ox || 0) + (o[0] * u - (p.ox || 0)) * k;
    p.oz = (p.oz || 0) + (o[1] * u - (p.oz || 0)) * k;
    p.x = x + p.ox; p.z = z + p.oz;
    p.h = Math.atan2(p.dir[0], p.dir[1]);
  }

  // ---------- traffic: cars can run people over ----------
  // The app's traffic list (car objects with x, z, heading, speed …) comes from the core
  // (trafficCars, refreshed every frame).

  // Moving cars, grouped per tile so each person only checks the cars close by.
  function movingCars() {
    if (!trafficCars) return null;
    const map = new Map();
    for (const c of trafficCars) {
      if (!(c.speed > 0.08) || !Number.isFinite(c.x)) continue;
      const k = tk(Math.floor(c.x), Math.floor(c.z));
      (map.get(k) || map.set(k, []).get(k)).push(c);
    }
    return map;
  }

  // Is this person inside a car's box (in the car's own coordinates)? Then they're knocked over in
  // the car's driving direction.
  function hitByCar(i, p, byTile) {
    const tx = Math.floor(p.x), tz = Math.floor(p.z), R = 0.02 * SCALE;
    for (let ox = -1; ox <= 1; ox++) for (let oz = -1; oz <= 1; oz++) {
      const list = byTile.get(tk(tx + ox, tz + oz)); if (!list) continue;
      for (const c of list) {
        const fx = Math.cos(c.heading), fz = Math.sin(c.heading);   // car forward (the app turns cars by −heading)
        const dx = p.x - c.x, dz = p.z - c.z;
        const lx = dx * fx + dz * fz, lz = -dx * fz + dz * fx;
        // calm people don't walk in front of cars; only panicking people, or a car that suddenly
        // speeds up (fleeing, police with siren), can still hit someone
        const faster = (c.boost || 1) > 1.01 || c.speed > c.base * 1.15;
        if (!(p.panic > 0) && !faster) continue;
        if (Math.abs(lx) < 0.115 + R && Math.abs(lz) < 0.0575 + R) {
          window.scResidents.knockDown(i, { x: fx, y: 0, z: fz }, 'car');
          return;
        }
      }
    }
  }

  // ---------- 3D figures ----------
  let legs = null, torsos = null, heads = null, hairs = null, parts = [], bald = null, M = null, V = null, group = null;

  // ---------- blood ----------
  // Knocked down → a spray of drops (mostly away from the shot, some back towards it) that fall
  // with gravity and become flat stains where they land, and a pool that slowly spreads under the
  // upper body. Drops and stains share one ring buffer of MAX_BLOOD_DROPS.
  // body sizes (before SCALE): legs, torso, head; the head starts just above the neck
  const LEG = 0.048, TORSO = 0.055, HEAD = 0.022, HEAD_Y = LEG + TORSO + 0.002;
  let pools = null, dropMesh = null, dropHead = 0;
  const drops = [];
  const GRAVITY = 3;   // tiles/s²: the figures are miniatures, so a snappy fall reads better than real g

  function groundAt(x, z) { return onAsphalt(x, z) ? ASPHALT_HEIGHT : SIDEWALK_HEIGHT; }

  function addDrop(x, y, z, vx, vy, vz, size) {
    const d = { x, y, z, vx, vy, vz, size, landed: false, rot: rnd(0, Math.PI) };
    if (drops.length < MAX_BLOOD_DROPS) drops.push(d); else { drops[dropHead] = d; dropHead = (dropHead + 1) % MAX_BLOOD_DROPS; }
  }

  function bleed(p, dx, dy, dz) {
    const y0 = SIDEWALK_HEIGHT + 0.08 * SCALE;                      // chest height
    for (let k = 0; k < BLOOD_DROPS; k++) {
      const back = Math.random() < 0.25 ? -0.5 : 1;                 // a quarter sprays back towards the shooter
      const sp = BLOOD_SPEED * rnd(0.25, 1) * back;
      const d = { x: p.x + rnd(-0.008, 0.008), y: y0 + rnd(-0.015, 0.015), z: p.z + rnd(-0.008, 0.008),
        vx: dx * sp + rnd(-0.25, 0.25) * BLOOD_SPEED, vy: Math.max(0, dy) * sp + rnd(0.05, 0.6) * BLOOD_SPEED,
        vz: dz * sp + rnd(-0.25, 0.25) * BLOOD_SPEED, size: rnd(0.0025, 0.0055) * SCALE, landed: false, rot: rnd(0, Math.PI) };
      if (drops.length < MAX_BLOOD_DROPS) drops.push(d); else { drops[dropHead] = d; dropHead = (dropHead + 1) % MAX_BLOOD_DROPS; }
    }
    // the pool: under the chest/head, which lands about 0.07 away from the feet in the fall direction
    p.blood = { t: -rnd(0.4, 1.2), x: p.x + dx * 0.07 * SCALE, z: p.z + dz * 0.07 * SCALE,
      a: rnd(0, Math.PI * 2), sx: rnd(0.8, 1.25), sz: rnd(0.8, 1.25), size: BLOOD_POOL_SIZE * SCALE * rnd(0.75, 1.2) };
    p.blood.y = groundAt(p.blood.x, p.blood.z) + 0.0008;
  }

  function stepBlood(dt, n, m) {
    if (!pools) return;
    const hidden = new M().makeScale(0, 0, 0);
    for (let i = 0; i < n; i++) {
      const b = people[i].blood;
      if (!b || (people[i].state !== 'down' && people[i].state !== 'gone')) { pools.setMatrixAt(i, hidden); continue; }
      b.t += dt;
      const g = b.t <= 0 ? 0 : 1 - Math.pow(1 - Math.min(1, b.t / BLOOD_POOL_SECONDS), 2.2);   // fast at first, then slower
      const r = b.size * Math.max(0.001, g);
      m.makeRotationY(b.a);
      m.scale(new V(r * b.sx, 1, r * b.sz));
      m.setPosition(b.x, b.y, b.z);
      pools.setMatrixAt(i, m);
    }
    pools.count = n; pools.instanceMatrix.needsUpdate = true;
    for (let i = 0; i < drops.length; i++) {
      const d = drops[i];
      if (!d.landed) {
        d.vy -= GRAVITY * dt;
        d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt;
        const gy = groundAt(d.x, d.z);
        if (d.y <= gy + 0.0006) { d.landed = true; d.y = gy + 0.0006 + (i % 7) * 0.00005; }   // tiny offsets: no flicker between stains
        m.makeRotationY(d.rot);
        m.scale(new V(d.size, d.size, d.size * (1 + Math.min(2, Math.hypot(d.vx, d.vy, d.vz) * 2))));   // stretched while flying
        if (!d.landed) m.premultiply(new M().makeRotationY(Math.atan2(d.vx, d.vz) - d.rot));
      }
      if (d.landed) {
        if (!d.flat) { d.flat = true; d.mat = new M().makeRotationY(d.rot).scale(new V(d.size * 1.8, 0.0004, d.size * rnd(1.8, 3.2))).setPosition(d.x, d.y, d.z); }
        dropMesh.setMatrixAt(i, d.mat);
      } else { m.setPosition(d.x, d.y, d.z); dropMesh.setMatrixAt(i, m); }
    }
    dropMesh.count = drops.length; dropMesh.instanceMatrix.needsUpdate = true;
  }

  // ---------- headshots ----------
  // The resident's own head (and hair) is hidden; a copy in their colours flies off with physics:
  // knocked along the shot and up, tumbling, bouncing and rolling to a stop on one of its faces.
  // From the neck of the falling body blood squirts in heartbeat pulses for a few seconds.
  let looseHeads = null, looseHair = null, looseLegs = null, looseTorsos = null;
  const loose = [];
  function behead(i, d) {
    const p = people[i];
    if (!p || p.state === 'down' || p.state === 'gone' || !V || !looseHeads) return false;
    const l = Math.hypot(d.x, d.z) || 1, dx = d.x / l, dz = d.z / l;
    const neckY = SIDEWALK_HEIGHT + (HEAD_Y * (p.k || 1) + HEAD / 2) * SCALE;
    const h = { x: p.x, y: neckY, z: p.z, vx: dx * HEAD_SPEED * rnd(0.6, 1.2) + rnd(-0.2, 0.2), vy: HEAD_SPEED * rnd(0.4, 0.9) + Math.max(0, d.y || 0),
      vz: dz * HEAD_SPEED * rnd(0.6, 1.2) + rnd(-0.2, 0.2), rx: 0, ry: p.h, rz: 0, wx: rnd(-25, 25), wy: rnd(-10, 10), wz: rnd(-25, 25),
      rest: false, trail: 0.8, person: i, bald: bald[i] };
    heads.getColorAt(i, tmpC); const skin = tmpC.clone(); hairs.getColorAt(i, tmpC);
    addLoose(looseSets[0], h, skin, tmpC.clone());
    window.scResidents.knockDown(i, d);
    p.headless = true; p.squirt = BLOOD ? NECK_SQUIRT_SECONDS : 0;
    if (BLOOD) {   // a burst where the head was
      for (let k = 0; k < 18; k++) addDrop(p.x, neckY, p.z, dx * rnd(0, 1) * BLOOD_SPEED + rnd(-0.3, 0.3) * BLOOD_SPEED, rnd(0.1, 0.8) * BLOOD_SPEED, dz * rnd(0, 1) * BLOOD_SPEED + rnd(-0.3, 0.3) * BLOOD_SPEED, rnd(0.002, 0.005) * SCALE);
      if (p.blood) p.blood.size *= 1.4;                            // more blood: a bigger pool
    }
    return true;
  }
  let tmpC = null;

  // heartbeat squirts from the neck of a body, along the body's axis (m = the body's matrix)
  function squirt(p, m, dt, t) {
    p.squirt -= dt;
    const e = m.elements, k = HEAD_Y * SCALE * (p.k || 1);
    const nx = e[4] * k + e[12], ny = e[5] * k + e[13], nz = e[6] * k + e[14];
    const left = p.squirt / NECK_SQUIRT_SECONDS, beat = Math.max(0, Math.sin(t * 0.0001 * 2 * Math.PI * 25 + (p.x * 7)));   // ~2.5 beats per second
    const rate = 150 * left * (0.15 + beat * beat);
    p.squirtAcc = (p.squirtAcc || 0) + rate * dt;
    while (p.squirtAcc >= 1) {
      p.squirtAcc -= 1;
      const sp = BLOOD_SPEED * (0.35 + 0.9 * beat) * (0.4 + 0.6 * left) * rnd(0.7, 1.1);
      addDrop(nx, ny, nz, e[4] * sp + rnd(-0.08, 0.08), e[5] * sp + rnd(-0.08, 0.08) + 0.15, e[6] * sp + rnd(-0.08, 0.08), rnd(0.0018, 0.004) * SCALE);
    }
  }

  // loose parts (heads, and legs and torsos of residents blown apart): fall, tumble, bounce, roll
  // to a stop on one of their faces. set = { list, a: mesh, b: second mesh (hair) or null, half: [x, y, z] }
  const looseSets = [];
  function stepHeads(dt) {
    if (!looseHeads) return;
    for (const set of looseSets) stepLooseSet(set, dt);
  }
  function stepLooseSet(set, dt) {
    const m = new M(), q = new M(), [hx, hy, hz] = set.half, hidden = new M().makeScale(0, 0, 0);
    for (const h of set.list) {
      if (!h.rest && dt > 0) {
        h.vy -= GRAVITY * dt;
        h.x += h.vx * dt; h.y += h.vy * dt; h.z += h.vz * dt;
        h.rx += h.wx * dt; h.ry += h.wy * dt; h.rz += h.wz * dt;
        // lowest corner of the turned box
        q.makeRotationFromEuler(eul.set(h.rx, h.ry, h.rz));
        const e = q.elements, low = hx * Math.abs(e[1]) + hy * Math.abs(e[5]) + hz * Math.abs(e[9]);
        const g = groundAt(h.x, h.z);
        if (h.y - low < g) {
          h.y = g + low;
          if (h.vy < -0.15) { h.vy = -h.vy * 0.35; h.vx *= 0.55; h.vz *= 0.55; h.wx *= 0.6; h.wz *= 0.6; h.wy *= 0.6; }   // bounce
          else {                                                    // rolling: settle onto a face
            h.vy = 0;
            const f = Math.exp(-14 * dt); h.vx *= f; h.vz *= f; h.wx *= f; h.wy *= f; h.wz *= f;
            const snap = (a) => { const t = Math.round(a / (Math.PI / 2)) * (Math.PI / 2); return a + (t - a) * Math.min(1, dt * 8); };
            h.rx = snap(h.rx); h.rz = snap(h.rz);
            if (Math.hypot(h.vx, h.vz) < 0.01 && Math.abs(h.wx) + Math.abs(h.wz) < 0.3) {
              h.rx = Math.round(h.rx / (Math.PI / 2)) * (Math.PI / 2); h.rz = Math.round(h.rz / (Math.PI / 2)) * (Math.PI / 2);
              q.makeRotationFromEuler(eul.set(h.rx, h.ry, h.rz));
              const f2 = q.elements; h.y = g + hx * Math.abs(f2[1]) + hy * Math.abs(f2[5]) + hz * Math.abs(f2[9]); h.rest = true;
            }
          }
        }
        if (BLOOD && h.trail > 0) {                                 // a few drops trail behind it
          h.trail -= dt;
          if (Math.random() < dt * 30) addDrop(h.x, h.y - hy, h.z, h.vx * 0.3, h.vy * 0.3, h.vz * 0.3, rnd(0.0015, 0.003) * SCALE);
        }
      }
      m.makeRotationFromEuler(eul.set(h.rx, h.ry, h.rz)).setPosition(h.x, h.y, h.z);
      set.a.setMatrixAt(h.slot, m);
      if (set.b) set.b.setMatrixAt(h.slot, h.bald ? hidden : m);
    }
    for (const mesh of set.b ? [set.a, set.b] : [set.a]) { mesh.count = set.list.length; mesh.instanceMatrix.needsUpdate = true; }
  }
  // a new loose part in a set; colours [a, b]
  function addLoose(set, h, colA, colB) {
    const slot = set.list.length < MAX_LOOSE_HEADS ? set.list.length : (set.ring = ((set.ring || 0) + 1) % MAX_LOOSE_HEADS);
    set.list[slot] = h; h.slot = slot;
    set.a.setColorAt(slot, colA); set.a.instanceColor.needsUpdate = true;
    if (set.b && colB) { set.b.setColorAt(slot, colB); set.b.instanceColor.needsUpdate = true; }
  }

  // Blown apart (rocket): the resident is gone; legs, torso and head (with hair) fly off on their
  // own, away from the blast at (x, z), with a lot of blood. power ≈ how hard (tiles per second).
  function gib(i, x, z, power = 1.2) {
    const p = people[i];
    if (!p || p.state === 'inside' || p.state === 'gone' || !looseHeads || !looseLegs) return false;
    const dx0 = p.x - x, dz0 = p.z - z, l = Math.hypot(dx0, dz0) || 1, dx = dx0 / l, dz = dz0 / l;
    const base = SIDEWALK_HEIGHT;
    if (p.state !== 'down') died(p, 'blast');                      // (a body blown apart again doesn't count twice)
    const kick = (y) => ({ x: p.x + rnd(-0.01, 0.01), y, z: p.z + rnd(-0.01, 0.01), vx: dx * power * rnd(0.4, 1.1) + rnd(-0.4, 0.4), vy: power * rnd(0.4, 1.0),
      vz: dz * power * rnd(0.4, 1.1) + rnd(-0.4, 0.4), rx: 0, ry: p.h, rz: 0, wx: rnd(-30, 30), wy: rnd(-15, 15), wz: rnd(-30, 30), rest: false, trail: 1.2 });
    const c1 = new tmpC.constructor(), c2 = new tmpC.constructor();
    legs.getColorAt(i, c1); addLoose(looseSets[1], kick(base + (LEG / 2) * SCALE), c1.clone());
    torsos.getColorAt(i, c1); addLoose(looseSets[2], kick(base + (LEG + TORSO / 2) * SCALE), c1.clone());
    if (!p.headless) {
      heads.getColorAt(i, c1); hairs.getColorAt(i, c2);
      const h = kick(base + (HEAD_Y * (p.k || 1) + HEAD / 2) * SCALE); h.bald = bald[i];
      addLoose(looseSets[0], h, c1.clone(), c2.clone());
    }
    p.state = 'gone'; p.squirt = 0;
    if (BLOOD) {
      const y0 = base + 0.06 * SCALE;
      for (let k = 0; k < 60; k++) addDrop(p.x, y0, p.z, dx * rnd(-0.3, 1) * BLOOD_SPEED * 1.5 + rnd(-0.6, 0.6) * BLOOD_SPEED, rnd(0.1, 1.2) * BLOOD_SPEED, dz * rnd(-0.3, 1) * BLOOD_SPEED * 1.5 + rnd(-0.6, 0.6) * BLOOD_SPEED, rnd(0.002, 0.006) * SCALE);
      p.blood = { t: -0.2, x: p.x, z: p.z, a: rnd(0, Math.PI * 2), sx: rnd(0.8, 1.25), sz: rnd(0.8, 1.25), size: BLOOD_POOL_SIZE * SCALE * 1.3, y: groundAt(p.x, p.z) + 0.0008 };
    }
    return true;
  }
  let eul = null;

  function findBase(proto, name) {
    while (proto && !Object.prototype.hasOwnProperty.call(proto, name)) proto = Object.getPrototypeOf(proto);
    return proto && proto.constructor;
  }

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
    V = inst.position.constructor;

    const geo = (build) => {
      const pos = [], nor = [], col = []; build(pos, nor, col);
      const g = new Geometry();
      g.setAttribute('position', new Attr(new Float32Array(pos), 3));
      g.setAttribute('normal', new Attr(new Float32Array(nor), 3));
      g.setAttribute('color', new Attr(new Float32Array(col), 3));
      return g;
    };
    const s = SCALE, W = [1, 1, 1];
    // Same slim width as before, taller: about 0.135 high, cars are about 0.115. Faces +z.
    const legsGeo = geo((p, n, c) => box(p, n, c, -0.013 * s, 0, -0.008 * s, 0.026 * s, LEG * s, 0.016 * s, W));
    const torsoGeo = geo((p, n, c) => box(p, n, c, -0.016 * s, LEG * s, -0.01 * s, 0.032 * s, TORSO * s, 0.02 * s, W));
    const hy = HEAD_Y;                                 // small neck gap
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

    // a fixed, varied look per resident (seeded, so it's the same after every reload)
    let seed = 12345;
    const r = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const choose = (arr) => arr[Math.floor(r() * arr.length)];
    const weighted = (obj) => { const e = Object.entries(obj), tot = e.reduce((a, [, w]) => a + w, 0); let x = r() * tot;
      for (const [k, w] of e) { if ((x -= w) < 0) return k; } return e[0][0]; };
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
    group = new (findBase(Object.getPrototypeOf(scene), 'add'))();   // plain Object3D container
    group.name = 'sc-residents';
    group.add(...parts);
    if (HEADSHOTS) {
      // loose heads: the same head and hair, centred on the head's middle
      const cy = (hy + HEAD / 2) * s;
      const freeHead = geo((p, n, c) => box(p, n, c, -0.011 * s, hy * s - cy, -0.011 * s, HEAD * s, HEAD * s, HEAD * s, W));
      const freeHair = geo((p, n, c) => {
        box(p, n, c, -0.012 * s, (hy + HEAD - 0.003) * s - cy, -0.012 * s, 0.024 * s, 0.009 * s, 0.024 * s, W);
        box(p, n, c, -0.012 * s, (hy + 0.006) * s - cy, -0.012 * s, 0.024 * s, (HEAD - 0.006) * s, 0.006 * s, W);
      });
      looseHeads = new InstancedMesh(freeHead, mat, MAX_LOOSE_HEADS);
      looseHair = new InstancedMesh(freeHair, mat, MAX_LOOSE_HEADS);
      // legs and torso centred on their middles (for residents blown apart)
      const freeLegs = geo((p, n, c) => box(p, n, c, -0.013 * s, -LEG / 2 * s, -0.008 * s, 0.026 * s, LEG * s, 0.016 * s, W));
      const freeTorso = geo((p, n, c) => box(p, n, c, -0.016 * s, -TORSO / 2 * s, -0.01 * s, 0.032 * s, TORSO * s, 0.02 * s, W));
      looseLegs = new InstancedMesh(freeLegs, mat, MAX_LOOSE_HEADS);
      looseTorsos = new InstancedMesh(freeTorso, mat, MAX_LOOSE_HEADS);
      for (const lm of [looseHeads, looseHair, looseLegs, looseTorsos]) { lm.frustumCulled = false; lm.castShadow = true; lm.receiveShadow = true; lm.count = 0; lm.setColorAt(0, c.set('#ffffff')); }
      group.add(looseHeads, looseHair, looseLegs, looseTorsos);
      const hh = (HEAD / 2) * s;
      looseSets.push({ list: loose, a: looseHeads, b: looseHair, half: [hh, hh, hh] },
        { list: [], a: looseLegs, b: null, half: [0.013 * s, (LEG / 2) * s, 0.008 * s] },
        { list: [], a: looseTorsos, b: null, half: [0.016 * s, (TORSO / 2) * s, 0.01 * s] });
      tmpC = new Color();
      eul = new (scene.rotation.constructor)();
    }
    if (BLOOD) {
      // pools: a flat, slightly irregular disc of radius 1 (scaled per person); drops: tiny cubes
      const poolGeo = geo((pp, nn, cc) => {
        const k = 14, rad = (j) => 1 + 0.18 * Math.sin(j * 2.1) + 0.12 * Math.cos(j * 3.7);
        for (let j = 0; j < k; j++) {
          const a0 = (j / k) * Math.PI * 2, a1 = ((j + 1) / k) * Math.PI * 2, r0 = rad(j), r1 = rad((j + 1) % k);
          pp.push(0, 0, 0, Math.sin(a0) * r0, 0, Math.cos(a0) * r0, Math.sin(a1) * r1, 0, Math.cos(a1) * r1);   // counter-clockwise from above: faces up
          for (let v = 0; v < 3; v++) { nn.push(0, 1, 0); cc.push(1, 1, 1); }
        }
      });
      const dropGeo = geo((pp, nn, cc) => box(pp, nn, cc, -0.5, -0.5, -0.5, 1, 1, 1, W));
      const bloodMat = new Material({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
      pools = new InstancedMesh(poolGeo, bloodMat, n);
      dropMesh = new InstancedMesh(dropGeo, bloodMat, MAX_BLOOD_DROPS);
      for (const b of [pools, dropMesh]) { b.frustumCulled = false; b.receiveShadow = true; b.count = 0; }
      for (let i = 0; i < n; i++) pools.setColorAt(i, c.set(i % 3 ? '#5c0707' : '#4a0505'));
      for (let i = 0; i < MAX_BLOOD_DROPS; i++) dropMesh.setColorAt(i, c.set(['#8a0d0d', '#6d0909', '#a31414', '#5a0606'][i % 4]));
      group.add(pools, dropMesh);
    }
    scene.add(group);
    return true;
  }

  // ---------- loop ----------
  let seenVersion = 0;
  function frame(dt, t) {
    const core = window.scCore;
    scene = scene || core.scene; trafficCars = core.traffic();
    if (!scene || !city) return;
    if (!built) { built = buildMeshes(); if (!built) return; }
    if (!group.parent) scene.add(group);                       // in case the app rebuilt its scene
    if (seenVersion !== cityVersion || (appModule && net && !net.doorList.length && city.projects.length && !net.triedDoors)) {
      seenVersion = cityVersion;
      buildNetwork();
      if (appModule) net.triedDoors = true;
      spawn();
    }
    const hidden = new M().makeScale(0, 0, 0);
    if (!tip) {
      tip = new M(); bodyM = new M(); headM = new M();
      childBody = new M().makeScale(CHILD_WIDTH, CHILD_HEIGHT, CHILD_WIDTH);
      childHead = new M().makeTranslation(0, -(1 - CHILD_HEIGHT) * HEAD_Y * SCALE, 0);
    }
    const m = new M();
    const n = Math.min(people.length, MAX_PEOPLE);
    const carsByTile = CAR_COLLISIONS ? movingCars() : null;
    const crowd = dt > 0 ? crowdCells() : null;
    for (let i = 0; i < n; i++) {
      const p = people[i];
      if (crowd) steer(p, crowd, dt);
      step(p, dt);
      if (carsByTile && p.state !== 'inside' && p.state !== 'down' && p.state !== 'gone') hitByCar(i, p, carsByTile);
      if (p.state === 'inside' || p.state === 'gone') { for (const part of parts) part.setMatrixAt(i, hidden); continue; }
      m.makeRotationY(p.h);
      let y = SIDEWALK_HEIGHT;
      if (p.state === 'down') {
        // tip over around the feet, away from the shot, speeding up like a real fall
        const f = p.fall * p.fall;
        tip.makeRotationAxis(p.axis, (Math.PI / 2) * f);
        m.premultiply(tip);
        y += 0.011 * SCALE * f;                                 // lying on its back, not half in the sidewalk
      }
      m.setPosition(p.x, y, p.z);
      if (p.k) {                                                // a child: smaller body, the same head on top of it
        bodyM.multiplyMatrices(m, childBody); headM.multiplyMatrices(m, childHead);
        legs.setMatrixAt(i, bodyM); torsos.setMatrixAt(i, bodyM); heads.setMatrixAt(i, p.headless ? hidden : headM);
        hairs.setMatrixAt(i, bald[i] || p.headless ? hidden : headM);
      } else {
        legs.setMatrixAt(i, m); torsos.setMatrixAt(i, m); heads.setMatrixAt(i, p.headless ? hidden : m);
        hairs.setMatrixAt(i, bald[i] || p.headless ? hidden : m);
      }
      if (p.squirt > 0 && dt > 0) squirt(p, m, dt, t);
    }
    for (const part of parts) { part.count = n; part.instanceMatrix.needsUpdate = true; }
    if (HEADSHOTS) stepHeads(dt);
    if (BLOOD) stepBlood(dt, n, m);
  }
  let tip = null, bodyM = null, headM = null, childBody = null, childHead = null;
  whenCore((c) => c.onFrame(frame));

  // ---------- deaths ----------
  // Every death is announced (the bodycount script counts them): sc:kill { x, z, cause }.
  let deaths = 0;
  function died(p, cause) {
    deaths++;
    window.dispatchEvent(new CustomEvent('sc:kill', { detail: { x: p.x, z: p.z, cause, who: 'resident' } }));
  }

  // ---------- screams ----------
  // A sawtooth voice through vowel formants ("aaah"), with a pitch that shoots up and sags, a
  // shaky vibrato and some breath noise. Each person keeps their own voice. In walk mode the
  // loudness and left/right follow where they are; seen from above everyone is fairly quiet.
  let audio = null, screaming = 0, lastScream = 0, noiseBuf = null;
  function scream(p, delay = 0, short = false) {
    if (!SCREAMS) return;
    const now = performance.now();
    if (screaming >= MAX_SCREAMS || now - lastScream < 90) return;
    let vol = SCREAM_VOLUME * 0.3, pan = 0;
    const w = window.scWalk;
    if (w && w.walking && w.player) {
      const pl = w.player, dx = p.x - pl.x, dz = p.z - pl.z, d = Math.hypot(dx, dz);
      if (d > SCREAM_HEARING) return;
      vol = SCREAM_VOLUME / (1 + d * d * 0.5);
      pan = Math.max(-1, Math.min(1, (dx * Math.cos(pl.yaw) - dz * Math.sin(pl.yaw)) / (d || 1))) * Math.min(1, d * 2);
    }
    if (vol < 0.01) return;
    lastScream = now;
    try {
      audio = audio || new AudioContext();
      if (audio.state === 'suspended') audio.resume();
      const a = audio, t = a.currentTime + delay;
      const f0 = p.voice || (p.voice = Math.random() < 0.55 ? rnd(780, 1150) : rnd(430, 680));
      const len = short ? rnd(0.25, 0.45) : rnd(0.6, 1.4);
      const osc = a.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(f0 * 0.75, t);
      osc.frequency.exponentialRampToValueAtTime(f0 * rnd(1.05, 1.2), t + Math.min(0.15, len * 0.3));
      osc.frequency.exponentialRampToValueAtTime(f0 * rnd(0.9, 1.0), t + len * 0.7);
      osc.frequency.exponentialRampToValueAtTime(f0 * rnd(0.55, 0.7), t + len);
      const lfo = a.createOscillator(), lfoGain = a.createGain();   // the shaky voice
      lfo.frequency.value = rnd(5, 9); lfoGain.gain.value = f0 * rnd(0.02, 0.05);
      lfo.connect(lfoGain); lfoGain.connect(osc.frequency);
      const shaper = a.createWaveShaper(), curve = new Float32Array(256);   // a bit of rasp
      for (let i = 0; i < 256; i++) { const x = i / 128 - 1; curve[i] = Math.tanh(x * 2.5); }
      shaper.curve = curve;
      const out = a.createGain(), pn = a.createStereoPanner ? a.createStereoPanner() : null;
      osc.connect(shaper);
      for (const [fr, q, g] of [[rnd(800, 1000), 5, 1], [rnd(1150, 1450), 6, 0.7], [rnd(2600, 3000), 8, 0.35]]) {   // "aaah"
        const bp = a.createBiquadFilter(), bg = a.createGain();
        bp.type = 'bandpass'; bp.frequency.value = fr; bp.Q.value = q; bg.gain.value = g;
        shaper.connect(bp); bp.connect(bg); bg.connect(out);
      }
      if (!noiseBuf) { noiseBuf = a.createBuffer(1, a.sampleRate, a.sampleRate); const ch = noiseBuf.getChannelData(0); for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1; }
      const noise = a.createBufferSource(), nf = a.createBiquadFilter(), ng = a.createGain();
      noise.buffer = noiseBuf; nf.type = 'bandpass'; nf.frequency.value = 2500; nf.Q.value = 1; ng.gain.value = 0.25;
      noise.connect(nf); nf.connect(ng); ng.connect(out);
      const env = a.createGain();
      env.gain.setValueAtTime(0.0001, t);
      env.gain.exponentialRampToValueAtTime(vol, t + 0.04);
      env.gain.setValueAtTime(vol, t + len * 0.6);
      env.gain.exponentialRampToValueAtTime(0.0001, t + len);
      out.connect(env);
      if (pn) { pn.pan.value = pan; env.connect(pn); pn.connect(out(a)); } else env.connect(out(a));
      screaming++;
      osc.onended = () => { screaming--; };
      for (const s of [osc, lfo, noise]) { s.start(t); s.stop(t + len + 0.05); }
    } catch (e) { /* no audio */ }
  }

  // ---------- for other scripts (walk mode shoots with this) ----------
  // hit(origin, direction, maxDistance) → { index, t } of the nearest standing resident on that line.
  // knockDown(index, direction) → makes them fall over (away from the shot) and stay down.
  window.scResidents = {
    hit(o, d, max = 30) {
      const HR = 0.0125 * SCALE;
      const a = d.x * d.x + d.z * d.z;
      let best = null;
      people.forEach((p, i) => {
        if (i >= MAX_PEOPLE || p.state === 'inside' || p.state === 'down' || p.state === 'gone') return;
        const k = p.k || 1;                                       // children: shorter and slimmer, same head
        const H = (0.135 - (1 - k) * HEAD_Y) * SCALE, R = 0.02 * (p.kw || 1) * SCALE, neck = SIDEWALK_HEIGHT + (HEAD_Y * k - 0.002) * SCALE;
        const ex = o.x - p.x, ez = o.z - p.z;
        const ts = [];
        if (a > 1e-9) {
          // standing person = upright cylinder; where does the line enter it?
          const b = 2 * (ex * d.x + ez * d.z), c = ex * ex + ez * ez - R * R, disc = b * b - 4 * a * c;
          if (disc >= 0) { const sq = Math.sqrt(disc); ts.push((-b - sq) / (2 * a), (-b + sq) / (2 * a)); }
        }
        if (Math.abs(d.y) > 1e-9) ts.push((SIDEWALK_HEIGHT + H - o.y) / d.y);   // the top of the head
        for (const t of ts) {
          if (!(t > 0 && t < max)) continue;
          const y = o.y + d.y * t, x = o.x + d.x * t - p.x, z = o.z + d.z * t - p.z;
          if (y >= SIDEWALK_HEIGHT && y < neck && x * x + z * z <= R * R * 1.0001 && (!best || t < best.t)) best = { index: i, t, head: false };
        }
        // the head: narrower than the body, from the neck up (side or top)
        const hts = [];
        if (a > 1e-9) {
          const b = 2 * (ex * d.x + ez * d.z), c = ex * ex + ez * ez - HR * HR, disc = b * b - 4 * a * c;
          if (disc >= 0) hts.push((-b - Math.sqrt(disc)) / (2 * a));
        }
        if (Math.abs(d.y) > 1e-9) hts.push((SIDEWALK_HEIGHT + H - o.y) / d.y);
        for (const t of hts) {
          if (!(t > 0 && t < max)) continue;
          const y = o.y + d.y * t, x = o.x + d.x * t - p.x, z = o.z + d.z * t - p.z;
          if (y >= neck && y <= SIDEWALK_HEIGHT + H + 1e-6 && x * x + z * z <= HR * HR * 1.0001 && (!best || t < best.t)) best = { index: i, t, head: true };
        }
      });
      return best;
    },
    // An explosion at (x, z): everyone within knockRadius falls over (away from it), everyone
    // within panicRadius runs away for about panicSeconds. People indoors notice nothing.
    // Something scary (a gunshot) at (x, z): everyone outside within radius runs away from it.
    alarm(x, z, radius, seconds) {
      let fled = 0;
      people.forEach((p, i) => {
        if (i >= MAX_PEOPLE || p.state === 'inside' || p.state === 'down' || p.state === 'gone') return;
        if (Math.hypot(p.x - x, p.z - z) <= radius) { panic(p, x, z, seconds); fled++; }
      });
      return fled;
    },
    blast(x, z, knockRadius, panicRadius, panicSeconds) {
      let down = 0, fled = 0;
      people.forEach((p, i) => {
        if (i >= MAX_PEOPLE || p.state === 'inside' || p.state === 'down' || p.state === 'gone') return;
        const dx = p.x - x, dz = p.z - z, dist = Math.hypot(dx, dz);
        if (dist <= knockRadius) { if (this.knockDown(i, { x: dx || 1e-3, y: 0, z: dz }, 'blast')) down++; }
        else if (dist <= panicRadius) { panic(p, x, z, panicSeconds); fled++; }
      });
      return { down, fled };
    },
    // people indoors within radius of (x, z) die (the nuke); returns how many
    killInside(x, z, radius) {
      let n = 0;
      people.forEach((p, i) => {
        if (i >= MAX_PEOPLE || p.state !== 'inside' || !p.insideAt) return;
        if (Math.hypot(p.insideAt[0] - x, p.insideAt[1] - z) <= radius) { p.state = 'gone'; died({ x: p.insideAt[0], z: p.insideAt[1] }, 'inside'); n++; }
      });
      return n;
    },
    // a building with footprint x0..x1 × z0..z1 comes down: everyone inside dies, people on the
    // street close to it are buried (knocked down), people further away run. Returns how many died.
    crush(x0, z0, x1, z1, margin = CRUSH_MARGIN, panicRadius = 3) {
      let n = 0;
      const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
      people.forEach((p, i) => {
        if (i >= MAX_PEOPLE || p.state === 'down' || p.state === 'gone') return;
        if (p.state === 'inside') {
          const q = p.insideAt;
          if (q && q[0] >= x0 - 0.1 && q[0] <= x1 + 0.1 && q[1] >= z0 - 0.1 && q[1] <= z1 + 0.1) { p.state = 'gone'; died({ x: q[0], z: q[1] }, 'collapse'); n++; }
          return;
        }
        const ox = Math.max(x0 - p.x, 0, p.x - x1), oz = Math.max(z0 - p.z, 0, p.z - z1), d = Math.hypot(ox, oz);
        if (d <= margin) { if (this.knockDown(i, { x: p.x - cx || 1e-3, y: -0.5, z: p.z - cz }, 'collapse')) n++; }
        else if (d <= panicRadius) panic(p, cx, cz, 10);
      });
      return n;
    },
    get deaths() { return deaths; },
    get people() { return people; },                            // read-only use (tests, other scripts)
    // someone jumps out of a car at (x, z) and runs away from (fromX, fromZ), screaming; returns their index
    addRunner(x, z, fromX, fromZ, seconds = 15) {
      if (!net || !net.edges.length || !V) return -1;
      const best = nearestEdge(x, z);                            // the nearest road line
      if (!best) return -1;
      // run the way that leads away from the danger
      const [ax, ay] = net.xy.get(best.a), [bx, by] = net.xy.get(best.b);
      const away = Math.hypot(bx - fromX, by - fromZ) > Math.hypot(ax - fromX, ay - fromZ);
      const p = newPerson(); p.x = x; p.z = z; p.side = 1;
      if (away) placeOnEdge(p, best.a, best.b, best.s); else placeOnEdge(p, best.b, best.a, 1 - best.s);
      // on the sidewalk on the car's side of the road
      const r = rightOf(p.dir[0], p.dir[1]), lx = ax + (bx - ax) * best.s, lz = ay + (by - ay) * best.s;
      p.side = r[0] * (x - lx) + r[1] * (z - lz) >= 0 ? 1 : -1;
      const off = sideOffset(p);
      p.state = 'exit'; p.from = [x, z]; p.to = [lx + off[0] * SIDEWALK_OFFSET, lz + off[1] * SIDEWALK_OFFSET];
      p.t = 0; p.dur = Math.hypot(p.to[0] - x, p.to[1] - z) / (p.speed * PANIC_SPEED) + 0.05;
      p.h = Math.atan2(p.to[0] - x, p.to[1] - z);
      p.next = [p.a, p.b]; p.nextS = p.s;
      p.panic = seconds; p.fleeFrom = [fromX, fromZ];
      // a free figure: a new one, or one that's gone
      let i = people.length < MAX_PEOPLE ? people.length : people.findIndex((q) => q.state === 'gone');
      if (i < 0) i = people.findIndex((q) => q.state === 'inside' && !q.child && !q.parent);
      if (i < 0) return -1;
      people[i] = p;
      scream(p, 0.1);
      return i;
    },
    behead(i, d) { return HEADSHOTS ? behead(i, d) : this.knockDown(i, d); },
    gib(i, x, z, power) { return gib(i, x, z, power); },
    // everyone within radius of (x, z) blown apart; returns how many
    gibAround(x, z, radius, power) {
      let n = 0;
      people.forEach((p, i) => { if (i < MAX_PEOPLE && p.state !== 'inside' && p.state !== 'gone' && Math.hypot(p.x - x, p.z - z) <= radius && gib(i, x, z, power)) n++; });
      return n;
    },
    knockDown(i, d, cause) {
      const p = people[i];
      if (!p || p.state === 'down' || p.state === 'gone' || !V) return false;
      const l = Math.hypot(d.x, d.z) || 1;
      p.state = 'down'; p.fall = 0;
      p.axis = new V(d.z / l, 0, -d.x / l);                    // horizontal axis ⟂ to the shot
      died(p, cause || 'shot');
      if (Math.random() < 0.3) scream(p, 0, true);
      if (BLOOD) bleed(p, d.x / l, d.y || 0, d.z / l);
      return true;
    },
  };
})();
