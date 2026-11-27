# Savings City – After Dark

Tampermonkey userscripts that add mayhem to the Savings City web app: walk through the city in first
person, residents who panic and scream, cars that explode, a rocket launcher, a flamethrower, police who shoot
back, a black hole grenade, a kebab harpoon, a Balloonator, a nuke, a giant monster, a meteor shower, cars you can steal and drive, a billboard to shoot to pieces – and a
bodycount. They hook into the app's three.js scene from the outside (no changes to the app itself);
everything happens only in your own browser – reload the page and the city is back as it was.

Want to try them without the real app, or work on them? The repository also holds a copy of the
app and a local server: see [Running the app locally](#running-the-app-locally) and
[Development](#development).

## Installing

### All scripts at once (recommended)

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Install the loader: open
   [`savings-city-after-dark.user.js`](https://raw.githubusercontent.com/Pixelfest/savings-city-after-dark/main/savings-city-after-dark.user.js)
   and Tampermonkey offers to install it.
3. **Set the app's address once:** in the loader, replace
   `// @match        https://your-savings-city-host.example/*` with the address of your Savings City
   app (keep the `/*` at the end), or add the address under the loader's *Settings →
   Includes/Excludes → User matches* in Tampermonkey.
4. **Updates:** every new release gets a new loader version, and the loader then fetches all
   scripts fresh. Tampermonkey checks for script updates on its own (Settings → *Script Update* →
   *Check Interval*); to get a release right away, use **Check for userscript updates** in the
   Tampermonkey menu, or open the loader link above again and install it over the old one.
   The browser console shows which loader version is running: `[Savings City After Dark] loader x.y`.
   Remove the scripts you installed one by one, or they run twice.

The loader contains every script below. To leave one out, delete its `@require` line in the loader.
Keep the core and buildings: almost every script needs the core (only the bodycount and billboard don't), and the rocket launcher, the monster, the nuke and the meteor shower also need buildings.

Set the address under *User matches* rather than editing the loader: once you edit the loader,
Tampermonkey stops updating it, and then the scripts it loads don't update either.

### Scripts one by one

Add each `.user.js` file separately (Dashboard → `+` → paste, or drag the file in) and set the
`@match` address in every one. They don't update by themselves. Always install the core (every script
except the bodycount and billboard needs it), and the buildings script too for the
rocket launcher, the monster, the nuke or the meteor shower. The order in Tampermonkey's list doesn't matter.

Settings are constants at the top of each script; the most useful ones are also sliders in the
settings popup (the menu button with the sliders icon): detail when things break (5 steps, each
doubles the pieces – prettier, heavier), blood (1–16× as much spatter), rockets before a building collapses, how many people walk the streets (the crowd slider),
the car's top speed, and the graphics settings: winter, day and night, shadows, ambient occlusion and pixel size. All sounds follow the app's own sound button (mute and volume).

| Script | Version | What it does |
|---|---|---|
| `savings-city-core.user.js` | 1.7 | Shared base, install it first. Adds a settings button (sliders icon) to the menu: a popup with sliders, on/off switches and choice buttons the scripts add (settings that only apply after a reload turn the Klaar button into "Klaar · herladen") – detail when things break (5 steps, each doubles the pieces: prettier, heavier), blood (1, 2, 4, 8 or 16× as much spatter), rockets before a building collapses, how many people walk the streets (the crowd slider), the car's top speed – remembered in the browser. Also: the app's scene, renderer and camera, three.js classes, city data, traffic, sound (follows the app's sound button), one frame loop, smoke and dust (solid low-poly puffs, one draw call per kind: car fires, rockets, collapsing buildings, the monster; also the app's own exhaust puffs) that shrink away by 30 m up, and the damage bus (`scCore.damage(...)`) that weapons and disasters use to break things. Lights out: at night a destroyed building's lights go out (the glow around it, its Christmas lights, the windows of its rubble), and explosions break the street lamps in their reach. Nothing else visible on its own. |
| `savings-city-buildings.user.js` | 1.6 | Solid buildings, shared by the rocket launcher, the monster and the nuke (needs the core): buildings turn into chunks with the facade outside and concrete inside (at most ~800 per building: big buildings get bigger chunks), get craters, collapse from an impact or are pushed over, with dust rolling out; cutting runs in a background worker (the page doesn't stutter), a hit that arrives earlier waits for it. Where a rocket is about to hit, the chunks on the side facing you are cut again much smaller (a crater of many small pieces, a fixed maximum that follows the detail setting), and rockets at the same spot dig deeper. People keep away from the rubble. A building that comes down goes dark at night: no glow around it, no Christmas lights, no lit windows in the rubble. Gravity wells for the black hole grenade: chunks peeled off the side facing it, pulled in on a spiral, stretched, swallowed and spat back out. |
| `savings-city-graphics.user.js` | 1.4 | Needs core. Graphics settings in the settings popup: **winter** (by date / on / off; snow and Christmas), **day and night** (real time / always day / always night; the page reloads for these two), **shadows** on/off, **ambient occlusion** on/off (added by this script – the app has none; darker corners where walls, roofs and the ground meet; daytime only, costs GPU; works with the app's bloom pass since 1.3; no smearing of moving things since 1.4), **pixel size** (normal, 2×, 3×, 4×: bigger, blocky pixels like an old game, and lighter for the GPU). Replaces the season toggle (the app no longer reads `?winter=`). |
| `savings-city-auto-layout.user.js` | 2.5 | Needs core. Organic city layout right next to the welcome sign: tall buildings in the centre, smaller ones outside, roads between them, all water removed; optionally (`RING_ROAD`, off by default) a ring road connecting loose ends. |
| `savings-city-car-tyres.user.js` | 1.5 | Needs core. Wider, optionally round tyres (no more flickering). Lighter: the fallback that repairs car models built without the fix stops once the fix is known to work. |
| `savings-city-walk-mode.user.js` | 1.38 | Needs core. First-person walk mode (WASD + mouse, `,`/`.` slower/faster, Esc to stop), start from a building's door (double-click it), or double-click open ground outside the city to start there, facing the city centre. You start with empty hands; scroll wheel (or Q, 0–9) picks a weapon: pistol, minigun, plus plugin weapons. Bullet holes; shot cars flee, or stop while the driver jumps out and runs; they explode (big blast, chain reactions, 1–2 dead inside, a column of black smoke rising and thinning out before 30 m). Destructible trees, street lamps (the road lamps, the lamps on squares and the tall lamps along highways; a fallen lamp's light goes out), benches and fountains. A sky that follows the app's clock (and the sun's shadows do too): blue by day, an orange-to-violet gradient at dusk and dawn, dark and starry at night. |
| `savings-city-residents.user.js` | 2.5 | Needs core. Everyone walking the sidewalks is the app's own pedestrian (the app walks them: both sides of the street, crossings, doors, children, its crowd setting). When something happens to one, they're handed over to this script and react: shot, blown up, run over, buried, set alight. The **Drukte op straat** slider (2 = the app's own crowd, up to 4×; the app's crowd setting still applies) sets how many people there are. Panicking people run on the road network (not the app's walking), looking before they cross, and go into buildings now and then; they're removed when calm again and the app adds new ones (not after a nuke: the dead stay dead and the bodies stay, up to 4000). Out of the way of ground zero and rubble. They panic and scream, fall over, bleed, lose their heads on head shots and can be blown apart. People inside a building die when it comes down (or is nuked). They can catch fire (flamethrower; about 5 m outside where an explosion blows people apart, half of them): they run screaming for 1–5 seconds, fall and writhe on the ground for 5 seconds (weaker and weaker) and die there; the body burns on, the fire dies out and a charred, black body stays; whoever they touch catches fire too. The amount of blood follows the blood setting (and blood stays red on snow). Nobody walks on the highways (or on the roads that run into them), so nobody is run over there. Fixed: a child whose parent was caught while coming out of a door no longer freezes all the app's pedestrians. People are afraid of fire: they walk (or, close by, run) away from anyone burning, from burning bodies and from burning ground, and brushing past someone on fire doesn't always set you alight – so a fire no longer spreads through the whole crowd. |
| `savings-city-rocket-launcher.user.js` | 1.8 | Rocket launcher for walk mode (key 3; needs walk mode 1.22+, core and buildings). Craters of solid chunks in buildings, there right away: while you aim, the building under the crosshair is already cut into chunks (and finer where the crosshair rests); after 7 hits the building comes down, starting at the last impact, with dust rolling out over the ground; cars and residents burst into parts. |
| `savings-city-flamethrower.user.js` | 1.4 | Flamethrower for walk mode (key 4, hold the mouse button; needs walk mode 1.31+, core and residents 2.0+). A roaring stream of fire up to ~26 m that stops at walls and the ground and leaves black smoke; residents in it catch fire and burn to death. Cars in it catch fire after half a second: they stop, the driver jumps out burning, and a few seconds later the car explodes. Police officers catch fire too. |
| `savings-city-cops.user.js` | 1.16 | Needs core. Walk mode: shoot and the nearest police car stops, two officers get out and shoot back; now and then a police car comes along the roads from out of sight. Officers can be shot (head shots knock the head off), blown up, buried and set on fire (flamethrower, explosions, burning people: they run screaming, writhe on the ground and die there, leaving a charred body; they don't shoot meanwhile). Their aim is shaky: every officer has a steadier or shakier hand, the first shots are the worst, and from a distance they mostly miss (and miss wider). 10 hearts; each hit drops hamburgers on the sidewalks nearby – walk over one to fix a heart. When they're gone: "You died". An officer pinned on a harpoon turns on the shaft and keeps shooting (badly) until they bleed out. |
| `savings-city-heli-crane.user.js` | 1.1 | Needs core. Walk mode: the helicopter and the construction cranes go down after 2 shots or a rocket – the helicopter explodes, spins down and burns, a crane topples over. |
| `savings-city-drive.user.js` | 1.7 | Needs core. Walk mode: walk up to a car and press E – the driver runs off and you drive (W gas, S brake/reverse, A/D steer, Shift handbrake, Space the Tesla jump – the app's barrel roll on rocket thrusters, also while driving –, H horn, E get out; a camera that follows behind the car; needs walk mode 1.26+). Top speed 80 km/h, smooth acceleration, braking and steering; traffic queues behind or overtakes a car you parked in a lane; your own parked cars (road, sidewalk, anywhere) can be taken again with E, before any traffic passing by; kerbs don't stop you, buildings, trees, lamps, benches and fountains do; other cars get bumped (no damage); people you hit are run over. |
| `savings-city-billboard.user.js` | 1.0 | Walk mode: the big Savings City billboard breaks into pieces – every bullet knocks a piece out of it, rockets blow holes and can take out a post, and whatever is no longer held up (one post can't carry the whole width) falls down. |
| `savings-city-bodycount.user.js` | 1.1 | Counter (top right) of the dead, shown as "FTE bespaard" – residents, officers, people in exploding cars, the helicopter pilot; shot, run over, blown up, buried. Click to reset. |
| `savings-city-nuke.user.js` | 3.5 | Needs core and buildings. At night the lights go out as the shockwave passes: no halos left where buildings stood, ruins without lit windows, street lamps dark (and gone where the blast flattens everything). Lighter: fewer, bigger chunks and rubble; people and cars are hit only while the shockwave passes. The blast throws buildings hard outward, away from ground zero (chunks slide on along the ground). The middle of the mushroom cloud keeps boiling (no frozen puffs). ☢ button: a popup to pick the yield in tonnes of TNT (hand grenade … Tsar Bomba; blast radius, force and mushroom cloud follow it), aim with the crosshair (red rings show the reach), then a countdown while a B-2 bomber flies over and drops the bomb, which lands on ground zero as it goes off; flash, shockwave, buildings breaking into solid chunks that fly outward, ruins, mushroom cloud, camera shake. |
| `savings-city-skinner.user.js` | 1.7 | Needs core, walk mode and residents (cops for officers). Sci-fi skinner for walk mode (key 5, click): whoever it hits – a resident or a police officer – loses their skin in a flash of cyan energy; the outside of the figure is pulled straight up off the body (head first) as thin side panels in their own colours (clothes, skin, hair), revealing red flesh, organs, a skull, ribs and leg bones; the panels break apart and float down to land a few metres away; the insides show for a second, then every part falls in a heap on the floor, as if the skin was the only thing holding them together. Piles stay 20 seconds, people keep away from them, and the kills count as "skinned" in the bodycount. |
| `savings-city-yuletide.user.js` | 1.2 | Needs core, walk mode and residents 2.0+ (cops 1.13+ for officers). Yuletide grenade for walk mode (key 6, click to throw): a little Christmas tree that bounces off walls and goes off the moment it hits the ground (no time to run), with tinsel, snow and sleigh bells. A ring of bright green sprinkles shoots out over the ground and stops exactly at the edge of the blast, so you see who's in it. A green Christmas tree grows out of everyone within 10 m and tears them apart: blood sprays onto the ground and pools at its foot, their clothes (in their own colours) slump into a heap in that puddle, their organs hang in the tree as baubles, their bowels wind around it as a garland and their head is stuck on top, dripping. Trees stand 30 seconds, people keep away from them, the kills count as "tree" in the bodycount. |
| `savings-city-blackhole.user.js` | 1.0 | Needs core, walk mode 1.35+ and residents (buildings 1.6+ for buildings, cops for officers). Black hole grenade for walk mode (key 7, click to throw): a dark marble that bounces and rolls, then rises and opens into a black hole with a glowing rim and an accretion disk. Nobody notices it: people walk on until its pull, growing to ~34 m, has them. It drags in residents, officers, traffic cars, trees, lamps, benches, fountains and grit from the ground on a spiral, tumbling faster and faster with a trail of blood; near the horizon they stretch into long thin strands (screaming lower and lower) and vanish. Buildings are peeled from the side facing it and come down towards it. You're dragged along too. After 9 seconds it collapses with a rising howl and spits everything back out in one blast: building chunks, mangled heaps of people (flesh, a shoe, rags of their clothes, now and then a head) splatting on the ground, burnt burning car shells, trees and lamps. Kills count as "blackhole" in the bodycount. |
| `savings-city-harpoon.user.js` | 1.0 | Needs core, walk mode 1.37+ and residents (cops 1.16+ for officers). Kebab harpoon for walk mode (key 8, click): a heavy barbed bolt on a cable goes straight through everyone in its way – up to six people on one shaft, the first nearest the tip – and sticks in the next wall, tree, lamp or the ground (low on a bolt in the ground they lie in a heap at its foot). They twitch, go limp, bleed out of both sides and drip into pools; the kebab stays 45 seconds. Police officers on the shaft turn and keep shooting at you, badly, until they bleed out. A car that's hit is on the line: the driver bails out; hold the mouse button to reel it in (it turns so the hook trails and knocks over whoever is in the way, and stops in front of you), let go and it rolls on; X cuts the cable. Kills count as "harpoon" in the bodycount. |
| `savings-city-balloon.user.js` | 1.0 | Needs core, walk mode 1.38+ and residents 2.0+ (cops 1.13+ for officers). Balloonator for walk mode (key 9, click): a dart gun that shoots small ampoules of pink serum. Whoever is hit – a resident or a police officer – swells up into a sphere (shirt on top, trousers underneath, a band of bare belly where the shirt rides up), with stubby kicking legs and a puffed-up head, and floats up into the sky, swinging, turning and wailing in a squeaky voice. In the last two seconds they over-inflate, tremble, creak and flush red, and at 10 seconds, about 8 m up, they burst: a bang, a red mist, and their insides (flesh, organs, skull, ribs, spine, bones, intestines) rain down on the street with rags of their clothes and skin fluttering after them – blood sprays everywhere, rains down for a moment, splats where every piece lands and pools under the spot. Shoot a floating balloon (or blow something up next to it) to pop it early. Heaps lie 25 seconds, people keep away from them, kills count as "balloon" in the bodycount. |
| `savings-city-monster.user.js` | 1.4 | Button that releases a giant green monster with round glasses: it walks into the city, punches and tramples buildings, which collapse into solid chunks (needs core and buildings). |
| `savings-city-meteors.user.js` | 1.1 | Needs core and buildings (residents, walk mode and cops make it worse). ☄ button: a meteor shower of 10–40 burning rocks, all coming in at the same angle on parallel lines, with trails of fire that cool into grey smoke streaks. Some are aimed at the biggest buildings (at a random spot on the building, so it looks like chance), the rest land anywhere over the city. Whatever is in their path is destroyed: a building a meteor runs into collapses, thrown the way the meteor flies, and big meteors plough on through the next one. On the ground: an explosion, rocks and dirt flying, dust rolling out, black smoke and a crater with the rock still glowing in it. The ground keeps burning for half a minute or so – in the crater and in scorched patches around it – and people keep away from the flames (residents 2.5+; whoever stands in them catches fire). Damage adds up over the shower: a badly damaged building collapses, a lighter hit blows a crater in its side; people are blown apart, knocked down, set alight or run; cars burn out or catch fire and explode; lamps, trees and benches go down. Click again to stop the meteors that haven't come in yet. |

Every script needs the core except the bodycount and the billboard; the rocket
launcher, the monster, the nuke and the meteor shower also need buildings. Some work together (walk mode + residents + rocket launcher + flamethrower + cops + helicopter/cranes + billboard + drive;
the rocket launcher, the monster and the nuke share damaged buildings; the bodycount counts what the others
report). Each script's header comment explains how it works.

## Running the app locally

This repository contains a copy of the Savings City app (`app/`) and a small local server
(`local/`), so you can run the city with all scripts on your own machine – no Tampermonkey and no
access to the real app needed. The city comes from `local/city.json`, an anonymous example city.

**Needs:** [Node.js](https://nodejs.org/) 18 or newer. Nothing to install for the server itself.

```bash
git clone https://github.com/Pixelfest/savings-city-after-dark.git
cd savings-city-after-dark
node local/server.js
```

(or `npm start`). Then open:

- http://localhost:8080/ – the city with all scripts,
- http://localhost:8080/plugins – tick the scripts you want and open the city,
- or choose them in the address: `http://localhost:8080/?plugins=walk-mode,residents`
  (`?plugins=` = no scripts at all, the plain app).

Options:

| Option | What it does |
|---|---|
| `--port 9000` | Another port (default 8080, or `$PORT`). |
| `--city other.json` | Another city file (the `/api/city` format). |
| `--test-city other.json` | Another city file for the test city (below). |
| `--plugins nuke,monster` | The scripts loaded when the address has no `?plugins=` (default: all). |
| `?date=2026-07-01`, `?time=22:00`, `?timelapse=60` | In the address: date, time and clock speed, as in the real app (the graphics script sets these itself for winter and day/night). |

Edits you make in the app (placing projects, roads, …) are kept in memory until the server stops;
`city.json` is never written. The scripts are served straight from the repository, so after editing
a script just reload the page. The loading-screen images aren't in the copy (shown blank), and the
font comes from Google Fonts when you're online.

### Test city

http://localhost:8080/test (with the same `?plugins=`, or the "Open teststad" button on `/plugins`)
opens a small city that is the same every time, for quick and repeatable testing:

- 3 buildings (small, medium, large) inside a ring road (`local/test-city.json`),
- 100 people standing still in rows on the sidewalks of the north and south road,
- 8 police officers in a row along the east road (with the cops and walk mode scripts; they appear
  the first time you start walking),
- the 6 cars parked nose to tail on the south road,
- a summer afternoon that stands still and a seeded random generator; in automated runs
  (Playwright) also a fixed frame step.

Nothing walks or drives until something happens to it (a shot, a blast, a fire). Every load of
`/test` starts again from the same city (edits are kept only until the next load) and doesn't
touch the normal city. A red badge at the bottom left shows you're in the test city.

| In the address | What it does |
|---|---|
| `?seed=2` | Another random sequence (default 1). Same seed, same run. |
| `?people=40`, `?cops=0` | How many people (up to 200) and officers. |
| `?fps=60` | A fixed step: each frame is exactly 1/60 s, however long it took (default in automated runs; `?fps=0` = real time, the default in your own browser). |
| `?hold=0` | People and cars move as usual. |
| `?date=`, `?time=`, `?timelapse=` | Another moment (default 22 June 2026, 14:00, standing still). |

In the console, `scTest` has the people, officers, cars and buildings, and `scTest.wait(seconds)` /
`scTest.frames(n)` wait in game time.

`local/test-run.js` runs one repeatable test there headless: it opens the test city with the chosen
scripts, can start walking and stand somewhere, runs an action at a known random state, and saves
screenshots at set game times plus a JSON report of what happened (deaths, kills, blasts):

```bash
node local/test-run.js --plugins core,walk-mode,residents,cops --walk 7,1.6 --look 5,0.05,0.2 \
  --do "scResidents.blast(5, 0.2, 0.6, 2.5, 8, 0.3)" --at 0,1,3 --out /tmp/run
```

### Screenshots without a browser

`local/shot.js` opens the local city in headless Chromium and saves a PNG – handy for checking a
change (and for agents). It needs Playwright: `npm install` and `npx playwright install chromium`
once (or use a global Playwright install).

```bash
node local/server.js --port 8123 &
node local/shot.js 'http://localhost:8123/?plugins=core,graphics' city.png --wait 15000
```

`--eval "js"` runs code in the page before the screenshot, e.g.
`--eval "document.querySelector('[title*=Nuke]')?.click()"`. On the test city
(`http://localhost:8123/test?plugins=…`) it first waits until the test scene is set up.

## Development

- `CONTEXT.md` – how the app works internally and how the scripts hook into it. Read this first.
- `AGENTS.md` (and `CLAUDE.md`) – instructions for coding agents: conventions, releases, and how to
  bring in a newer version of the app.
- `app/` – an anonymised copy of the app (`Savings City.html` and `Savings City_files/`: minified JS
  bundles, including the lazily loaded 3D code `CityCanvas-*.js`, CSS, logo). It's all in the
  repository; the local runner serves it. Reference only – don't edit the bundles.
- `local/city.json` – the anonymous example city; `local/test-city.json` + `local/test-scene.js` –
  the small test city (`/test`); `local/test-run.js` – one repeatable test in it.
- How changes are tested: first in the test city (a few automated runs), then by you, for real, in
  the browser – see `AGENTS.md` → "Testing".

When the real app changes, a developer can hand the newest app files to an agent; how to bring
them in (anonymised) is described in `AGENTS.md` → "Updating the app files".

### Privacy

This repository is public. It must never contain the real app's address or anything that could
identify a person or the organisation behind it (only public libraries and placeholder addresses
such as `example.com`). A guard checks this on every push and pull request (GitHub Actions). Turn on
the same check before every `git push` from your own clone (`npm install` does this too):

```bash
git config core.hooksPath .githooks
```

Or run it by hand:

```bash
node tools/check-privacy.js
```

To also check for the real address and names, list them in a file `.private-terms` (one per line)
in your own copy; it's git-ignored and never leaves your machine.

### Releases

Bump the changed scripts' `@version`, then the loader's `@version` and every `?v=` on its
`@require` lines to the new release number, update the table above, and commit as
`Release X.Y: …`. Tampermonkey then picks up the new loader and fetches all scripts again.
