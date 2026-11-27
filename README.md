# Savings City – After Dark

Tampermonkey userscripts that add mayhem to the Savings City web app: walk through the city in first
person, residents who panic and scream, cars that explode, a rocket launcher, a flamethrower, police who shoot
back, a black hole grenade, a kebab harpoon, a nuke, a giant monster, cars you can steal and drive, a billboard to shoot to pieces – and a
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
Keep the core and buildings: almost every script needs the core (only the bodycount and billboard don't), and the rocket launcher, the monster and the nuke also need buildings.

Set the address under *User matches* rather than editing the loader: once you edit the loader,
Tampermonkey stops updating it, and then the scripts it loads don't update either.

### Scripts one by one

Add each `.user.js` file separately (Dashboard → `+` → paste, or drag the file in) and set the
`@match` address in every one. They don't update by themselves. Always install the core (every script
except the bodycount and billboard needs it), and the buildings script too for the
rocket launcher, the monster or the nuke. The order in Tampermonkey's list doesn't matter.

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
| `savings-city-walk-mode.user.js` | 1.36 | Needs core. First-person walk mode (WASD + mouse, `,`/`.` slower/faster, Esc to stop), start from a building's door (double-click it), or double-click open ground outside the city to start there, facing the city centre. You start with empty hands; scroll wheel (or Q, 0–8) picks a weapon: pistol, minigun, plus plugin weapons. Bullet holes; shot cars flee, or stop while the driver jumps out and runs; they explode (big blast, chain reactions, 1–2 dead inside, a column of black smoke rising and thinning out before 30 m). Destructible trees, street lamps (the road lamps, the lamps on squares and the tall lamps along highways; a fallen lamp's light goes out), benches and fountains. A sky that follows the app's clock (and the sun's shadows do too): blue by day, an orange-to-violet gradient at dusk and dawn, dark and starry at night. |
| `savings-city-residents.user.js` | 2.2 | Needs core. Everyone walking the sidewalks is the app's own pedestrian (the app walks them: both sides of the street, crossings, doors, children, its crowd setting). When something happens to one, they're handed over to this script and react: shot, blown up, run over, buried, set alight. The **Drukte op straat** slider (2 = the app's own crowd, up to 4×; the app's crowd setting still applies) sets how many people there are. Panicking people run on the road network (not the app's walking), looking before they cross, and go into buildings now and then; they're removed when calm again and the app adds new ones. Out of the way of ground zero and rubble. They panic and scream, fall over, bleed, lose their heads on head shots and can be blown apart. People inside a building die when it comes down (or is nuked). They can catch fire (flamethrower; about 5 m outside where an explosion blows people apart, half of them): they run screaming for 1–5 seconds, fall and writhe on the ground for 5 seconds (weaker and weaker) and die there; the body burns on, the fire dies out and a charred, black body stays; whoever they touch catches fire too. The amount of blood follows the blood setting (and blood stays red on snow). Nobody walks on the highways (or on the roads that run into them), so nobody is run over there. |
| `savings-city-rocket-launcher.user.js` | 1.8 | Rocket launcher for walk mode (key 3; needs walk mode 1.22+, core and buildings). Craters of solid chunks in buildings, there right away: while you aim, the building under the crosshair is already cut into chunks (and finer where the crosshair rests); after 7 hits the building comes down, starting at the last impact, with dust rolling out over the ground; cars and residents burst into parts. |
| `savings-city-flamethrower.user.js` | 1.4 | Flamethrower for walk mode (key 4, hold the mouse button; needs walk mode 1.31+, core and residents 2.0+). A roaring stream of fire up to ~26 m that stops at walls and the ground and leaves black smoke; residents in it catch fire and burn to death. Cars in it catch fire after half a second: they stop, the driver jumps out burning, and a few seconds later the car explodes. Police officers catch fire too. |
| `savings-city-cops.user.js` | 1.16 | Needs core. Walk mode: shoot and the nearest police car stops, two officers get out and shoot back; now and then a police car comes along the roads from out of sight. Officers can be shot (head shots knock the head off), blown up, buried and set on fire (flamethrower, explosions, burning people: they run screaming, writhe on the ground and die there, leaving a charred body; they don't shoot meanwhile). Their aim is shaky: every officer has a steadier or shakier hand, the first shots are the worst, and from a distance they mostly miss (and miss wider). 10 hearts; each hit drops hamburgers on the sidewalks nearby – walk over one to fix a heart. When they're gone: "You died". An officer pinned on a harpoon turns on the shaft and keeps shooting (badly) until they bleed out. |
| `savings-city-heli-crane.user.js` | 1.1 | Needs core. Walk mode: the helicopter and the construction cranes go down after 2 shots or a rocket – the helicopter explodes, spins down and burns, a crane topples over. |
| `savings-city-drive.user.js` | 1.7 | Needs core. Walk mode: walk up to a car and press E – the driver runs off and you drive (W gas, S brake/reverse, A/D steer, Shift handbrake, Space the Tesla jump – the app's barrel roll on rocket thrusters, also while driving –, H horn, E get out; a camera that follows behind the car; needs walk mode 1.26+). Top speed 80 km/h, smooth acceleration, braking and steering; traffic queues behind or overtakes a car you parked in a lane; your own parked cars (road, sidewalk, anywhere) can be taken again with E, before any traffic passing by; kerbs don't stop you, buildings, trees, lamps, benches and fountains do; other cars get bumped (no damage); people you hit are run over. |
| `savings-city-billboard.user.js` | 1.0 | Walk mode: the big Savings City billboard breaks into pieces – every bullet knocks a piece out of it, rockets blow holes and can take out a post, and whatever is no longer held up (one post can't carry the whole width) falls down. |
| `savings-city-bodycount.user.js` | 1.0 | Counter (top right) of the dead – residents, officers, people in exploding cars, the helicopter pilot; shot, run over, blown up, buried – and exploded cars. Click to reset. |
| `savings-city-nuke.user.js` | 3.5 | Needs core and buildings. At night the lights go out as the shockwave passes: no halos left where buildings stood, ruins without lit windows, street lamps dark (and gone where the blast flattens everything). Lighter: fewer, bigger chunks and rubble; people and cars are hit only while the shockwave passes. The blast throws buildings hard outward, away from ground zero (chunks slide on along the ground). The middle of the mushroom cloud keeps boiling (no frozen puffs). ☢ button: a popup to pick the yield in tonnes of TNT (hand grenade … Tsar Bomba; blast radius, force and mushroom cloud follow it), aim with the crosshair (red rings show the reach), then a countdown while a B-2 bomber flies over and drops the bomb, which lands on ground zero as it goes off; flash, shockwave, buildings breaking into solid chunks that fly outward, ruins, mushroom cloud, camera shake. |
| `savings-city-skinner.user.js` | 1.7 | Needs core, walk mode and residents (cops for officers). Sci-fi skinner for walk mode (key 5, click): whoever it hits – a resident or a police officer – loses their skin in a flash of cyan energy; the outside of the figure is pulled straight up off the body (head first) as thin side panels in their own colours (clothes, skin, hair), revealing red flesh, organs, a skull, ribs and leg bones; the panels break apart and float down to land a few metres away; the insides show for a second, then every part falls in a heap on the floor, as if the skin was the only thing holding them together. Piles stay 20 seconds, people keep away from them, and the kills count as "skinned" in the bodycount. |
| `savings-city-yuletide.user.js` | 1.2 | Needs core, walk mode and residents 2.0+ (cops 1.13+ for officers). Yuletide grenade for walk mode (key 6, click to throw): a little Christmas tree that bounces off walls and goes off the moment it hits the ground (no time to run), with tinsel, snow and sleigh bells. A ring of bright green sprinkles shoots out over the ground and stops exactly at the edge of the blast, so you see who's in it. A green Christmas tree grows out of everyone within 10 m and tears them apart: blood sprays onto the ground and pools at its foot, their clothes (in their own colours) slump into a heap in that puddle, their organs hang in the tree as baubles, their bowels wind around it as a garland and their head is stuck on top, dripping. Trees stand 30 seconds, people keep away from them, the kills count as "tree" in the bodycount. |
| `savings-city-blackhole.user.js` | 1.0 | Needs core, walk mode 1.35+ and residents (buildings 1.6+ for buildings, cops for officers). Black hole grenade for walk mode (key 7, click to throw): a dark marble that bounces and rolls, then rises and opens into a black hole with a glowing rim and an accretion disk. Nobody notices it: people walk on until its pull, growing to ~34 m, has them. It drags in residents, officers, traffic cars, trees, lamps, benches, fountains and grit from the ground on a spiral, tumbling faster and faster with a trail of blood; near the horizon they stretch into long thin strands (screaming lower and lower) and vanish. Buildings are peeled from the side facing it and come down towards it. You're dragged along too. After 9 seconds it collapses with a rising howl and spits everything back out in one blast: building chunks, mangled heaps of people (flesh, a shoe, rags of their clothes, now and then a head) splatting on the ground, burnt burning car shells, trees and lamps. Kills count as "blackhole" in the bodycount. |
| `savings-city-harpoon.user.js` | 1.0 | Needs core, walk mode 1.36+ and residents (cops 1.16+ for officers). Kebab harpoon for walk mode (key 8, click): a heavy barbed bolt on a cable goes straight through everyone in its way – up to six people on one shaft, the first nearest the tip – and sticks in the next wall, tree, lamp or the ground (low on a bolt in the ground they lie in a heap at its foot). They twitch, go limp, bleed out of both sides and drip into pools; the kebab stays 45 seconds. Police officers on the shaft turn and keep shooting at you, badly, until they bleed out. A car that's hit is on the line: the driver bails out; hold the mouse button to reel it in (it turns so the hook trails and knocks over whoever is in the way, and stops in front of you), let go and it rolls on; X cuts the cable. Kills count as "harpoon" in the bodycount. |
| `savings-city-monster.user.js` | 1.4 | Button that releases a giant green monster with round glasses: it walks into the city, punches and tramples buildings, which collapse into solid chunks (needs core and buildings). |

Every script needs the core except the bodycount and the billboard; the rocket
launcher, the monster and the nuke also need buildings. Some work together (walk mode + residents + rocket launcher + flamethrower + cops + helicopter/cranes + billboard + drive;
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
| `--plugins nuke,monster` | The scripts loaded when the address has no `?plugins=` (default: all). |
| `?date=2026-07-01`, `?time=22:00`, `?timelapse=60` | In the address: date, time and clock speed, as in the real app (the graphics script sets these itself for winter and day/night). |

Edits you make in the app (placing projects, roads, …) are kept in memory until the server stops;
`city.json` is never written. The scripts are served straight from the repository, so after editing
a script just reload the page. The loading-screen images aren't in the copy (shown blank), and the
font comes from Google Fonts when you're online.

### Screenshots without a browser

`local/shot.js` opens the local city in headless Chromium and saves a PNG – handy for checking a
change (and for agents). It needs Playwright: `npm install` and `npx playwright install chromium`
once (or use a global Playwright install).

```bash
node local/server.js --port 8123 &
node local/shot.js 'http://localhost:8123/?plugins=core,graphics' city.png --wait 15000
```

`--eval "js"` runs code in the page before the screenshot, e.g.
`--eval "document.querySelector('[title*=Nuke]')?.click()"`.

## Development

- `CONTEXT.md` – how the app works internally and how the scripts hook into it. Read this first.
- `AGENTS.md` (and `CLAUDE.md`) – instructions for coding agents: conventions, releases, and how to
  bring in a newer version of the app.
- `app/` – an anonymised copy of the app (`Savings City.html` and `Savings City_files/`: minified JS
  bundles, including the lazily loaded 3D code `CityCanvas-*.js`, CSS, logo). It's all in the
  repository; the local runner serves it. Reference only – don't edit the bundles.
- `local/city.json` – the anonymous test city.

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
