// ==UserScript==
// @name         Savings City – drive a car (walk mode)
// @namespace    savings-city-tweaks
// @version      1.3
// @description  In walk mode, walk up to a car and press E: the driver runs off and you drive it (W/S gas and brake, A/D steer, Space handbrake, C camera, E to get out). Bump into other cars, run people over; buildings, trees, lamps and fountains stop you.
// @match        https://your-savings-city-host.example/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * Needs the core script (city data, sound) and the walk-mode script (1.26 or newer): scWalk.setDriver lets this script move you and the
 * camera, scWalk.onKey gives it E, C and H, and scWalk.blocked / propsNear / trafficCars /
 * parkedCars tell it what's in the way. Works with residents (running people over) and cops
 * (officers can be run over: sc:crush).
 *
 * - Getting in: the nearest traffic car within ENTER_DISTANCE. The app's car is held for good
 *   (parked = Infinity) and hidden (its 3D proxy scaled to nothing, like rockets do); our own copy
 *   (the app's car geometry and material from its car batch) takes its place. The driver jumps
 *   out and runs away (residents' addRunner). A car you left behind can be taken again.
 * - Parked in a lane, the hidden traffic car is moved to where you left yours (as a parked car), so
 *   traffic queues behind it or overtakes it; see "parked cars that traffic sees".
 * - Driving: a simple bicycle model. W accelerates (less and less towards top speed), S brakes and
 *   then reverses, letting go rolls out slowly; steering turns the front wheels gradually and less
 *   at speed. Space is the handbrake. The body dips when braking, squats when accelerating and
 *   leans in corners.
 * - Kerbs and sidewalks don't stop you. Walls (walk mode's wall grid, the same as for walking),
 *   trees, lamps, benches and fountains (walk mode's props) do: the car bounces back a little.
 *   Other cars (traffic, parked on lots, ones you left, police cars of the cops script) are boxes:
 *   you're pushed apart and a traffic car you hit stops for a moment. No damage.
 * - People in front of the car when it moves are knocked down (dead); fast, they're blown apart.
 * - The camera: the driver's seat (bonnet in view, the mouse looks around), C switches to a camera
 *   behind the car. Ground height: road and sidewalk from the city data, lots from the buildings.
 * Units: tiles (1 tile ≈ 20 m); a car is 0.22 × 0.105.
 */
(function () {
  'use strict';

  // the core script, also when this script loads before it; sound through its output, which
  // follows the app's own sound button (mute + volume)
  const whenCore = (fn) => (window.scCore ? fn(window.scCore) : (window.scCoreWaiting = window.scCoreWaiting || []).push(fn));
  const out = (ctx) => (window.scCore ? window.scCore.out(ctx) : ctx.destination);

  // ---- settings (tiles, seconds; 1 tile ≈ 20 m, so 1 tile/s ≈ 72 km/h) ----
  const ENTER_DISTANCE = 0.2;      // how close you must be to a car's body to get in (any side, front or back)
  const MAX_SPEED = 80 / 72;       // top speed: 80 km/h
  const MAX_REVERSE = 25 / 72;     // 25 km/h backwards
  const ENGINE = 0.8;              // acceleration from standstill (less and less towards top speed: 0–80 in about 4 s)
  const BRAKE = 1.6;               // braking with S (80 → 0 in about 0.7 s)
  const HANDBRAKE = 2.5;           // Space
  const ROLL = 0.25;               // slowing down with no pedal pressed (+ air drag)
  const DRAG = 0.08;
  const WHEELBASE = 0.13;
  const STEER_MAX = 0.55;          // radians at standstill…
  const STEER_FALLOFF = 1.5;       // …less at speed: max / (1 + falloff × speed²)
  const STEER_RATE = 2.2;          // how fast the wheels turn (radians per second)
  const BOUNCE = 0.3;              // speed kept (reversed) after hitting something
  const BUMP_HOLD = 1.5;           // a traffic car you hit stands still this long
  const KILL_SPEED = 0.15;         // faster than this, people in front of the car are run over…
  const GIB_SPEED = 65 / 72;       // …faster than this (65 km/h), blown apart
  const EXIT_SPEED = 10 / 72;      // you can only get out below this (10 km/h)
  const EYE = 0.085;               // eye height above the car's bottom (driver's seat)
  const SEAT = [-0.012, -0.022];   // seat position in the car: back from the middle, left of it
  const CHASE = [0.55, 0.2];       // camera behind the car: distance and height
  const LOOK_SENSITIVITY = 0.0022;
  const SOUND = true;
  // -----------------------------------------

  const W = () => window.scWalk;
  const HX = 0.11, HZ = 0.0525;    // half length / width of a car
  const rnd = (a, b) => a + Math.random() * (b - a);
  let K = null;
  let car = null;                  // the car you're in: { mesh, x, z, h, y, v, steer, ... }
  const leftCars = [];             // cars you got out of: { mesh, x, z, h, y }
  let chase = false, lookYaw = 0, lookPitch = -0.05, lookIdle = 0, camPos = null, bumpAt = 0, shake = 0;

  // ---------- roads (ground height) ----------
  let segs = null;                 // per tile: road lines [ax, az, bx, bz]
  whenCore((c) => c.onCity((d) => { try { buildRoads(d.roads); } catch (e) { console.warn('[drive] roads', e); } }));
  function buildRoads(keys) {
    segs = new Map();
    for (const k of keys) {
      const [x, y, t] = String(k).split(','), ax = +x, az = +y, bx = t === 'h' ? ax + 1 : ax, bz = t === 'h' ? az : az + 1;
      for (let i = Math.min(ax, bx) - 1; i <= Math.max(ax, bx); i++) for (let j = Math.min(az, bz) - 1; j <= Math.max(az, bz); j++) {
        const key = i + ',' + j; (segs.get(key) || segs.set(key, []).get(key)).push([ax, az, bx, bz]);
      }
    }
  }
  function roadDistance(x, z) {
    const list = segs && segs.get(Math.floor(x) + ',' + Math.floor(z)); if (!list) return Infinity;
    let best = Infinity;
    for (const [ax, az, bx, bz] of list) {
      const cx = Math.max(Math.min(ax, bx), Math.min(Math.max(ax, bx), x)), cz = Math.max(Math.min(az, bz), Math.min(Math.max(az, bz), z));
      best = Math.min(best, Math.hypot(x - cx, z - cz));
    }
    return best;
  }
  let lotY = 0, lotAt = 0;
  function groundAt(x, z, now) {
    const d = roadDistance(x, z);
    if (d < 0.16) return 0.04;                                     // asphalt
    if (d < 0.25) return 0.036;                                    // sidewalk
    if (now - lotAt > 250) {                                       // a lot's paving (part of the buildings), now and then
      lotAt = now;
      const hit = W().rayBuildings({ x, y: 0.12, z }, { x: 0, y: -1, z: 0 }, 0.12);
      lotY = hit && 0.12 - hit.t < 0.06 ? 0.12 - hit.t : 0;
    }
    return lotY;
  }

  // ---------- boxes ----------
  const fwd = (h) => [Math.cos(h), Math.sin(h)];
  const side = (h) => [-Math.sin(h), Math.cos(h)];            // to the right of the car
  // How far box a (x, z, h, hx, hz) must move to get out of box b; null when they don't touch.
  function boxPush(a, b) {
    const axes = [fwd(a.h), side(a.h), fwd(b.h), side(b.h)], dx = b.x - a.x, dz = b.z - a.z;
    let best = null;
    for (const ax of axes) {
      const r = (o) => { const f = fwd(o.h), s = side(o.h); return o.hx * Math.abs(ax[0] * f[0] + ax[1] * f[1]) + o.hz * Math.abs(ax[0] * s[0] + ax[1] * s[1]); };
      const dist = dx * ax[0] + dz * ax[1], overlap = r(a) + r(b) - Math.abs(dist);
      if (overlap <= 0) return null;
      if (!best || overlap < best.d) best = { d: overlap, x: -Math.sign(dist || 1) * ax[0] * overlap, z: -Math.sign(dist || 1) * ax[1] * overlap };
    }
    return best;
  }
  // a circle (cx, cz, r) against box a: how far a must move to get out of it
  function circlePush(a, cx, cz, r) {
    const f = fwd(a.h), s = side(a.h), dx = cx - a.x, dz = cz - a.z;
    const lx = dx * f[0] + dz * f[1], lz = dx * s[0] + dz * s[1];
    const qx = Math.max(-a.hx, Math.min(a.hx, lx)), qz = Math.max(-a.hz, Math.min(a.hz, lz));
    const ex = lx - qx, ez = lz - qz, d = Math.hypot(ex, ez);
    if (d >= r) return null;
    let nx, nz, depth;
    if (d > 1e-6) { nx = ex / d; nz = ez / d; depth = r - d; }
    else if (a.hx - Math.abs(lx) < a.hz - Math.abs(lz)) { nx = Math.sign(lx) || 1; nz = 0; depth = a.hx - Math.abs(lx) + r; }
    else { nx = 0; nz = Math.sign(lz) || 1; depth = a.hz - Math.abs(lz) + r; }
    // (nx, nz) points from the box to the circle, in the box's coordinates; push the box the other way
    return { x: -(f[0] * nx + s[0] * nz) * depth, z: -(f[1] * nx + s[1] * nz) * depth };
  }
  // walls: walk mode's wall test (a 0.04 disc) at points spread over the car's outline
  const WALL_POINTS = [];
  for (const lx of [-0.07, -0.023, 0.023, 0.07]) for (const lz of [-0.013, 0.013]) WALL_POINTS.push([lx, lz]);
  function hitsWall(x, z, h) {
    const w = W(), f = fwd(h), s = side(h);
    return WALL_POINTS.some(([lx, lz]) => w.blocked(x + f[0] * lx + s[0] * lz, z + f[1] * lx + s[1] * lz));
  }
  // trees, lamps, benches, fountains standing near (x, z): [cx, cz, r]
  function propCircles(x, z) {
    const out = [], w = W();
    if (!w.propsNear) return out;
    for (const p of w.propsNear(x, z, 0.6)) {
      const c = p.parts && p.parts[0];
      const r = c && c.cyl ? c.r : p.radius || p.rc || 0.03;
      out.push([p.x, p.z, r + 0.004]);
    }
    return out;
  }
  // other cars as boxes: { x, z, h, hx, hz, traffic? }
  function otherCars() {
    const w = W(), list = [];
    const traffic = w.trafficCars() || [];
    for (const c of traffic) {
      if (!c || c === (car && car.source) || c.scTaken || c.scBurst || !Number.isFinite(c.x)) continue;
      list.push({ x: c.x, z: c.z, h: c.heading, hx: HX, hz: HZ, traffic: c });
    }
    for (const c of (w.parkedCars ? w.parkedCars() : [])) list.push({ x: c.x, z: c.z, h: c.heading, hx: HX, hz: HZ });
    for (const c of leftCars) list.push({ x: c.x, z: c.z, h: c.h, hx: HX, hz: HZ });
    const cops = window.scCops && window.scCops.cars ? window.scCops.cars() : [];
    for (const c of cops) if (c.own && !c.wreck) list.push({ x: c.x, z: c.z, h: 0, hx: 0.09, hz: 0.09 });
    return list;
  }

  // ---------- parked cars that traffic sees ----------
  // Every car you took keeps the app's traffic car it came from (hidden, held). Parked in a lane,
  // that traffic car is put exactly there as a parked car (its street from → to, how far along,
  // its lane), so the app's own traffic does what it does for parked cars: queues behind it, or
  // overtakes it when the other lane is free. While you drive, or when you park off the road (on
  // the sidewalk, a square, the grass), it waits off the map, where nobody meets it.
  const OFF_MAP = ['100000,100000', '100000,100001'];
  const LANE = 0.075;              // the app's lane offset from the road line (lane 1 = keep right)
  function hideGhost(t) {
    if (!t) return;
    Object.assign(t, { from: OFF_MAP[0], to: OFF_MAP[1], s: 0, lane: 1, prev: undefined, next: undefined, route: undefined, dest: undefined,
      side: undefined, parked: Infinity, speed: 0, passing: false, x: 100000, z: 100000 });
  }
  function park(c) {
    leftCars.push({ mesh: c.mesh, x: c.x, z: c.z, h: c.h, y: c.y, source: c.source });
    const t = c.source; if (!t) return;
    const lane = laneAt(c.x, c.z);
    if (!lane) { hideGhost(t); return; }
    Object.assign(t, { ...lane, prev: undefined, next: undefined, route: undefined, dest: undefined, side: undefined, parked: Infinity, speed: 0, passing: false, x: c.x, z: c.z });
  }
  // The street and lane a car standing at (x, z) is in: traffic keeps right, so it's in the way
  // of the direction it stands to the right of. Null when it's off the asphalt.
  function laneAt(x, z) {
    const list = segs && segs.get(Math.floor(x) + ',' + Math.floor(z)); if (!list) return null;
    let best = null;
    for (const [ax, az, bx, bz] of list) {
      const dx = bx - ax, dz = bz - az, s = Math.max(0, Math.min(1, (x - ax) * dx + (z - az) * dz));
      const px = ax + dx * s, pz = az + dz * s, d = Math.hypot(x - px, z - pz);
      if (!best || d < best.d) best = { d, ax, az, bx, bz, dx, dz, s, off: (x - px) * -dz + (z - pz) * dx };   // + = right of a → b
    }
    if (best.d > 0.19) return null;                                // on the sidewalk or beyond: in nobody's lane
    const along = best.off >= 0, A = `${best.ax},${best.az}`, B = `${best.bx},${best.bz}`;
    return { from: along ? A : B, to: along ? B : A, s: Math.min(0.98, Math.max(0.02, along ? best.s : 1 - best.s)),
      lane: Math.max(0.3, Math.min(2.5, Math.abs(best.off) / LANE)), heading: Math.atan2(along ? best.dz : -best.dz, along ? best.dx : -best.dx) };
  }

  // ---------- getting in ----------
  function candidates(x, z) {
    const w = W(), out = [];
    const traffic = w.trafficCars() || [], proxies = w.carObjects();
    // distance from (x, z) to a car's body (0 when touching it), so you can get in from any side
    const gap = (cx, cz, h) => {
      const f = fwd(h), s = side(h), dx = x - cx, dz = z - cz;
      return Math.hypot(Math.max(0, Math.abs(dx * f[0] + dz * f[1]) - HX), Math.max(0, Math.abs(dx * s[0] + dz * s[1]) - HZ));
    };
    traffic.forEach((c, i) => {
      if (!c || c.scTaken || c.scBurst || c.scFlat || !Number.isFinite(c.x)) return;
      const proxy = proxies.get(i); if (!proxy) return;
      const kind = proxy.userData.car && proxy.userData.car.kind;
      out.push({ d: gap(c.x, c.z, c.heading), traffic: c, index: i, proxy, police: kind === 'police' });
    });
    // your own cars (wherever they stand: road, sidewalk, grass) go first, before traffic passing by
    for (const c of leftCars) out.push({ d: gap(c.x, c.z, c.h) - 1, left: c });
    return out.filter((c) => c.d <= ENTER_DISTANCE).sort((a, b) => a.d - b.d);
  }
  function getIn() {
    const w = W();
    if (!K && !(K = w.classes())) return false;
    const pl = w.player, c = candidates(pl.x, pl.z)[0];
    if (!c) return false;
    let mesh, x, z, h, source = null;
    if (c.left) {
      ({ mesh, x, z, h, source } = c.left);
      leftCars.splice(leftCars.indexOf(c.left), 1);
      hideGhost(source);
    } else {
      // the app's car: held, hidden, and drawn by us from its batch's geometry
      let batch = null;
      w.scene.traverse((o) => { if (!batch && o.isInstancedMesh && Array.isArray(o.userData.cars) && o.userData.cars.includes(c.index)) batch = o; });
      if (!batch) return false;
      const t = c.traffic;
      if (t.scAbandoned === undefined && !c.police && window.scResidents && window.scResidents.addRunner) {
        const s = side(t.heading), dx = pl.x - t.x, dz = pl.z - t.z, away = s[0] * dx + s[1] * dz > 0 ? -1 : 1;   // the door away from you
        window.scResidents.addRunner(t.x + s[0] * 0.08 * away, t.z + s[1] * 0.08 * away, pl.x, pl.z);
      }
      t.parked = Infinity; t.speed = 0; t.scTaken = true;
      c.proxy.scale.setScalar(0.0001);
      mesh = new K.Mesh(batch.geometry, batch.material);
      mesh.castShadow = true; mesh.receiveShadow = true;
      mesh.rotation.order = 'YXZ';
      w.scene.add(mesh);
      x = t.x; z = t.z; h = t.heading; source = t;
      hideGhost(t);                                                // no invisible car left behind on the road
    }
    car = { mesh, x, z, h, y: 0.04, v: 0, steer: 0, pitch: 0, roll: 0, accel: 0, source };
    lookYaw = 0; lookPitch = -0.05; camPos = null;
    w.setDriver({ step });
    w.setHelp('W: gas · S: remmen / achteruit · A/D: sturen · spatie: handrem · muis: rondkijken · C: camera · H: toeter · E: uitstappen · Esc: stoppen');
    w.sound && w.sound('thud');
    engine(true);
    return true;
  }
  function getOut() {
    const w = W();
    if (!car) return;
    if (Math.abs(car.v) > EXIT_SPEED) { w.note && w.note('Eerst langzamer rijden'); return; }
    // out of the driver's door (left), or the other one if there's a wall
    const s = side(car.h);
    let x = car.x - s[0] * 0.12, z = car.z - s[1] * 0.12;
    if (w.blocked(x, z)) { x = car.x + s[0] * 0.12; z = car.z + s[1] * 0.12; }
    park(car);
    car.mesh.rotation.set(0, -car.h, 0);
    car = null;
    engine(false);
    w.setDriver(null);
    w.setHelp(null);
    w.moveTo(x, z);
  }

  // ---------- driving (called by walk mode every frame) ----------
  function step(dt, keys, look) {
    const w = W(), c = car, now = performance.now();
    const down = (...k) => k.some((code) => keys.has(code));
    const gas = down('KeyW', 'ArrowUp'), brake = down('KeyS', 'ArrowDown'), hand = down('Space');
    const steerIn = (down('KeyD', 'ArrowRight') ? 1 : 0) - (down('KeyA', 'ArrowLeft') ? 1 : 0);
    // pedals
    let a = 0;
    if (gas && c.v >= -0.05) a = ENGINE * Math.max(0, 1 - c.v / MAX_SPEED);
    else if (gas) a = BRAKE;                                       // rolling back: W brakes first
    if (brake && c.v > 0.05) a = -BRAKE;
    else if (brake) a = -ENGINE * 0.6 * Math.max(0, 1 + c.v / MAX_REVERSE);
    const sign = Math.sign(c.v);
    if (!gas && !brake) a -= sign * ROLL;
    a -= DRAG * c.v * Math.abs(c.v);
    if (hand) a -= sign * HANDBRAKE;
    const v0 = c.v;
    c.v += a * dt;
    if (!gas && !brake && Math.sign(c.v) !== sign) c.v = 0;        // rolling out / braking stops, it doesn't reverse
    if (hand && Math.sign(c.v) !== sign) c.v = 0;
    if (brake && v0 > 0 && c.v < 0) c.v = 0;
    if (gas && v0 < 0 && c.v > 0) c.v = 0;
    c.accel += ((c.v - v0) / Math.max(dt, 1e-4) - c.accel) * Math.min(1, dt * 6);
    // steering: the wheels turn gradually, less at speed
    const max = STEER_MAX / (1 + STEER_FALLOFF * c.v * c.v), target = steerIn * max;
    const rate = steerIn ? STEER_RATE : STEER_RATE * 1.5;
    c.steer += Math.max(-rate * dt, Math.min(rate * dt, target - c.steer));
    // move in small steps, so nothing is skipped at speed
    const n = Math.max(1, Math.ceil(Math.abs(c.v) * dt / 0.025));
    let hit = false;
    for (let k = 0; k < n && !hit; k++) {
      const sd = dt / n, h1 = c.h + c.v * Math.tan(c.steer) / WHEELBASE * sd * (hand ? 1.6 : 1);
      const f = fwd(h1), x1 = c.x + f[0] * c.v * sd, z1 = c.z + f[1] * c.v * sd;
      if (hitsWall(x1, z1, h1)) { hit = true; break; }
      const me = { x: x1, z: z1, h: h1, hx: HX, hz: HZ };
      let push = null;
      for (const [px, pz, r] of propCircles(x1, z1)) { push = circlePush(me, px, pz, r); if (push) break; }
      if (push) { hit = true; break; }
      c.x = x1; c.z = z1; c.h = h1;
    }
    if (hit) bump(Math.abs(c.v));
    // other cars: pushed apart (also when one drives into you), traffic you hit stops a moment
    for (const o of otherCars()) {
      if (Math.abs(o.x - c.x) > 0.4 || Math.abs(o.z - c.z) > 0.4) continue;
      const p = boxPush({ x: c.x, z: c.z, h: c.h, hx: HX, hz: HZ }, o);
      if (!p) continue;
      if (!hitsWall(c.x + p.x, c.z + p.z, c.h)) { c.x += p.x; c.z += p.z; }
      const f = fwd(c.h), along = (p.x * f[0] + p.z * f[1]) / (Math.hypot(p.x, p.z) || 1);
      if (along * c.v < 0) bump(Math.abs(c.v) * Math.abs(along));   // we drove into it
      if (o.traffic && o.traffic.parked !== Infinity) { o.traffic.parked = Math.max(o.traffic.parked || 0, BUMP_HOLD); o.traffic.speed = 0; }
    }
    runOver(c);
    // height, body motion
    c.y += (groundAt(c.x, c.z, now) - c.y) * Math.min(1, dt * 12);
    c.pitch += (Math.max(-0.06, Math.min(0.06, -c.accel * 0.012)) - c.pitch) * Math.min(1, dt * 8);
    const lateral = c.v * c.v * Math.tan(c.steer) / WHEELBASE;
    c.roll += (Math.max(-0.05, Math.min(0.05, lateral * 0.006)) - c.roll) * Math.min(1, dt * 6);
    c.mesh.position.set(c.x, c.y, c.z);
    c.mesh.rotation.set(c.roll, -c.h, c.pitch);
    engineSound(c, gas);
    speedo(c.v);
    // looking around (the mouse), easing back to straight ahead while driving
    if (look.x || look.y) { lookYaw -= look.x * LOOK_SENSITIVITY; lookPitch -= look.y * LOOK_SENSITIVITY; lookIdle = 0; }
    else if ((lookIdle += dt) > 1.2 && Math.abs(c.v) > 0.3) lookYaw *= Math.max(0, 1 - dt * 2.5);
    lookYaw = Math.max(-2.4, Math.min(2.4, lookYaw));
    lookPitch = Math.max(-1.1, Math.min(0.8, lookPitch));
    shake = Math.max(0, shake - dt * 3);
    const yaw = -Math.PI / 2 - c.h + lookYaw, f = fwd(c.h), s = side(c.h);
    const j = () => (Math.random() - 0.5) * shake * 0.01;
    const eye = c.y + EYE;
    if (!chase) {
      const sx = c.x + f[0] * SEAT[0] + s[0] * SEAT[1], sz = c.z + f[1] * SEAT[0] + s[1] * SEAT[1];
      return { x: c.x, z: c.z, eye, yaw, pitch: lookPitch - c.pitch * 0.6, roll: c.roll * 0.5, cam: { x: sx + j(), y: eye + j(), z: sz + j() } };
    }
    // behind the car (closer when a wall is in the way), following smoothly
    let dist = CHASE[0];
    const back = (d) => [c.x + Math.sin(yaw) * d, c.z + Math.cos(yaw) * d];   // the view looks along (−sin yaw, −cos yaw)
    while (dist > 0.15 && w.blocked(...back(dist))) dist -= 0.07;
    const [tx, tz] = back(dist), ty = c.y + CHASE[1];
    if (!camPos) camPos = { x: tx, y: ty, z: tz };
    const k = Math.min(1, dt * 7);
    camPos.x += (tx - camPos.x) * k; camPos.y += (ty - camPos.y) * k; camPos.z += (tz - camPos.z) * k;
    const pitch = Math.atan2(c.y + 0.06 - camPos.y, Math.hypot(c.x - camPos.x, c.z - camPos.z)) + lookPitch + 0.05;
    const cy = Math.atan2(-(c.x - camPos.x), -(c.z - camPos.z));
    return { x: c.x, z: c.z, eye, yaw: cy, pitch, cam: { x: camPos.x + j(), y: camPos.y + j(), z: camPos.z + j() } };
  }
  function bump(speed) {
    const now = performance.now();
    if (car) car.v = -car.v * BOUNCE;
    if (Math.abs(car ? car.v : 0) < 0.03 && car) car.v = 0;
    shake = Math.min(1, shake + speed * 0.6);
    if (speed > 0.15 && now - bumpAt > 300) { bumpAt = now; thud(Math.min(1, speed / 2)); }
  }

  // people (and officers) in front of a moving car
  function runOver(c) {
    if (Math.abs(c.v) < KILL_SPEED) return;
    const f = fwd(c.h), s = side(c.h), dir = { x: f[0] * Math.sign(c.v), y: 0, z: f[1] * Math.sign(c.v) };
    const inside = (x, z, m) => { const dx = x - c.x, dz = z - c.z; return Math.abs(dx * f[0] + dz * f[1]) < HX + m && Math.abs(dx * s[0] + dz * s[1]) < HZ + m; };
    const res = window.scResidents;
    if (res && res.people) {
      const P = res.people;
      for (let i = 0; i < P.length; i++) {
        const p = P[i];
        if (p.state === 'inside' || p.state === 'down' || p.state === 'gone') continue;
        if (Math.abs(p.x - c.x) > 0.2 || Math.abs(p.z - c.z) > 0.2 || !inside(p.x, p.z, 0.012)) continue;
        if (Math.abs(c.v) >= GIB_SPEED && res.gib) res.gib(i, c.x - dir.x * 0.1, c.z - dir.z * 0.1, Math.abs(c.v) * 0.7);
        else res.knockDown(i, dir, 'car');
        W().sound && W().sound('hit');
        shake = Math.min(1, shake + 0.3);
      }
    }
    const cops = window.scCops && window.scCops.officers ? window.scCops.officers() : [];
    for (const o of cops) {
      if ((o.state === 'exit' || o.state === 'fight') && inside(o.x, o.z, 0.012)) {
        window.dispatchEvent(new CustomEvent('sc:crush', { detail: { x0: o.x - 0.001, z0: o.z - 0.001, x1: o.x + 0.001, z1: o.z + 0.001, margin: 0.01 } }));
        W().sound && W().sound('hit');
      }
    }
  }

  // ---------- on-screen: speed, and "E: instappen" near a car ----------
  let speedEl = null;
  function speedo(v) {
    if (!speedEl) {
      speedEl = document.createElement('div');
      speedEl.id = 'sc-drive-speed';
      speedEl.style.cssText = 'position:fixed;right:18px;bottom:78px;z-index:10000;pointer-events:none;font:700 22px/1 system-ui,sans-serif;color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.7);text-align:right';
      document.body.appendChild(speedEl);
    }
    speedEl.style.display = v === null ? 'none' : '';
    if (v !== null) speedEl.innerHTML = `${Math.round(Math.abs(v) * 72)}<span style="font-size:12px;font-weight:600;margin-left:3px">km/u</span>`;
  }
  let hintAt = 0;
  function hint() {
    const w = W();
    if (!w || !w.walking || car || !w.note) return;
    const now = performance.now();
    if (now - hintAt < 1500) return;
    const pl = w.player;
    if (candidates(pl.x, pl.z).length) { hintAt = now; w.note('E: instappen', 1400); }
  }
  setInterval(() => { try { hint(); } catch {} }, 400);

  // ---------- keys (through walk mode) ----------
  function hook() {
    const w = W();
    if (hook.done || !w || !w.onKey || !w.setDriver) return;
    hook.done = true;
    w.onKey((code, e) => {
      if (code === 'KeyE') { if (!e.repeat) { if (car) getOut(); else getIn(); } return true; }
      if (!car) return false;
      if (code === 'KeyC') { if (!e.repeat) { chase = !chase; camPos = null; } return true; }
      if (code === 'KeyH') { if (!e.repeat) horn(); return true; }
      return false;
    });
  }
  window.addEventListener('sc:walk', (e) => {
    hook();
    if (!e.detail.walking && car) {                                // walk mode stopped: the car stays where it is
      park(car);
      car = null; engine(false);
    }
    speedo(null);
  });
  let tries = 0;
  const poll = setInterval(() => { if (W() && W().onKey) { hook(); clearInterval(poll); } else if (++tries > 120) clearInterval(poll); }, 1000);

  // ---------- sounds (synthesised) ----------
  let audio = null, eng = null;
  function ctx() { audio = audio || new AudioContext(); if (audio.state === 'suspended') audio.resume(); return audio; }
  function engine(on) {
    if (!SOUND) return;
    try {
      if (on && !eng) {
        const a = ctx(), o1 = a.createOscillator(), o2 = a.createOscillator(), f = a.createBiquadFilter(), g = a.createGain();
        o1.type = 'sawtooth'; o2.type = 'square'; o1.frequency.value = 38; o2.frequency.value = 19;
        f.type = 'lowpass'; f.frequency.value = 380; f.Q.value = 2;
        g.gain.value = 0;
        const g2 = a.createGain(); g2.gain.value = 0.5;
        o1.connect(f); o2.connect(g2); g2.connect(f); f.connect(g); g.connect(out(a));
        o1.start(); o2.start();
        eng = { o1, o2, f, g, a };
        g.gain.setTargetAtTime(0.06, a.currentTime, 0.2);
      } else if (!on && eng) {
        const e = eng; eng = null;
        e.g.gain.setTargetAtTime(0, e.a.currentTime, 0.1);
        setTimeout(() => { try { e.o1.stop(); e.o2.stop(); } catch {} }, 600);
      }
    } catch {}
  }
  function engineSound(c, gas) {
    if (!eng) return;
    const t = eng.a.currentTime, rev = 38 + Math.abs(c.v) * 95 + (gas ? 14 : 0);
    eng.o1.frequency.setTargetAtTime(rev, t, 0.08); eng.o2.frequency.setTargetAtTime(rev / 2, t, 0.08);
    eng.f.frequency.setTargetAtTime(300 + Math.abs(c.v) * 600 + (gas ? 200 : 0), t, 0.1);
    eng.g.gain.setTargetAtTime(0.05 + (gas ? 0.04 : 0) + Math.abs(c.v) * 0.035, t, 0.1);
  }
  function thud(level) {
    if (!SOUND) return;
    try {
      const a = ctx(), t = a.currentTime, o = a.createOscillator(), g = a.createGain();
      o.type = 'sine'; o.frequency.setValueAtTime(110, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.18);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25 + level * 0.4, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
      o.connect(g); g.connect(out(a)); o.start(t); o.stop(t + 0.27);
      const n = a.createBufferSource(), buf = a.createBuffer(1, a.sampleRate * 0.15, a.sampleRate), ch = buf.getChannelData(0);
      for (let i = 0; i < ch.length; i++) ch[i] = (Math.random() * 2 - 1) * (1 - i / ch.length) ** 3;
      const ng = a.createGain(); ng.gain.value = 0.15 + level * 0.3; n.buffer = buf; n.connect(ng); ng.connect(out(a)); n.start(t);
    } catch {}
  }
  function horn() {
    if (!SOUND) return;
    try {
      const a = ctx(), t = a.currentTime, g = a.createGain(), f = a.createBiquadFilter();
      f.type = 'bandpass'; f.frequency.value = 900; f.Q.value = 1.2;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.18, t + 0.02); g.gain.setValueAtTime(0.18, t + 0.4); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
      for (const fq of [400, 500]) { const o = a.createOscillator(); o.type = 'square'; o.frequency.value = fq; o.connect(f); o.start(t); o.stop(t + 0.52); }
      f.connect(g); g.connect(out(a));
    } catch {}
    // people close in front jump aside… well, they run
    const res = window.scResidents;
    if (car && res && res.alarm) { const f = fwd(car.h); res.alarm(car.x + f[0] * 0.5, car.z + f[1] * 0.5, 0.6, 3); }
  }

  window.scDrive = { get driving() { return !!car; }, get car() { return car && { x: car.x, z: car.z, h: car.h, v: car.v, steer: car.steer, y: car.y }; },
    getIn: () => getIn(), getOut: () => getOut(),
    get chase() { return chase; }, set chase(v) { chase = !!v; camPos = null; },
    place(x, z, h) { if (car) { car.x = x; car.z = z; if (h !== undefined) car.h = h; car.v = 0; } } };   // place: for tests
})();
