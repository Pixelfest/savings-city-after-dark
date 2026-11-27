# Savings City – context for working on these scripts

Notes for future sessions: what the Savings City app is, how its 3D city is built internally, and
how these Tampermonkey scripts get into it. Everything here was worked out by reading the app's
minified bundles (no source code was available) and is true for the versions seen in Nov 2026
(bundles `index-BErtZ7Ms.js` + lazy-loaded `CityCanvas-HITv6BJv.js` + `index-CfR_kx9B.css` of 27 Nov
2026; before that `index-CF0NHCg9.js` + `CityCanvas-kvJpXrfx.js` of 26 Nov, `index-Cj0dj4Sy.js` +
`CityCanvas-CcnEJIm2.js` of 25 Nov,
`index-CuJOOrbL.js` + `CityCanvas-D7u1hgTg.js`, and `CityCanvas-D-BN8eQV.js`).
Minified names (`Jf`, `Q`, `qp` …) change with every app build – find things by their shape/strings.

**This repository is public.** Never write the real app's address, its owner, people's names or
real project data here – see "Privacy rules" in `AGENTS.md`. Where an address is needed, use the
placeholder `https://your-savings-city-host.example/`.

## The app

- URL: private – not in this repository. The scripts `@match` the placeholder
  `https://your-savings-city-host.example/*`; users put the real address in Tampermonkey (see `README.md`).
- A Dutch "savings city": projects (buildings) are placed on a tile grid, connected by roads, cars
  drive around, winter/Christmas season and day/night from a clock (see "Clock, season, daylight").
- React + **three.js r186** (`WebGLRenderer`, one `Scene`, an **orthographic** camera seen from above).
- City data: `GET /api/city` → `{ projects: [{ id, gx, gy, facing, … }], roads: ["x,y,h|v", …], water: ["x,y", …], revision }`
  (`water`, since the 27 Nov build: tiles of lakes/canals, edited with `POST`/`DELETE /api/water {keys}`).
  While the page is open the app polls `GET /api/city/changes?since=<revision>` → 204 (nothing new),
  `{ reset: true }` (reload `/api/city`) or `{ revision, projects, deleted_projects, roads: {add, remove}, water: {add, remove} }`.
  Auto layout (2.5) empties `water` in both, places the city next to the welcome sign and blocks `/api/water` edits.
  `facing` 0 = N, 1 = E, 2 = S, 3 = W (front door side).
- The 3D code is in a lazily loaded chunk (`assets/CityCanvas-*.js`); it is not in a "Save page as"
  download – fetch it separately (DevTools → Network) when you need to read it.
- A copy of the app is in `app/`: `Savings City.html` + `Savings City_files/`
  (`index-BErtZ7Ms.js` = React app + shared code, `CityCanvas-HITv6BJv.js` = three.js r186 and the
  whole city/traffic/rendering code, `index-CfR_kx9B.css` – all 27 Nov 2026; logo and the HTML's
  references were updated to them). The copy is anonymised: the real host is replaced by the placeholder, the
  project names in the saved page are made up and the totals are those of the test city. The local
  runner picks up whatever `index-*.js` / `index-*.css` is there. Search it rather than reading it:
  it's minified, one line per file (e.g. `grep -o '.{300}isMeshBasicMaterial.{300}'`). When a
  developer brings in a newer copy, follow `AGENTS.md` → "Updating the app files".
- Menu buttons live in `.hz-tr .menu-mini` (scripts add `button.icon-btn.small` there).

## Clock, season, daylight (26 Nov 2026 build)

- `clock = V_()`: `Date.now`, or with `?date=YYYY-MM-DD` / `?time=HH:MM` (Europe/Amsterdam) a clock
  that starts at that moment, running `?timelapse=N` times as fast (any N > 0; 1e-6 ≈ stopped).
  Read once, when the city view is constructed (class field), only for season and daylight.
- `season = pv(date)`: `{ snow: month 11–2, christmas: Nov – 6 Jan }`. **`?winter=` is gone.** Snow
  patches three.js' shaders (`pf()`) and adds a snowfall layer (camera layer 1); Christmas adds
  lights, wall glows and a Christmas square. Can't be switched off live.
- `updateDaylight` (every 250 ms): the real sun position at a fixed place in the Netherlands (constant in the bundle) for the
  clock → sun direction/colour/intensity, sky, fog, `night` (1 − smoothstep(−5°, 4°, altitude)),
  `sun.shadow.intensity`. At night (`night` ≥ a threshold) the frame is drawn through a bloom
  `EffectComposer` (render targets) instead of a plain `renderer.render(scene, camera)`; lamp posts,
  car lights and a "night map" (light pools) light the city.
- Renderer: `antialias`, `alpha`, `setPixelRatio(min(devicePixelRatio, 2))`, PCF shadows from the
  sun (`DirectionalLight`, 2048² map with a depth texture), AgX tone mapping (7). No ambient
  occlusion of its own (the graphics script adds one).
- The graphics script uses all this: winter / day-night settings write `?date`/`?time`/`?timelapse`
  at document-start (remembering what it wrote in localStorage `sc-graphics:url`, so parameters
  typed by hand win); shadows toggle `sun.castShadow` + `shadowMap.enabled`; pixel size wraps
  `setPixelRatio` (core `onRenderer`); SSAO draws the frame through core `onDraw` (scene into a
  HalfFloat MSAA target with a FloatType depth texture – 24-bit depth was too coarse over the
  camera's 1…400 range – then an AO pass and a blurred composite with tone mapping; classes
  borrowed from the sun's shadow map). `window.scGraphics.ao.U.show.value = 1` shows the AO buffer.
  Graphics 1.2: the AO was there but too faint to see (radius 0.25, intensity 1.4); now radius 0.45,
  intensity 2.0 and an angle bias of 0.3 (was 0.15) so flat ground seen at a grazing angle in walk
  mode doesn't shade itself. `show.value = 2` shows the normals (cyan/pink), not the raw AO.
  **Graphics 1.3 (27 Nov build):** the app draws every frame through its bloom composer
  (`this.bloom.render(scene, camera)`, a render target, not only at night). Graphics 1.2 skipped the
  AO when a target was set, so it silently stopped working. Now the scene goes into the AO's own
  target, and the AO output goes back into the composer's target (`prev`) for the composer to finish
  (tone mapping and colour space come from its last pass). Daylight only: `scCore.view().night > 0.5`
  skips it. Check with `window.scGraphics.ao.state()` (`frames` grows when it runs).
  **Graphics 1.4:** the composer's render pass clears its own target and then renders with
  `renderer.autoClear = false`, so the AO's scene target was never cleared and every frame piled
  onto the last (anything moving – rain, snow, cars – smeared into streaks). The AO now clears its
  scene target (`renderer.clear()`) before drawing into it.

## Night lights and lights out (core 1.6, buildings 1.5, nuke 3.5)

Most night light is not in the scene graph, so breaking geometry doesn't switch it off (before
these versions a nuke left halos of light where buildings had stood):

- **Night map:** light pools drawn into a texture (`view.nightMap`, its own pass) that the
  materials sample. Static entries (`view.staticLights`) come from `gatherStaticLights()`, which
  runs when `view.staticLightsDirty` is set and reads `view.placed` (per finished building: a
  `Rect` + a `Glow` per footprint rect) and `view.lamps` (per lamp: a `Lamp` pool + a `Glow`).
  Car lights are added every frame.
- **Christmas:** bulbs (`view.lights`, Points) and wall glows (`view.wallGlows`, an additive Mesh)
  from `syncLights()` when `view.lightsDirty` is set, per project from `view.entries` (Map by id).
- **Street lamps:** `view.lamps` = road lamps (also in `view.lampPosts.object`: pole and head
  InstancedMeshes, instance i = lamp i; the heads' emissive follows the night) followed by the
  highway lamps (merged into the road mesh). Glow sprites: `view.lampGlow` (Points, one per lamp
  in the same order, colour in `aColor`, additive). All set again when the roads change.
- **Lit windows:** the facade shader lights random panes when its `uNight` uniform is > 0.

`view` is the app's city class, found through React (`scCore.view()`): the canvas' container div's
`__reactFiber$…` → up the fibers → a hook whose ref holds an object with `staticLights`, `nightMap`
and `gatherStaticLights`. The core wraps `gatherStaticLights` and `syncLights` on that instance and,
while they run, swaps in `placed` / `lamps` / `entries` without the dark buildings and dead lamps;
`lampGlow.set` is wrapped to darken again after the app resets the lamps.

- `scCore.lightsOut(id | ids)` – a building's glow, bulbs and wall glows go out (buildings calls it
  when a building comes down or is claimed by the nuke).
- `scCore.lampsOut(x, z, r, { fell })` – lamps within r: glow sprite black, head swapped into an
  unlit copy of the heads mesh (`userData.scDarkHeads`); `fell` (bool or `fn(d, lamp)`) also
  removes the post. Every `blast` on the damage bus (except `source: 'nuke'`) does this for its radius;
  the nuke does it as its front passes, `fell` where `keepHeight(d)` < 0.47.
- `scCore.darkFacade(mat)` – a cached clone of the facade material whose `uNight` is its own 0
  (same shader program). Chunks of a building that is down, and the nuke's chunk set, use it.

## Scale

- 1 tile = 1 unit ≈ 20 m. Floor height `hf = 0.22`. Building base at y = 0.03.
- Car: 0.22 long, 0.105 wide (≈ 4.5 m). Roads: sidewalk top y = 0.036 (half-width 0.25),
  asphalt top y = 0.04 (half-width 0.16). Residents (our script) ≈ 0.135 tall.

## Getting into three.js (no app code is changed)

- **Renderer/scene** (in the core): three.js dispatches `observe` events on `window.__THREE_DEVTOOLS__` (an
  `EventTarget`) for every new renderer/scene if that object exists → scripts create it at
  `document-start` and catch the `WebGLRenderer`; wrapping `renderer.render` reveals the scene (first
  render with an `OrthographicCamera`). Walk mode swaps in its own `PerspectiveCamera` there.
- **Classes:** there is no global `THREE`. Borrow constructors from objects in the scene: Mesh,
  InstancedMesh, materials, `Color`, `Matrix4`, `Vector3`, `Quaternion` from instances;
  `BufferGeometry` = the prototype that owns `translate`; `Object3D` = prototype of the scene that
  owns `add`; `PerspectiveCamera` = parent class of `renderer.xr.getCamera()`; `BufferAttribute` =
  `geometry.attributes.position.constructor`.
- **BufferGeometry prototype trap** (in the core, `onGeometryProto`): a one-time setter for `isBufferGeometry` on `Object.prototype`
  reveals `BufferGeometry.prototype` the first time three.js constructs one (used to patch
  `translate`/`rotateY`). Car tyres and walk mode both use it and **chain** an existing trap.
- **Traffic cars** (in the core, `traffic()`): the app moves cars with `traffic.cars.forEach(...)` every frame; hooking
  `Array.prototype.forEach` reveals the array (objects with `base`, `heading`, `from`, `to`, `speed`,
  `boost`, `parked`, `x`, `z`, `s`). Setting `car.parked = Infinity; car.speed = 0` stops one.
  Car i's 3D proxy is the object with `userData.car.index === i` (its `matrixWorld` is copied into
  the car batch every frame; scaling the proxy hides/squashes the car). Batches: `InstancedMesh`
  with `userData.cars` (array of car indices).
- **Helicopter** (since 25 Nov): one object with `userData.kind === 'helicopter'`, moved by the app every
  frame (lands on parking lots / roofs). **Cranes:** a group per building under construction: a mast
  mesh plus a head group (rotated by the app) with a hook (`BoxGeometry(0.22, 0.06, 0.1)`) and cable.
  To hide one of these for good, pin its `visible` to false with `Object.defineProperty` (the app
  sets `visible` itself).
- **Billboard:** one group (`userData.kind === 'billboard'`) at the first welcome-sign tile: panel
  `BoxGeometry(3.4, 1.7, 0.1)` at (2, 2.1, 1) with materials `[side×4, logo, logo]` (logo = canvas
  texture) and two posts `BoxGeometry(0.12, 1.3, 0.12)` at x 0.8 / 3.2. Built once, never rebuilt.
- **Squares** (merged, vertex colours): street lamps (post `#4b5058`, head `#f3e3a6`), benches (seat
  and back `#a0703c` on legs `#4b5058`), fountains (stone `#cfc6b6`, water `#69c3e6`; round with
  cylinders or square with boxes, up to 0.84 across).
- **Sound setting:** the app's sound button stores `citysaver:muted` ('1' = muted) and
  `citysaver:volume` (0…1, default 0.6; its level is volume²) in localStorage. Every script that
  plays sound sends it through one gain node (`out(ctx)`) that copies this setting twice a second,
  so muting also silences sounds already playing (sirens).
- **Overlay layer:** the app adds its layers in one call `scene.add(greenery, between, billboard,
  roads, buildings, chunks, cars, carBatches, exhaust, overlay)`; the last one holds selection/hover.
- **The app's own helpers** (in the core, `app()`; used by auto layout, residents, walk mode): the main module is imported again
  (`import(script.src)` → the same, already loaded instance) for exact footprints and front doors.
  Its export names are minified and **change with every build** (25 Nov: rotate moved from `A` to
  `j`, floors `w` → `T`, footprint cells `S` → `C`, which broke auto layout). So the scripts find
  them by the shape of their code (`findHelpers(m)`: regexes on `Function.prototype.toString`) and
  expose them under the old letters: `v` placed projects, `A` rotate, `a` door road keys, `w` floors,
  `S` cells, `n` welcome-sign tiles (an exported array of integer pairs; since the 27 Nov build the
  4-direction table `[[0,-1],[1,0],[0,1],[-1,0]]` is exported too and must be skipped – core 1.7;
  27 Nov: sign tiles x −6…−3, y −5…−4). Each pattern matches exactly one function in both builds; if a
  build changes a helper's code, update the regex (grep the new bundle for the old code's shape).
- **Response hooks:** `/api/city` can be read/changed by wrapping `fetch` / `Response.prototype.json`
  (auto layout does this).

## How the city is built

- **Per project:** a `Group` at `(gx, 0, gy)` with `userData.projectId` (also set on all children),
  normally `visible = false`. It contains:
  - the **facade mesh**: indexed geometry made of quads (4 vertices each) – per box ("mass", one per
    floor tier): 4 walls + 1 top. Material = facade material (`Lambert` with `map`, `vertexColors`,
    `customProgramCacheKey() === 'facade'`; shader: `diffuse *= texel.rgb; diffuse *= mix(vColor, 1, texel.a)`).
    Wall UVs: `u` = distance along the wall / (wall length / round(length / 0.5)), `v = y / 0.22`
    (windows). Tops use the plain spot `uv = (0.04, 0.96)` (texel alpha 0 → vertex colour shows).
  - a base slab (`#9a9894`, y 0–0.03), roof details (gable roofs, rooftop boxes, spires, cones),
    the lot (paving, trees, bushes) – merged vertex-coloured meshes.
- **City blocks ("chunks"):** what you actually see. For every 16×16-tile block the app merges all
  projects' meshes (world coordinates, non-indexed, uv added) into one mesh with material `[facade]`.
  Rebuilt when data changes → scripts that remove triangles must re-apply after a rebuild.
- **Houses** use the same facade boxes (`If(rects, height, 0.03, colour, roofColour)`) plus gable roofs.
- **Cars:** model = merged boxes (body `0.22×0.045×0.105` at y 0.022, glass cabin `#5fe0d8`, roof,
  lights `#fff6c2`, 4 tyres `0.044×0.04×0.016` colour `#2a2a2e` at z = ±0.0445, taxi/police extras),
  cached per variant (`sedan:0..5`, `taxi`, `police`, `sport`). Parked cars on parking lots are clones
  of it baked into the lot ground mesh (`clone → rotateY → translate(x, 0.03, z)`).
  New in Nov 2026: barrel roll, exhaust particles, speeding tickets.
- **Trees:** on open land = 3 `InstancedMesh`es side by side (trunk Box `0.045×0.12×0.045`, crown
  Icosahedron r 0.11, top Icosahedron r 0.075), one instance per tree. On lots/squares = merged:
  brown trunk box `#8a5a3b` + two green icosahedron balls. Christmas trees (winter) are cones.
- **Street lamps:** merged into the squares/junctions mesh: post `#4b5058` (0.024 × 0.32 from
  y 0.03) + head `#f3e3a6` (0.06 × 0.03 × 0.06).
- **Road boxes:** asphalt is one instanced box per segment (normal roads 1 × 0.04 × 0.32 with
  sidewalk blocks 0.5 wide beside them; **highway** segments 1 × 0.04 × 0.48 and no sidewalks;
  junction squares 0.48 × 0.48). Highway segments are merged with their **highway lamps** (post 0.024 ×
  0.42 from y 0, head 0.08 × 0.06 × 0.08 at y 0.42) into one **indexed** mesh (`Yp` keeps the index of
  box geometry), unlike the other merged meshes. Walk mode 1.32 flattens such a mesh (only if it holds a
  prop colour) before it cuts props out of it; residents find highways by the 0.48 boxes.
- Colours in vertex attributes are **linear** (three.js colour management converts hex sRGB).

## Scripts and how they talk to each other

| Script | Exposes / uses |
|---|---|
| core | `window.scCore`: `settings` (`define({ id, label, min, max, step, value, format, help })`, or `type: 'toggle'`, or `options: [names]` (value = index), `reload: true` = applies after a reload; `get`, `set`, `onChange`; popup from a menu button, stored in localStorage `sc-settings`), `detail()` → `{ level 1…5, factor 1…16 }` (scripts multiply piece budgets by it), `renderer`, `scene`, `camera` (the app's orthographic one), `classes()`, `city` / `onCity(fn)`, `traffic()`, `out(ctx)` / `audio()` (sound), `onFrame(fn(dt, now))`, `smoke(kind, x, y, z, opts)` / `smokeStats()`, `puff(x, y, z, opts)`, `damage(ev)` / `onDamage(fn)`, `isFacade(m)`, `projectOf(o)` |
| buildings | `window.scBuildings` (see "Solid buildings"); handles `damage` events of kind `blast` / `impact` (crater + hit) and `push` (pushed over) |
| walk mode | `window.scWalk` (hit tests, effects, sounds, props, cars) and `window.scWalkWeapons.push(def)` for plugin weapons; listens to `sc:geometry-changed` (rebuild walls) |
| residents | `window.scResidents` = `{ hit, knockDown, behead, gib, gibAround, alarm, blast, people, ignite, igniteAround, burning, skin, … }`. Since 2.0 `people` = the app's pedestrians + ours (a fresh array), and every call that takes a person accepts the **object or the id** (`hit().index` is the id, stable over time; see "People" below) |
| drive | uses `scWalk.setDriver` / `onKey` / `setHelp` / `note` / `parkedCars`; takes traffic cars (`car.scTaken = true`, held and proxy hidden); `window.scDrive` = `{ driving, car, getIn, getOut, place }` (camera always behind the car; `car.jumping` during the Tesla jump: Space, the app's barrel roll – `startBarrelRoll`, 1.2 s, 0.16 up, one roll around the length – redone on our own car mesh; Shift is the handbrake) |
| billboard | shootable via `scWalk.addTarget`, listens to `sc:blast`; `window.scBillboard` = `{ tilesLeft, postsLeft, center }` |
| cops | `window.scCops` = `{ hearts, dead, officers, cars, spawnCar, hurt, burgers }` |
| flamethrower | registers weapon `flamethrower` (`auto: true`, fires every 0.05 s while held); its fire blobs are one InstancedMesh (unlit); sets residents in a cone along the stream alight (`scResidents.ignite`) |
| rocket launcher | registers weapon `rocket` with walk mode; every explosion is `scCore.damage({ kind: 'blast', … })`; while it's the selected weapon (`scWalk.weapon`), cuts the building under the crosshair ahead (`scBuildings.prepare` / `expect(p, r, { dir, prio: 'aim' })`), and again when it fires (`prio: 'fire'`) |
| black hole | registers weapon `blackhole` (key 7); takes people via `scResidents.skin(p, 'blackhole')` / `scCops.skin(i, 'blackhole')`, traffic cars (`scBurst`, proxy hidden, moved off the map like drive's `hideGhost`), props via `scWalk.takeProp`; buildings via `scBuildings.well`; `window.scBlackhole` test hooks |
| harpoon | registers weapon `harpoon` (key 8); takes residents via `scResidents.skin(p, 'harpoon')`, pins officers with `scCops.pin(i)` (a handle: `set(x, y, z, h, lean)`, `alive`, `release()`), hooks traffic cars (taken like drive does: `scTaken`, proxy hidden, moved off the map); `window.scHarpoon` test hooks |
| balloon | registers weapon `balloon` (key 9); takes residents via `scResidents.skin(p, 'balloon')`, officers via `scCops.skin(i, 'balloon')`; `scWalk.addTarget` (shooting a balloon pops it), listens to `sc:blast`; `window.scBalloon` test hooks |
| monster | `scBuildings.list()` / `alive()` / `collapse(bd, { at, push, force, spread })`; dust from `scCore.puff` |
| meteors | `scBuildings.list()` / `near()` / `prepare()` / `crater()` / `collapse()`, `scResidents.gibAround` / `blast` / `avoid` / `alarm`, `scWalk.wreck` / `igniteCar` / `propsNear` / `knockProp`, `scCore.lampsOut` / `smoke`; sends `sc:blast` and `damage({ kind: 'meteor' })`; `window.scMeteors` test hooks |
| nuke | plans its own ruins and flight with `scBuildings.geometry` + `chunkSet` + `launch`; claims the buildings it cuts (`claim`) at the flash; `blastWave` for buildings already in chunks |
| car tyres | patches `BufferGeometry.translate` (route 1) and repairs car models in the scene (route 2) |

Events: `window.dispatchEvent(new Event('sc:geometry-changed'))` after changing buildings, so walk
mode rebuilds its collision grid (expensive – do it once per change, not per frame/hit).

More events (CustomEvent on `window`, data in `detail`) – scripts announce, others listen:

| Event | Sent by | detail |
|---|---|---|
| `sc:walk` | walk mode | `{ walking }` on start/stop |
| `sc:shot` | walk mode | `{ x, y, z, weapon }` every shot of yours (cops respond) |
| `sc:blast` | walk mode (car explosion, `blastResidents` for rockets), cops (their own cars), meteors (`source: 'meteor'`) | `{ x, y, z, gib, knock, panic }` radii |
| `sc:crush` | buildings (a building coming down), heli-crane (a crane falling), drive (running officers over) | `{ x0, z0, x1, z1, margin }` something coming down |
| `sc:kill` | residents, cops, walk mode (car occupants), nuke (car occupants), heli-crane (pilot) | `{ x, z, cause, who }` every death (bodycount) |
| `sc:car-exploded` | walk mode (also via `wreck()`), nuke, cops, black hole | `{ x, z }` (cops) |
| `sc:damage` | core (every `scCore.damage(ev)`) | the damage event: `{ kind: 'blast' \| 'impact' \| 'push' \| 'crush' \| 'meteor', x, y, z, radius, power, dir, n, source }` (buildings ignore `meteor`: the meteor script breaks buildings itself) |

Walk mode 1.20 also gives `scWalk.player` (x, y = eye, z, yaw, pitch), `leave()`, `blocked(x, z)`,
`tracer(start, end, cb)`, `addTarget({ hit(o, d, max), onHit(h, d, weapon) })` (things you can
shoot, e.g. officers; rockets check them via `hitTargets`), `blackSmoke(x, y, z, opts)`,
`moveTo(x, z)` and `lookAt(x, y, z)` (handy in tests). `spawn(kind, …, { fade: true, alpha, rise,
drag, flat, grow })` makes smoke puffs; since walk mode 1.28 every smoke/dust spawn (`smoke`,
`blacksmoke`, `dust`, anything with `fade`) goes to the core's solid puffs (see "Smoke and dust"),
other kinds (fire, debris, sparks…) are still small cube meshes. Walk mode 1.28: `scWalk.weapon`. Walk mode 1.29: double-click open ground (no road or building within
`OPEN_GROUND` = 1 tile) in the normal view to start walking there, facing the middle of the city
(the centre of the box around all roads and buildings). Residents 1.10: `crush(x0, z0, x1, z1)`,
`killInside(x, z, r)`, `deaths`; residents remember where they are inside a building (`insideAt`).

Walk mode 1.26: `scWalk.setDriver({ step(dt, keysHeld, mouseMove) → { x, z, eye, yaw, pitch, roll?, cam? } })`
hands moving and the camera to another script (null gives it back; the weapon is put away, eye
height restored), `onKey(fn(code, e) → handled)` sees keys first (not Escape), `setHelp(text|null)`,
`note(text, ms)` (the small notice), `parkedCars()`. Traffic `car.parked` is a countdown in seconds
(Infinity = held for good); a car stands still while it's set.
Traffic avoids a car by its street, not its position: it queues behind cars on the same
`from>to` street (or the next one) with a larger `s`, and overtakes parked ones when it can. `place()`
recomputes `x, z, heading` from `from, to, s, lane` (lane offset `lane × 0.075` to the right). Node
ids are `"x,y"` strings. On a road-network change, cars whose street no longer exists are dropped.
The drive script uses this: a car you parked in a lane is a parked traffic car at that spot.

## Core and the damage bus

`savings-city-core` sets up once what every script used to copy: the devtools hook (renderer,
scene, camera), borrowed three.js classes, the `/api/city` data, the traffic list, the sound output,
one `requestAnimationFrame` loop and dust puffs. Scripts look `window.scCore` up when they need it
(never at load time). Something that has to be registered at page start (a render hook, the
geometry trap) goes through `whenCore(fn)`: `window.scCoreWaiting.push(fn)` when the core isn't
there yet, run as soon as it is – so the order scripts are installed in doesn't matter as long as
all run at document-start. Core 1.5: `onDraw(fn(scene, camera, draw) → handled)` – the last step
of every render call, including the ones onRender hooks make with their `render` (so walk mode's
frames get it too); `onRenderer(fn(renderer))` – right when the renderer is created, before the
app configures it. Core 1.1 also has `onRender(fn(scene, camera, render) → handled)` (walk
mode draws with its own camera there), `overlay` (the app's selection/hover layer),
`onGeometryProto(fn)` (BufferGeometry's prototype; walk mode and car tyres patch it) and `app()`
(the app's helpers, found by code shape). All scripts use the core now, except the bodycount,
season toggle and billboard, which need none of it (the billboard uses walk mode's classes).
No script hooks `__THREE_DEVTOOLS__`, `Response.prototype.json`, `Array.prototype.forEach` or the
`isBufferGeometry` trap itself any more – add new needs to the core instead.

Breaking things goes through `scCore.damage(ev)`: a weapon or disaster says what happens (a blast
at a point, a push in a direction), whatever can break registers `onDamage(fn)` and decides for
itself (so far: buildings). A new way to destroy stuff only needs to send damage events.

## Solid buildings (savings-city-buildings: rocket launcher, monster, nuke)

`window.scBuildings`: `list()` (standing buildings `{ id, grp, mesh, boxes, x0, x1, z0, z1, top, cx, cz }`),
`at(p, slack)`, `near(x, z, r)`, `alive(bd)`, `isSolid(id)`, `isDown(id)`, `state(id)` (hits, chunks,
standing), `prepare(bd)` (cut in the background), `crater(bd, p, n, r)`, `hit(bd, p, n, opts)` (a
crater that counts; down after 7), `collapse(bd, { at, out })` (from an impact) or
`collapse(bd, { at, push, force, spread })` (pushed over), `blastWave(cx, cz, front, fn)`, `claim(id)`;
low level: `geometry` (`readMasses`, `boxPoly`, `shatter`, `pieceTriangles`, `newell`, `bounds`),
`chunkSet(pieces, material, opts)`, `launch(set, chunk, v, delay, spin)`. Chunk meshes carry
`userData.scSolid` (the nuke skips them in its own sweep).
Buildings 1.1: chunk size per building = max(0.2, ∛(7.7 × volume / 800)) – `shatter` makes about
7.7 × volume / size³ pieces (it cuts until every side is short), so ~800 at most. Cutting ran in
8 ms slices (since 1.4: a worker, see below); `hit` / `crater` / `collapse` that arrive before it's done are queued (`st.pending`,
run when the cut is back). `collapse` marks the building down at once and tells residents to avoid the rubble.

Buildings 1.3: `expect(p)` (the rocket launcher, when it fires): the building is cut and the
still chunks within 2.2 crater radii of the aim point are cut again at 0.1 (÷ ∛detail factor)
– each chunk keeps its convex shape (`poly`), box and tint for that. The fine pieces go into an
extra chunk set (`st.sets`; everything loops over all sets), the coarse chunk is collapsed and
marked `gone` in the same frame. Until 1.4 cutting and refining were generators in `st.queue`, run in 8 ms
slices, and hits waited until the queue was empty. A crater with few pieces left around the impact moves
its centre inwards (rockets at the same spot dig deeper).

Buildings 1.4: the cutting (`shatter`/`split`/`pieceTriangles` and packing the chunk arrays) runs
in a **Web Worker** made from a Blob of the script's own `cutterCore` function source (so that
function must stay self-contained); the page only receives transferred typed arrays (`pack()`:
pos, nor, n0, col, uv, orig = positions relative to the pivot, meta = 14 floats per piece) and makes
the mesh (`packedSet`, no per-vertex JS). The worker keeps each building's coarse pieces (polys) for
refining later. If no worker can be made (CSP, error, no answer in 4 s) the same `cutterCore` runs on
the page in 8 ms slices. Jobs have a priority (`aim` < `fire`; a waiting hit/collapse moves its
building's cut up) and a building's cut always runs before its refinements. A hit waits only for
the coarse cut, never for a refinement: a refinement that comes back later drops the pieces of
coarse chunks that already flew. Refining: within 1.4 crater radii, only chunks whose part nearest
the shooter is ≤ 0.9 radii deep along the shot, nearest first, at most 200 × detail factor pieces;
a spot (within 0.6 radii of an earlier one) is refined once. Hidden chunk sets are drawn with draw
range 0 (not `visible = false`), so their buffers are uploaded before the first hit. Walls carry
their texture mapping as numbers (`ua, sa, du, va, ya, dv`; `u()`/`v()` still exist on the page).
Measured in the local runner (3 rockets): fine pieces on the medium building 4652 → ~600, on the
tallest tower 7700–13000 → ~1600–2500; a rocket fired the instant it's aimed made its crater 19
(medium) / 27 (tower) frames after impact before, 1 frame after.

Nuke 3.3: outward blast about twice as hard (`BLAST_SPEED` 22, speed cap 60), scatter ±15° (was
±35°), the force falls off with distance as `(1 − d/edge)^0.4` (was ^0.6) and goes mostly sideways;
its chunks are launched with `launch(…, slide = true)` (buildings 1.4): they keep 70 % of their
speed on landing and slide with less friction, so buildings end up blown away from ground zero.

Residents 1.19 – on fire: `ignite(i, fromX, fromZ)` sets `p.burn = { phase: 'run' | 'writhe' |
'up', t, run, from }`. Run (1–5 s, panicking away from `from`, screaming often, never into a
building), writhe (state stays `walk`, `p.lie` 0…1 tips the figure like a fall, shaking; `step()`
returns early so they don't move), up (lie back to 0, run on), the fire goes out 10 s later
(`burnSafe`: 6 s before they can catch fire again). A dead body burns 8 s. Touching someone on fire
(0.035 tiles, via the crowd cells) sets you alight. Flames: one InstancedMesh of unlit blocks (3
per person, along the body when lying), plus the core's grey smoke. `blast(…, fireFrom)`: an
explosion passes the radius where it blows people apart; from there to 0.25 tiles (≈ 5 m) further,
half the people catch fire instead of being knocked down (walk mode's car explosions and
`blastResidents`, the cops' car explosions; not the monster's or nuke's knock-downs). Walk mode
1.30: plugin weapons with `auto: true` fire every `interval` while the button is held.

Residents 2.1 / cops 1.15 – burning is fatal: no `up` phase any more (and no `burnSafe`). After
`BURN_WRITHE` (5 s, the shaking and screaming fade out) the person dies where they lie: state
`down`, `fall` 1, `sc:kill` with cause `fire`. The body burns on for `BURN_CORPSE` (8 s), the
flames shrinking over the last 4 s, and blackens meanwhile: residents lerp the slot's instance
colours (all four parts) to `CHAR_COLOR` (`char()`); a burnt-out body gets `p.charred` (can't catch
fire again), and a charred slot gets fresh colours when `newOwnAt` reuses it (`dress()`; `adopt`
copies the app's colours anyway). Officers get their own clone of the shared vertex-colour
material whose `color` goes from white to `CHAR_COLOR`. Residents' figure material also sets `SNOW_COVER` `-0.50` (no
winter snow on our figures: a body lying on its back looked snowed over, a charred one grey).

Walk mode 1.31: `scWalk.igniteCar(car)` (the car stops, its driver comes out via residents'
`addRunner` and is set alight, flames and black smoke for 4–7 s, then the normal `explode()` and
burning wreck; the car counts as abandoned, so no occupant deaths) and `carBurning(car)`. The
flamethrower heats every car (traffic + parked) in its cone and ignites it after 0.5 s of flame.

Core 1.4: setting `blood` (1…5) → `scCore.blood()` = 1, 2, 4, 8, 16. Residents 1.20 multiply their
drops by it (knock-down, gib, neck squirt) and keep up to 4× as many drops/stains (ring buffer of
`MAX_BLOOD_DROPS × min(4, blood)`, mesh capacity 4×); a stain's matrix is written once when it
lands (the loop used to rewrite every drop every frame). `scResidents.spatter(x, y, z, dx, dz, n,
speed, up)` (n × blood) and `screamAt(x, z, voice, short)` are for the cops: their blood goes into
the residents' instanced drops (walk mode's cube particles only as a fallback).
Cops 1.6: officers burn like residents (`ignite`, `scCops.ignite(i, fx, fz)`, `officers()[i].burning`;
flames are walk mode's fire cubes – at most 4 officers), from the flamethrower, the explosion fire
band (`sc:blast` gib … gib + 0.25) and touching burning residents (checked 5×/s) or officers; a
burning officer sets residents alight (`igniteAround`). Aim: `ACCURACY` 0.32 (was 0.45), min 0.07,
× a per-officer `steady` (0.6–1.15), × 0.6…1 over the first 3 shots; misses 0.05–0.3 tiles wide.

Walk mode 1.32: the scan of trees, lamps, benches and fountains skipped indexed meshes, so the
highways' tall lamps never broke when shot. Indexed meshes that hold a prop colour are now flattened once.

Walk mode 1.33: a sky dome while walking (`SKY_DOME`): one mesh of vertex colours (rings plus
~420 star quads, radius 300, drawn first, centred on the camera every frame) recoloured 20× a
second from the sun's altitude – the app's `DirectionalLight` (position − target). Day: blue to
pale at the horizon; dusk/dawn (sun around −3°): an orange glow at the horizon under violet-blue;
night: near black with twinkling stars. Scene background and the walk fog follow the horizon
colour. Palette hex values are converted to linear (the renderer converts back). Note: the core's
borrowed `Attr` class copies the array you give it – write into `attr.array`. Test hook:
`scWalk.skyAltitude(deg)` forces the sun's altitude (null: the real sun again).

Walk mode 1.34: the app's light doesn't say how low the sun is – `fv()` builds `sunDirection`
from `max(0, altitude)`, so it sits at the horizon all night – and walk mode used to move the light
to a fixed spot above you anyway. Now the sky takes the altitude from the app's clock
(`view.clock()`, the same low-precision solar formula as the app's `L_`, at a generic place in the
middle of the Netherlands), and the light is placed along `view.sunDirection` around you, so
shadows follow the time of day. Road lamps (`view.lampPosts`, instanced pole + head, instance i =
`view.lamps[i]`) are props now too (`prop.inst`, like the instanced trees); before only the
merged lamps (squares, highways) could be shot down. A lamp that lands calls `scCore.lampsOut` for
itself (glow, light pool and lit head go out).

Residents 1.21: nobody walks on highways (their asphalt covers where the sidewalk line is), on a road
that touches a highway junction, or through a door onto either. `buildNetwork()` builds the walking
network from the roads that are not highway or next to one; the asphalt cells still include highways.
`highwayKeys()` reads the drawn road boxes (0.48 wide = highway); `frame` rebuilds the network when that set changes (checked once a second).

Car tyres 1.5: route 2 (repairing car models built without the fix, a walk through the scene)
stops for good once route 1 has fixed a tyre, and otherwise runs every 10 s instead of 2 s.

Nuke 3.4: the cloud's 'top' puffs (the middle of the cap) used to depend only on the cloud's growth,
so they froze once it stopped growing (~10 s); now each drifts from the centre out to the ring and
starts again, swirls, bobs and swells on its own beat.

## Smoke and dust (core 1.3)

`scCore.smoke(kind, x, y, z, opts)` – kinds `dust`, `blacksmoke`, `smoke` (and `exhaust`, used
internally). One `InstancedMesh` of a flat-shaded icosahedron (radius 0.5, Lambert, white ×
instance colour) per kind, fixed capacity (1600/1600/500/600), a ring buffer: when full, the oldest
puff's slot is reused. Per puff 18 floats in one `Float32Array` (position, velocity, age, life, size,
grow, rise, drag, flat, thin, wind, colour) plus a random rotation (9 floats, made once per slot);
per frame a handful of multiplications per puff (velocity settles with `1 / (1 + drag·dt)` towards
`rise` + wind, size grows `1 − (1 − f)²`, pops in over the first 6 %, shrinks away over the second
half of its life and over the last 0.7 tiles below `SMOKE_TOP` = 1.5 tiles ≈ 30 m, where it is
removed), the matrix and colour (towards the kind's "thin" colour as it ages) written straight into
the instance arrays, uploaded up to the highest live slot. Dead slots get a zero matrix; `count`
is the highest live slot + 1, 0 when none (no draw call). Solid (no transparency): no sorting, no
overdraw; `alpha` makes a puff smaller and lighter instead. Opts as walk mode's fade puffs: `vx, vy,
vz, size, grow, life, delay, rise, drag, flat, alpha, wind, color`. `scCore.puff` is a `dust` puff.
The meshes have `userData.scSmoke` (kind) and `scPuff` (the nuke skips them).
The app's own exhaust (a `Points` with `aSize`/`aAlpha` and no `aColor`, white soft points sized for
the top-down camera, only emitted in a barrel roll) is hidden and mirrored every frame as solid
puffs of the same place and size (`APP_EXHAUST`). The app's explosion points (`aColor`: fire, smoke,
debris of a crash) are left alone: they're one draw call already, and fire wants glow.
With 6 burning wrecks the draw calls went from ~400 to ~170 per frame (the rest: the city, fire cubes).

Sound gotcha: never name a local variable `out` in a script that uses the shared `out(ctx)` –
residents' scream did (`const out = a.createGain()`), `out(a)` threw inside a try and fleeing
people were silent from the sound-button change until residents 1.18.

Performance of chunks: every flying chunk's vertices are recomputed on the CPU and uploaded each
frame, so the vertex count is the cost. The nuke keeps its whole city under ~60k vertices
(measured ~140 vertices per volume ÷ size³, ruin columns 0.8 × chunk size wide) and 1500 rubble
cubes; a 15 kt blast over the whole local city: 1437 pieces / 53k vertices (was 7620 / 274k).

Settings so far: `detail` (core; buildings: chunk budget × factor and minimum chunk size ÷ ∛factor;
nuke: vertex budget and rubble × factor, fixed when the bomb is prepared), `hitsToCollapse`
(buildings), `residents` (per road, respawns everyone), `carTopSpeed` (drive). Define settings at
load time through `whenCore`, read them when needed (so a change applies to what happens next).

Residents 1.16: `avoid(x, z, r, seconds)` – places to stay away from (the nuke's damage radius for
good, rubble for 2 minutes). Nobody plans a way into one, whoever is in one walks out, doors in one
aren't used. People in a panic still look before crossing, at their running pace (20 % don't:
`RECKLESS`). The nuke only hurts people and cars while its wave passes (`waving(t)`); before 3.1 it
kept knocking down everyone within its radius every frame, so the death toll kept rising.


- Read the boxes from the facade mesh (top quads give the rect + height, wall quads give the base
  and the UV mapping per wall).
- Cut each box into convex chunks by random, slightly tilted planes (`split` = Sutherland–Hodgman on
  every face + a cap polygon; `shatter` cuts the longest direction until ≤ size). Faces on the
  box's outside get the facade UVs and colours (windows line up), inside faces are "concrete"
  (wall colour, dusty). Precompute in time slices (generators / `setTimeout`) – it's heavy.
- Swap: hide the original triangles (collapse them to a point) in the city block meshes – test the
  triangle's centre against the footprint + 0.08 (roof rims stick out) – and draw all chunks in one
  mesh with the facade material; animate chunks on the CPU (per-chunk rotation + offset), land on
  their largest face.
- GPU uploads: use `attribute.addUpdateRange(...)` + `needsUpdate`, **never `clearUpdateRanges()`
  before adding** (if a frame isn't rendered in between, earlier changes are lost).

## Testing without the real app

**Preferred (since 25 Nov 2026): the local app.** `node local/server.js --port 8123 &` serves the
saved copy in `app/` with `/api/*` answered from `local/city.json` (an anonymised `/api/city` dump, 93
projects; an optional `water` list in the city file; write calls kept in memory; `/api/city/changes` always
204) and injects the chosen scripts as classic `<script>` tags in
`<head>` before the app's module (= document-start). `node local/shot.js 'http://localhost:8123/?plugins=nuke' out.png [--eval js] [--wait ms]`
renders it in headless Chromium (SwiftShader; `NODE_PATH=$(npm root -g)` for Playwright) with the
welcome dialog suppressed – look at the PNG. For walk mode: click `#sc-walk-toggle`, one
`mouse.down/up` takes the pointer lock (works headless), the next ones shoot; aim with
`scWalk.moveTo` / `lookAt` (don't `mouse.click(x, y)`: moving the mouse turns the view). Cars drive
on – hold one with `car.parked = Infinity; car.speed = 0` before each shot. A tall building cut
into chunks is slow in SwiftShader (minutes). Missing from the copy: loading-screen PNGs (served as
blank) and the Baloo font (fetched from Google if the network allows).

Older approach, still useful for unit-level checks:

- Node + the `three` npm package (r170 is close enough) to run script parts with a fake scene
  (extract functions from the script text with `new Function`).
- Headless Chromium (Playwright, SwiftShader) for renders: a test page with an import map to
  `node_modules/three`, a fake city built like the app (facade boxes with window texture, merged
  block mesh, hidden project groups, app-like car model), the script loaded as a classic script
  before three.js creates the renderer, and a fake clock (`performance.now` / `requestAnimationFrame`
  stubbed) to step frames.
- The user tests in the real browser and reports with screenshots.

## Gotchas found along the way

- The app's CSS has short global class names (`.flash` is a full-screen red vignette, `.hearts`):
  our own UI classes can pick up its styles – prefix them (`sc-…`) or scope them under an id.
- Residents' sidewalk paths: the road graph shifted 0.205 to one side; at a corner the two lines
  meet at the sidewalk corner (edge ends at `s1 = 1 + 0.205·(oNext·dir)`, next starts at
  `s0 = 0.205·(o·dirNext)`), so they only touch asphalt on a real, complete crossing.

- Transparent canvas: additive effects turn black against the sky in walk mode → walk mode sets an
  opaque `scene.background`.
- Things placed on the sidewalk must sit at y = 0.036 (asphalt 0.04), not 0.
- Triangle counts that aren't a multiple of 3 broke typed-array lengths – always `Math.floor`.
- Several scripts hooking the same thing (prototype trap, `forEach`) must chain, not replace.
- Don't search all city triangles per hit/frame – use bounding boxes and caches.

## People (residents 2.0): the app's pedestrians and the handover

The app has its own pedestrians (`view.pedestrians`, class `rb`, since the 27 Nov build): one list
(`list`, a person per entry: `x, z, h, state` = `walk` / `enter` / `exit` / `inside`, `speed, dir, a, b, s,
side, path, parent, child, k` for a child) and four instanced meshes (`legs, torsos, heads, hairs`,
colours per index, `bald` per index). It walks the roads (its own network: `eb()`), crosses at
junctions, goes through doors (`enter`/`exit`) and has children. `share` (0…1, the app's `crowd`
setting) × the road and path length gives the crowd, capped at 4000 (`iy`); `populate()` makes it;
`density` is its setter. Its draw (`draw(i, person)`) writes the matrices.

Residents 2.0 uses that population and adds what happens to it (`savings-city-residents`):

- **Handover.** Anything that acts on someone (a shot, an explosion, a fire, a car, a panic, a
  building coming down, a place to stay away from) calls `ownOf(p)`: the person leaves the app's list
  (`removeNative`: the last one takes the index, its colours and bald flag with it, its matrix is
  rewritten) and gets a slot of ours (`own`, residents' own four meshes, colours copied from the app's
  index). Our figures fall, burn, bleed, lose their heads, are gibbed and skinned exactly as before.
  `adopt` also detaches a child from its parent (and a parent from its child, which then walks on alone).
- **Runners.** A panicking, burning or zone-escaping person keeps walking on *our* copy of the road
  network (`ensurePlaced` puts them on it where they stand; the old walker engine: `step`, `place`,
  `panic`, doors, `walkAway`). When the panic is over (no `panic`, `away`, `burn`, `frozen`, `keep`) and
  they're not inside, they're removed (`temp`, state `gone`), and the app's `populate()` tops its list
  up (`topUpAt` every 0.5 s; `crowdTarget` is the list length after the app's last `populate()`, which
  the residents wrap). No top-up while a zone that lasts for good exists (the nuke's ground zero):
  the dead stay dead and nobody new walks the ruins.
- **Ids.** Every person has `scId`. `hit()` returns `index: id`; `knockDown`, `skin`, `gib`, `behead`,
  `ignite`, `unfreeze` take the id (or the person object). `find()` also finds a person who was handed over
  since (their id stays with them). Other scripts that held an index into `res.people` pass the object now
  (flamethrower, drive, yuletide).
- **Density.** The 'residents' setting (default 2 = the app's own crowd, shown as 1×; range 0.25…4×) is a
  multiplier: `share = app's base × multiplier`, applied through `applyDensity`. The app's `density`
  setter is replaced by one that keeps the base (`scBase`), so the app's own `crowd` setting still works.
- **Cars** run over the app's people too, but only fast cars (`hitByCar`: a calm person never walks in
  front of a car, and the app's people are calm, so only a car speeding up or with a siren hits them).
- **Own slots:** `MAX_OWN` = `MAX_PEOPLE` (4000, the app's crowd cap); when full, the oldest lying figure
  is dropped (`freeSlot`) – but only for someone who dies: taking in a runner (`alarm`, a blast's panic
  ring, a zone, a collapse's panic ring) passes `evict = false` (`ownOf(p, false)`) and leaves them
  to the app when there's no free slot, so runners never make bodies disappear.

Test hooks: `scResidents.freeze(x, z)` (returns the id) and the skinner harness (`local/harness.js`).

## Skinner (savings-city-skinner 1.7, residents 2.0, cops 1.12)

- A walk-mode weapon (key 5, `scWalkWeapons.push`). Its beam takes the nearest resident
  (`scResidents.hit`) or officer (a cylinder test over `scCops.officers()`) before a wall or car.
  On arrival it calls `scResidents.skin(id)` or `scCops.skin(i)`: the person or officer leaves the
  city (state `gone`, `sc:kill` cause `skinned`) and their place `{ x, z, y, h, k, th, colors }` is
  returned; `th` is their heading (the figure's front is local +z turned by `th`), so the insides
  face the way the person was walking. `hit().index` is an id (residents 2.0), so it stays valid
  while the beam travels.
- The script draws the body itself: one InstancedMesh per kind (blobs, rods, skin, rings), with
  slot pools. The insides are built at once, inside the skin: about 90 overlapping red blobs on a
  jittered grid fill the figure's torso and legs (`flesh()`, new jitter per body), plus organs, a
  skull, ribs, spine and leg bones (`INSIDE`), all within the resident figure's boxes (no arms:
  the figure has none).
- Phases: peel (0.9 s, a rising ring). The skin is 13 thin panels (`SKIN_PANELS`, 8 cm thick, `SKIN_T`):
  the four sides of each of the figure's legs, torso and head boxes plus the top of the head. They
  are pulled straight up off the body, head first (`PULL` body heights), so the outside of the figure
  vanishes. Since 1.7 there are no plain skin boxes any more. Each panel has the person's own colour
  (`skinColor`: legs = trousers, torso = shirt, head = skin, top = hair or skin when bald, from
  `skin().colors`; officers get the uniform, `COP_COLORS`). Exposed (1 s, heart pulses). Fall
  (gravity, bounce, push, spin). Pile (20 s, then fade).
- From the end of the peel the panels (and 4 flakes) break apart and float down (`FLOAT_TIME` 1.8 s,
  swaying) to land flat on the floor 2–4 m from the body (`FLOAT_DIST`). A panel lies thin side up:
  `rot1` turns it about x (thin z → up) and spins it in its own plane; a thin-y panel (the top of the
  head) just spins. The heap stays until it fades. At most 6 bodies are moving and 30 in all; the skin
  pool holds `CAP_SKIN` = 640 panels (13 + 4 flakes × 30 bodies).
- The fall calls `scResidents.spatter` for blood and `scResidents.avoid` around the heap.
- `local/harness.js` + `local/harness-layout.json`: fixed shots (stand at a point, aim at a point,
  fire, report events, screenshots at set times). A shot can name a placed subject (`target`).
- Test hooks (for `local/harness.js` and by hand in the console): `scResidents.freeze(x, z)` pins
  the walking adult nearest to (x, z) there (returns their id; `unfreeze(id)` lets them walk again);
  `scCops.placeAt(x, z)` creates a still officer that can be shot (cops 1.9).
- Headless Chromium runs the simulation slowly: the frame time step is clamped to 0.05 s, so
  "1.8 s" on screen is less game time. Give the skinner's fall about 4 s before judging it.

## Yuletide grenade (savings-city-yuletide 1.1, residents 1.25, cops 1.13)

- A walk-mode weapon (key 6, `scWalkWeapons.push`); the model in your hand pushes its cones
  straight into the builder's `P`/`C` arrays (the builder only has boxes and prisms along z).
- The throw is a plain `K.Mesh` (vertex colours, Lambert) with gravity, bouncing off the ground
  bouncing off walls (`rayBuildings` normal); it goes off the moment it reaches the ground (y 0.038),
  or after `MAX_FLIGHT` s in the air. `sc:blast` carries `source: 'yuletide'` and `landed`.
- The blast radius is shown by a ring of green sprinkles (box-pool slots): they fly out with an
  ease-out to exactly `RADIUS` (a fifth land inside), lie there 1.6 s, then shrink away.
- The blast takes everyone outside within `RADIUS` (0.5 tiles ≈ 10 m): residents from
  `scResidents.people`, officers from `scCops.officers()`, both through `skin(i, 'tree')` (the
  `cause` argument is new in residents 1.25 / cops 1.13; residents' `skin()` now also returns
  `colors` – shirt, trousers, skin, hair as hex, read from the instanced figures – and cops' `cop: true`).
- Each victim is a "tree": three InstancedMesh pools (cones, blobs, boxes; Lambert, normals from
  `computeVertexNormals` on both-winding triangles). Parts are groups of instances that sit in the
  body, fly an arc from `t0` to `t1`, and then stay at a target that follows the growing tree
  (`onTree`) or lies on the ground; an item's `end` size lets clothes go flat as they land.
  Timeline: wait (ripple by distance), swell 0.4 s, burst (spatter in 8 directions + a pool,
  clothes slump into a heap at the foot, organs → baubles at the tier rims, bowels → spiral
  garland, head → the tip), grow 0.65 s with overshoot, stand 30 s (head drips 5 s), shrink.
- Winter: the app patches three.js' Lambert shader (`pf()` in CityCanvas) to lay snow on every
  upward-facing surface, per material by the `SNOW_COVER` define (0.9 when unset). Lambert
  materials of our own that must keep their colour set `defines.SNOW_COVER = '-0.50'` (the
  yuletide pools and grenade; residents' blood drops since 1.25 – before that, stains on snow
  came out white).
- Test hooks: `scYuletide.detonate(x, z)` sets one off at once (with `scResidents.freeze` to put
  people there first); `scYuletide.throw(start, dir)` throws one as the weapon does (synthetic
  clicks in headless runs don't fire reliably).

## Black hole grenade (savings-city-blackhole 1.0, buildings 1.6, walk mode 1.35, residents 2.2)

- A walk-mode weapon (key 7). The marble bounces and rolls (`rayBuildings` for walls) and opens
  `FUSE` s after the throw: it rises to `HOVER`, then the hole grows (black `Basic` sphere, two
  additive back-face spheres as rim and halo, an instanced unlit disk of streaks in a tilted plane).
- Nobody notices it (no `alarm`): people walk on until the pull's reach (growing to `REACH`) has them.
- Pull (`pullStep`, the same in buildings' `pull`): acceleration `PULL / d²` (capped) towards the
  hole, plus a sideways speed steered towards `SWIRL × 0.7 × √(a·d)` – **below the orbit speed**.
  A constant sideways *acceleration* (the first try) slung everything back out near the middle
  (v²/d outgrew the pull), so nothing was ever swallowed. Swallowed when within the eat radius,
  also when a fast step passes through it (closest point on the step's segment).
- Spaghettification: near the middle the instance/object matrix is `S · R` with `S` stretched along
  the pull (`1 + 6·near`) and thinner across, times a shrink. People are drawn by this script
  (instanced boxes: legs, torso, head, hair in their own colours); cars from their batch's geometry;
  props are walk mode's `takeProp` objects (`matrixAutoUpdate = false`, matrix written directly).
- Buildings 1.6 – `scBuildings.well({ x, y, z, radius, strength, eat, peel, swirl })` → `{ set(p),
  spit(speed), close(), eaten }`: flying chunks within `radius × 1.2` are pulled (less gravity:
  `fr.lift`), stretched (`fr.stretch`) and shrunk (`fr.scale`, both in `writeChunk`); swallowed chunks
  get state `eaten` (collapsed to the well's point) until `spit` relaunches them (smaller, tumbling,
  sliding). Peeling: still and resting chunks in reach fly with a chance `peel·dt·(1 − d/r)²` (near
  side first; resting rubble keeps its place and turn); at `PEEL_COLLAPSE` (30 %) the rest is
  collapsed towards the well.
- Walk mode 1.35 – `scWalk.takeProp(p)`: instanced props get a Mesh per instance (own colour from
  `instanceColor`) under an Object3D at the foot, the instance zeroed; merged ones are `detach`ed.
  `fallen` remembers `{ gone: true }` so a rebuild hides them again. Lamps go out (`lampOut`).
- Residents 2.2 – a fix found here: the app's children have no street of their own (they follow
  their parent, `a`/`b` empty). Taking a parent over (`adopt`) left the child with `a = b = ''`
  and the app's walker threw in `plan()` every frame (`n.xy.get(e.b)` undefined), stopping the
  app's tick. Now the child gets the parent's street (`placeOnEdge`), or is taken over too.
- The end: `spit` – the well spits its chunks, the core's damage bus gets a `blast` (source
  `blackhole`), walk mode's `blastResidents`; people come back as gore (blobs, a shoe, rags, now and
  then a head) that splats and lies `GORE_TIME` s; cars as darkened, burning shells (`sc:car-exploded`;
  occupants die when the car is swallowed); props are thrown and lie where they land.
- Test hooks: `scBlackhole.open(x, z)`, `throw(start, dir)`, `collapse()`, `holes`, `bodyInfo()`.
  Headless: skip drawing between screenshots (`scCore.onDraw(() => skip)`) or the simulation
  crawls (SwiftShader; dt is clamped to 0.05 per frame).

## Kebab harpoon (savings-city-harpoon 1.0, cops 1.16, walk mode 1.37)

- A walk-mode weapon (key 8). The bolt is stepped every frame (speed `BOLT_SPEED`, a little drop):
  per step the first solid thing on the segment – `rayBuildings`, `hitCar`, `hitProp`, the ground –
  and before it every person whose body the segment crosses (`skewer`: residents from
  `scResidents.people` with a bounding-box pre-check, officers from `scCops.officers()`; a cylinder
  of `HIT_R` from the feet up to the head). Residents are taken with `skin(p, 'harpoon')` and drawn
  by this script (instanced boxes, as in the black hole); officers stay the cops script's own.
- On the shaft, victim i sits `TIP_GAP + i × GAP` behind the tip (sliding there), upright, with the
  shaft through the torso; too low to stand (a bolt in the ground) they tip over towards the ground
  (`lean`). Twitching is a rotation about the shaft that dies down, then a slump.
- Cops 1.16 – `scCops.pin(i)`: the officer gets `cop.pinned` and `step` hands them to `stepPinned`
  before anything else: the harpoon script sets their feet, they turn towards you and shoot with
  `PINNED_AIM` (0.4 × their aim), and die after `PIN_BLEED` (6–11 s, cause `harpoon`); dead, they
  hang limp. The officers' hit test uses the pinned height.
- Cars: a traffic car that's hit becomes ours (batch geometry mesh, the traffic car moved off the
  map, its driver out via `addRunner`); the bolt is stored in the car's coordinates. While the
  mouse button is held (own `mousedown`/`mouseup` listeners, capture phase), the car accelerates
  towards the gun point, turning so the hook trails; let go, it rolls on with friction; it stops
  against you. A click while a car is hooked doesn't fire (walk mode still sends `sc:shot`). X
  (`scWalk.onKey`), switching weapons, leaving walk mode, `CABLE_MAX` or a car pulled in all the
  way cut the cable. Walk mode 1.37 only changes the help text (keys 0–8).
- Test hooks: `scHarpoon.fire(o, d)`, `reel(on)`, `cut()`, `hooked`, `kebabs` (with `stop`: what
  it stuck in). Headless, select the weapon first (`keyboard.press('Digit8')`), or the hook is cut
  at once; `scResidents.freeze` keeps picking the same nearest person, so freeze far apart and set
  `fx`/`fz` afterwards.

## Balloonator (savings-city-balloon 1.0, walk mode 1.38)

- A walk-mode weapon (key 9). The ampoule is a plain `K.Mesh` (vertex colours) stepped every frame
  like the harpoon's bolt (`DART_SPEED`, a little drop): per step `rayBuildings`, `hitCar`,
  `hitProp`, the ground, a floating balloon (ray–sphere) and the nearest person whose body the
  segment crosses (residents from `scResidents.people` with a bounding-box pre-check, officers from
  `scCops.officers()`, skipping pinned ones). The first of these wins; a solid thing shatters it.
- A hit person is taken with `skin(…, 'balloon')` (killed at once for the bodycount) and drawn by
  this script from four instanced pools: boxes (legs, the shrinking torso, head, hair, eyes, mouth),
  smooth spheres (the bare belly inside the body, the cheeks around the box head), closed half
  spheres (shirt on top, trousers underneath; pulled apart a little so a band of belly shows) and
  icosahedron blobs (gore, blood splats, the pool). Lambert with `SNOW_COVER` `-0.50`.
- `shape(b)` is a pure function of the balloon's time: inflation (smoothstep over `INFLATE`, a
  decaying jiggle), radius `R_START`…`R_FULL` × the person's scale, over-inflation in the last `OVER`
  s (+24 %, trembling, `tint()` lerps belly/cheeks/head to `FLUSH`), and the feet's height
  `ALTITUDE × lift^1.6` from `LIFT_AT` to `POP_AT` (0.4 tiles ≈ 8 m at 10 s). The sphere's centre is
  feet + leg length + 0.8 R; legs hang from it and kick; the whole figure swings (`rotX`/`rotZ`)
  and turns slowly once airborne, and drifts with a per-balloon wind.
- The pop: the insides are the skinner's `INSIDE` list plus 40 flesh lumps, spread out through
  the sphere and sent outward (`POP_SPEED`); rags (thin boxes in shirt, trousers, skin, hair colours)
  have air drag and land flat; the legs drop. Blood: `spatter` in 12 directions (`SPRAY` each),
  a blood rain under the spot for `RAIN_TIME`, drips from falling meat, a flat splat blob and a
  little spray where each piece lands, a pool growing to `POOL`. A red mist from the core's `dust`
  puffs with a colour. `avoid` and `alarm` around the spot. Heaps stay `GORE_TIME` s.
- Early pops: `scWalk.addTarget` (registered at the first shot) makes balloons shootable by every
  walk-mode weapon; `sc:blast` pops those within its knock/gib radius.
- Sounds: gas puff, glass tinkle, a rising hiss while swelling, a squeaky wail in bursts that
  climbs in pitch (one oscillator per balloon, stopped at the pop), rubber creaks, the bang.
  Positional by distance to the player (`near`).
- Test hooks: `scBalloon.infect(x, z)` (freezes and inflates the nearest person), `fire(o, d)`,
  `pop()`, `balloons` (t, position, feet height, R), `heaps`. A real headless click with the weapon
  selected (`keyboard.press('Digit9')`) fires too.

## Meteor shower (savings-city-meteors 1.0, residents 2.4)

- A ☄ menu button (`#sc-meteors`); clicking during a shower drops the meteors that haven't been
  launched yet. Needs core and buildings; residents, walk mode and cops add people, cars and props.
- `plan()`: 10–40 meteors, one direction for the whole shower (a random bearing, 35–60° above the
  horizon), each on its own parallel line. 25–40 % are aimed: picked at random, weighted by volume,
  from the 3 × (aimed count) biggest buildings; the aim point is random inside one of the building's
  boxes (the tallest box 70 % of the time) at 30–90 % of its height, and the line is carried on to
  the ground, so the meteor ploughs into the side or roof. Aimed meteors are on the big side. The
  rest land uniformly over the city's box + 1.5 tiles, at least 0.7 apart. The order is shuffled and
  the arrivals (exponential gaps) spread over 7–14 s, the first 3 s after the click. The first
  building on every line is `prepare()`d at once (in arrival order), so the cut is ready in time.
- Flight: `SPEED` 9 tiles/s, appears `START_DIST` 34 tiles up its line. Each frame the segment is
  tested against the boxes of `scBuildings.list()` (slab test, list cached 300 ms). A building on
  the line gets damage `SEVERE` and `collapse(bd, { at, push: meteor direction, force, spread })`;
  the meteor keeps `PUNCH_KEEP` of its energy (energy = size / max size) and explodes there when it
  drops below `MIN_ENERGY` – so the biggest go through one or two buildings.
- Impact: blast radius 0.35…1.15 tiles by energy. Buildings within it get `BLAST_DAMAGE × e ×
  (1 − d/R)^1.3` (footprint distance), summed per building over the shower (`damageOf`); at
  `SEVERE` (1) they collapse pushed away from the impact, otherwise ≥ `CRATER_AT` blows a `crater`
  into the side facing it. People: `gibAround` 0.4 R, `blast` knock 0.95 R / panic 3.5 R with the
  fire band, `avoid` the crater; `sc:blast` for cops/billboard/balloons. Cars (traffic + walk mode's
  parked ones): within 0.5 R `scWalk.wreck` (burnt shell, occupants dead), up to R `igniteCar` (they
  explode a few seconds later; chain reactions); without walk mode they're squashed. Lamps:
  `lampsOut(R × 1.15, fell < 0.6 R)`; props: `propsNear` + `knockProp` (only props walk mode knows).
- Visuals: own InstancedMesh pools (ring buffers, 14 floats per particle, random rotation per slot):
  `fire` (unlit, a colour ramp white → yellow → orange → red → smoky dark), `smoke` (Lambert grey
  trail – the core's puffs are removed above 1.5 tiles, too low for a trail) and `debris` (rocks and
  dirt, ballistic, they stay where they land). The meteor itself: a lumpy rock (subdivided
  icosahedron, vertex colours, emissive) in two stretched unlit shells (orange outside, pale yellow
  inside) pointing back along the path. Craters: one InstancedMesh (bowl, jagged rim, scorched ring;
  80 at most); the rock stays in its crater and cools down over `ROCK_GLOW` s, smouldering.
  All Lambert materials set `SNOW_COVER` `-0.50`.
- Residents 2.4 – a fix found here: when a parent was taken over while walking out of a door
  (`state` `exit`), the app's child (whose state copies the parent's) was left in `exit` without a
  `next` street, and the app's walker threw in `move()` (`t.next[0]`) at the end of the door every
  frame. Now the child takes over the parent's way out (`from`, `to`, `t`, `dur`, `next`), or the
  parent's `enter` / `inside` with a timer of its own.
- Test hooks: `scMeteors.start({ count, aimed, azimuth, elevation, duration })` (returns the plan),
  `stop()`, `plan(opts)`, `meteors`, `shower`, `damage(id)`. Headless: skip drawing between
  screenshots (`scCore.onDraw(() => skip)`), and zoom out (the zoom-out button) to see the city.
