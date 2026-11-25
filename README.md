# Savings City – After Dark

Tampermonkey userscripts that add mayhem to the Savings City web app: walk through the city in first
person, residents who panic and scream, cars that explode, a rocket launcher, police who shoot
back, a nuke, a giant monster, cars you can steal and drive, a billboard to shoot to pieces – and a
bodycount. They hook into the app's three.js scene from the outside (no changes to the app itself);
everything happens only in your own browser – reload the page and the city is back as it was.

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
Keep the core and buildings: almost every script needs the core (only the bodycount, season toggle and billboard don't), and the rocket launcher, the monster and the nuke also need buildings.

Set the address under *User matches* rather than editing the loader: once you edit the loader,
Tampermonkey stops updating it, and then the scripts it loads don't update either.

### Scripts one by one

Add each `.user.js` file separately (Dashboard → `+` → paste, or drag the file in) and set the
`@match` address in every one. They don't update by themselves. Always install the core (every script
except the bodycount, season toggle and billboard needs it), and the buildings script too for the
rocket launcher, the monster or the nuke. The order in Tampermonkey's list doesn't matter.

Settings are constants at the top of each script; the most useful ones are also sliders in the
settings popup (the menu button with the sliders icon): detail when things break (5 steps, each
doubles the pieces – prettier, heavier), rockets before a building collapses, residents per street
and the car's top speed. All sounds follow the app's own sound button (mute and volume).

| Script | Version | What it does |
|---|---|---|
| `savings-city-core.user.js` | 1.2 | Shared base, install it first. Adds a settings button (sliders icon) to the menu: a popup with sliders the scripts add – detail when things break (5 steps, each doubles the pieces: prettier, heavier), rockets before a building collapses, residents per street, the car's top speed – remembered in the browser. Also: the app's scene, renderer and camera, three.js classes, city data, traffic, sound (follows the app's sound button), one frame loop, dust puffs and the damage bus (`scCore.damage(...)`) that weapons and disasters use to break things. Nothing visible on its own. |
| `savings-city-buildings.user.js` | 1.2 | Solid buildings, shared by the rocket launcher, the monster and the nuke (needs the core): buildings turn into chunks with the facade outside and concrete inside (at most ~800 per building: big buildings get bigger chunks), get craters, collapse from an impact or are pushed over, with dust rolling out; cutting runs in the background, a hit that arrives earlier waits for it. People keep away from the rubble. |
| `savings-city-season-toggle.user.js` | 1.0 | Button to switch between winter (snow, Christmas trees) and the normal season. |
| `savings-city-auto-layout.user.js` | 2.4 | Needs core. Organic city layout: tall buildings in the centre, smaller ones outside, roads between them; optionally (`RING_ROAD`, off by default) a ring road connecting loose ends. |
| `savings-city-car-tyres.user.js` | 1.4 | Needs core. Wider, optionally round tyres (no more flickering). |
| `savings-city-walk-mode.user.js` | 1.27 | Needs core. First-person walk mode (WASD + mouse, `,`/`.` slower/faster, Esc to stop), start from a building's door. You start with empty hands; scroll wheel (or Q, 0–3) picks a weapon: pistol, minigun, plus plugin weapons. Bullet holes; shot cars flee, or stop while the driver jumps out and runs; they explode (big blast, chain reactions, 1–2 dead inside, a column of black smoke rising and fading). Destructible trees, street lamps, benches and fountains. |
| `savings-city-residents.user.js` | 1.17 | Needs core. Residents (some adults with a child beside them) walking the sidewalks on both sides, stepping aside for each other, crossing only at junctions and all the way across, entering and leaving buildings, looking before they cross (most of them in a panic too). They walk away from ground zero and rubble and don't go back in. They panic and scream, fall over, bleed, lose their heads on head shots and can be blown apart. People inside a building die when it comes down (or is nuked). |
| `savings-city-rocket-launcher.user.js` | 1.6 | Rocket launcher for walk mode (key 3; needs walk mode 1.22+, core and buildings). Craters of solid chunks in buildings; after 7 hits the building comes down, starting at the last impact, with dust rolling out over the ground; cars and residents burst into parts. |
| `savings-city-cops.user.js` | 1.4 | Needs core. Walk mode: shoot and the nearest police car stops, two officers get out and shoot back; now and then a police car comes along the roads from out of sight. Officers can be shot (head shots knock the head off), blown up and buried. 10 hearts; each hit drops hamburgers on the sidewalks nearby – walk over one to fix a heart. When they're gone: "You died". |
| `savings-city-heli-crane.user.js` | 1.1 | Needs core. Walk mode: the helicopter and the construction cranes go down after 2 shots or a rocket – the helicopter explodes, spins down and burns, a crane topples over. |
| `savings-city-drive.user.js` | 1.4 | Needs core. Walk mode: walk up to a car and press E – the driver runs off and you drive (W gas, S brake/reverse, A/D steer, Space handbrake, H horn, C driver's seat / chase camera, E get out; needs walk mode 1.26+). Top speed 80 km/h, smooth acceleration, braking and steering; traffic queues behind or overtakes a car you parked in a lane; your own parked cars (road, sidewalk, anywhere) can be taken again with E, before any traffic passing by; kerbs don't stop you, buildings, trees, lamps, benches and fountains do; other cars get bumped (no damage); people you hit are run over. |
| `savings-city-billboard.user.js` | 1.0 | Walk mode: the big Savings City billboard breaks into pieces – every bullet knocks a piece out of it, rockets blow holes and can take out a post, and whatever is no longer held up (one post can't carry the whole width) falls down. |
| `savings-city-bodycount.user.js` | 1.0 | Counter (top right) of the dead – residents, officers, people in exploding cars, the helicopter pilot; shot, run over, blown up, buried – and exploded cars. Click to reset. |
| `savings-city-nuke.user.js` | 3.2 | Needs core and buildings. Lighter: fewer, bigger chunks and rubble; people and cars are hit only while the shockwave passes. ☢ button: a popup to pick the yield in tonnes of TNT (hand grenade … Tsar Bomba; blast radius, force and mushroom cloud follow it), aim with the crosshair (red rings show the reach), then a countdown while a B-2 bomber flies over and drops the bomb, which lands on ground zero as it goes off; flash, shockwave, buildings breaking into solid chunks that fly outward, ruins, mushroom cloud, camera shake. |
| `savings-city-monster.user.js` | 1.4 | Button that releases a giant green monster with round glasses: it walks into the city, punches and tramples buildings, which collapse into solid chunks (needs core and buildings). |

Every script needs the core except the bodycount, the season toggle and the billboard; the rocket
launcher, the monster and the nuke also need buildings. Some work together (walk mode + residents + rocket launcher + cops + helicopter/cranes + billboard + drive;
the rocket launcher, the monster and the nuke share damaged buildings; the bodycount counts what the others
report). Each script's header comment explains how it works.
