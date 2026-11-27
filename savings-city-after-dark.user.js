// ==UserScript==
// @name         Savings City – After Dark (loader)
// @namespace    savings-city-tweaks
// @version      1.44
// @description  Loads all Savings City After Dark scripts from GitHub, so you install one script and get every update.
// @match        https://your-savings-city-host.example/*
// @run-at       document-start
// @grant        none
// @updateURL    https://raw.githubusercontent.com/Pixelfest/savings-city-after-dark/main/savings-city-after-dark.user.js
// @downloadURL  https://raw.githubusercontent.com/Pixelfest/savings-city-after-dark/main/savings-city-after-dark.user.js
// @require      https://raw.githubusercontent.com/Pixelfest/savings-city-after-dark/main/savings-city-core.user.js?v=1.44
// @require      https://raw.githubusercontent.com/Pixelfest/savings-city-after-dark/main/savings-city-buildings.user.js?v=1.44
// @require      https://raw.githubusercontent.com/Pixelfest/savings-city-after-dark/main/savings-city-bodycount.user.js?v=1.44
// @require      https://raw.githubusercontent.com/Pixelfest/savings-city-after-dark/main/savings-city-car-tyres.user.js?v=1.44
// @require      https://raw.githubusercontent.com/Pixelfest/savings-city-after-dark/main/savings-city-auto-layout.user.js?v=1.44
// @require      https://raw.githubusercontent.com/Pixelfest/savings-city-after-dark/main/savings-city-graphics.user.js?v=1.44
// @require      https://raw.githubusercontent.com/Pixelfest/savings-city-after-dark/main/savings-city-walk-mode.user.js?v=1.44
// @require      https://raw.githubusercontent.com/Pixelfest/savings-city-after-dark/main/savings-city-residents.user.js?v=1.44
// @require      https://raw.githubusercontent.com/Pixelfest/savings-city-after-dark/main/savings-city-rocket-launcher.user.js?v=1.44
// @require      https://raw.githubusercontent.com/Pixelfest/savings-city-after-dark/main/savings-city-flamethrower.user.js?v=1.44
// @require      https://raw.githubusercontent.com/Pixelfest/savings-city-after-dark/main/savings-city-cops.user.js?v=1.44
// @require      https://raw.githubusercontent.com/Pixelfest/savings-city-after-dark/main/savings-city-skinner.user.js?v=1.44
// @require      https://raw.githubusercontent.com/Pixelfest/savings-city-after-dark/main/savings-city-yuletide.user.js?v=1.44
// @require      https://raw.githubusercontent.com/Pixelfest/savings-city-after-dark/main/savings-city-blackhole.user.js?v=1.44
// @require      https://raw.githubusercontent.com/Pixelfest/savings-city-after-dark/main/savings-city-harpoon.user.js?v=1.44
// @require      https://raw.githubusercontent.com/Pixelfest/savings-city-after-dark/main/savings-city-balloon.user.js?v=1.44
// @require      https://raw.githubusercontent.com/Pixelfest/savings-city-after-dark/main/savings-city-heli-crane.user.js?v=1.44
// @require      https://raw.githubusercontent.com/Pixelfest/savings-city-after-dark/main/savings-city-billboard.user.js?v=1.44
// @require      https://raw.githubusercontent.com/Pixelfest/savings-city-after-dark/main/savings-city-drive.user.js?v=1.44
// @require      https://raw.githubusercontent.com/Pixelfest/savings-city-after-dark/main/savings-city-nuke.user.js?v=1.44
// @require      https://raw.githubusercontent.com/Pixelfest/savings-city-after-dark/main/savings-city-monster.user.js?v=1.44
// @require      https://raw.githubusercontent.com/Pixelfest/savings-city-after-dark/main/savings-city-meteors.user.js?v=1.44
// ==/UserScript==

/*
 * This script has no code of its own: Tampermonkey runs every @require above, in that order,
 * before the app starts (document-start). Their own headers (@match, @version) are ignored.
 *
 * - Set @match above to the address of your Savings City app (keep the /* at the end), or add it
 *   in Tampermonkey under this script's Settings → Includes/Excludes → User matches.
 * - Don't want a script? Delete its @require line (or put a space between // and @require).
 * - Keep the core: almost every script needs it (the bodycount and billboard don't);
 *   the rocket launcher, the monster, the nuke and the meteor shower also need buildings. Keep core and buildings first.
 * - Tampermonkey keeps a copy of the required files. Every release bumps this loader's @version and
 *   the ?v=… on the URLs above, so when Tampermonkey updates the loader (its update check, or
 *   "Check for userscript updates" in its menu) it fetches all scripts fresh.
 * - The console shows which loader version runs: "[Savings City After Dark] loader x.y".
 */
console.info('[Savings City After Dark] loader 1.44');
