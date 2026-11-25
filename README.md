# Savings City – After Dark

Tampermonkey userscripts that add mayhem to the Savings City web app: walk through the city in first
person, residents who panic and scream, cars that explode, a rocket launcher, police who shoot
back, a nuke, a giant monster – and a bodycount. They hook into the app's three.js scene from the
outside (no changes to the app itself); everything happens only in your own browser – reload the
page and the city is back as it was.

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
4. **Get updates automatically:** Tampermonkey Dashboard → *Settings* → *Config mode: Advanced* →
   *Externals* → *Update Interval*: **Always**. The loader pulls every script straight from this
   repository (`@require`), so each page load then picks up the latest versions.

The loader contains every script below. To leave one out, delete its `@require` line in the loader.
Keep the order: walk mode comes before residents, rocket launcher and cops, which build on it.

If you edit the loader (address, removed scripts), Tampermonkey will no longer replace it with
newer loader versions from GitHub; the scripts it loads still update.

### Scripts one by one

Add each `.user.js` file separately (Dashboard → `+` → paste, or drag the file in) and set the
`@match` address in every one. They don't update by themselves.

Settings are constants at the top of each script.

| Script | Version | What it does |
|---|---|---|
| `savings-city-season-toggle.user.js` | 1.0 | Button to switch between winter (snow, Christmas trees) and the normal season. |
| `savings-city-auto-layout.user.js` | 2.1 | Organic city layout: tall buildings in the centre, smaller ones outside, roads between them and a ring road connecting loose ends. |
| `savings-city-car-tyres.user.js` | 1.3 | Wider, optionally round tyres (no more flickering). |
| `savings-city-walk-mode.user.js` | 1.20 | First-person walk mode (WASD + mouse, Esc to stop), start from a building's door. Weapons: pistol (1), minigun (2), plus plugin weapons. Bullet holes, cars that flee and explode (big blast, chain reactions, a column of black smoke rising and fading), destructible trees and street lamps. |
| `savings-city-residents.user.js` | 1.10 | Residents walking the sidewalks, entering and leaving buildings, looking before they cross. They panic and scream, fall over, bleed, lose their heads on head shots and can be blown apart. People inside a building die when it comes down (or is nuked). |
| `savings-city-rocket-launcher.user.js` | 1.4 | Rocket launcher for walk mode (key 3; needs walk mode 1.20+). Craters of solid chunks in buildings; after 7 hits the building comes down, starting at the last impact, with dust rolling out over the ground; cars and residents burst into parts. |
| `savings-city-cops.user.js` | 1.0 | Walk mode: shoot and the nearest police car stops, two officers get out and shoot back. 10 hearts; when they're gone: "You died". |
| `savings-city-bodycount.user.js` | 1.0 | Counter (top right) of the dead – residents and officers; shot, run over, blown up, buried – and exploded cars. Click to reset. |
| `savings-city-nuke.user.js` | 2.4 | ☢ button: countdown, flash, shockwave, buildings breaking into solid chunks that fly outward, ruins, mushroom cloud, camera shake. |
| `savings-city-monster.user.js` | 1.2 | Button that releases a giant green monster with round glasses: it walks into the city, punches and tramples buildings, which collapse into solid chunks. |

The scripts work on their own; some work together (walk mode + residents + rocket launcher + cops;
the monster and the rocket launcher share damaged buildings; the bodycount counts what the others
report). Each script's header comment explains how it works.
