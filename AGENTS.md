# Savings City – After Dark: instructions for agents

Tampermonkey userscripts that add features (and mayhem) to the Savings City web app, plus a local
copy of that app to develop and test them on. Everything for this project lives in this
repository: scripts, local runner, app copy, test city, docs and releases.

Before changing anything, read `CONTEXT.md`: it describes the app (three.js city, how buildings,
cars, trees and lamps are built), how the scripts hook into it without changing app code, how the
scripts talk to each other, and how to test without the real app. Test changes in the test city (`/test`, see "Testing" below)
and finish by asking the user to test for real – don't loop on automated tests.

## Privacy rules (this repository is public)

Nothing in this repository may point to a specific web address of the real app or its owner, or
contain data that could be personal information. This applies to every file, commit message, pull
request, issue and comment.

- **No real addresses.** Never write the real Savings City host, its API, logo or favicon URLs,
  internal host names, or any other address that leads to the real app or the organisation behind
  it. Use the placeholder `https://your-savings-city-host.example/` (the scripts `@match`
  `https://your-savings-city-host.example/*`) or a root-relative path (`/api/city`, `/logo/coin.png`).
- **No personal or identifying data.** No names of people, teams, the company or its customers; no
  e-mail addresses, phone numbers, user ids, real project names or descriptions, real figures
  (hours, budgets, totals), real database ids, or locations that point to the organisation.
- **Allowed exceptions:** public libraries, repositories and files – three.js, React, Tampermonkey,
  Google Fonts, Node/Playwright docs, GitHub, this repository's own `raw.githubusercontent.com`
  URLs (the loader updates from them) – and placeholders such as `example.com` / `voorbeeld.nl`.
  The full list is `ALLOWED_HOSTS` in `tools/check-privacy.js`; add a host there only if it is
  public and unrelated to the real app's owner.
- **City data must be anonymous:** project names made up, description
  `Voorbeeldproject (geanonimiseerd).`, authors `Bouwer A`, `Bouwer B`, …, links `null` or
  `https://example.com/`, fresh UUIDs, figures scrambled.
- **App files are anonymised before they're committed** (see "Updating the app files"). Never
  commit files from the real app as they are: a saved page contains the real host and real data.
- **The guard:** `tools/check-privacy.js` runs on every push and pull request (GitHub Actions,
  `.github/workflows/privacy.yml`) and before every `git push` from a clone with the hook enabled
  (`git config core.hooksPath .githooks`; `npm install` does this). Enable the hook in your
  clone and run `node tools/check-privacy.js` before committing. If it fails, fix the content –
  don't silence, skip (`--no-verify`) or weaken the check.
- Locally, put the real host, company and people's names in `.private-terms` (one per line;
  git-ignored, never commit it) and the check looks for those too. CI doesn't have this file.
- If something private was given to you (in a prompt, an uploaded file, a log or screenshot), use
  it only to do the work; don't copy it into the repo, a commit message or a PR. If you find
  private data already committed, stop and tell the user (it has to be removed from history too).

## Layout

| Path | What |
|---|---|
| `savings-city-<feature>.user.js` | One userscript per feature (see the table in `README.md`). |
| `savings-city-after-dark.user.js` | The loader users install: `@require`s every script from this repo's `main` branch. |
| `app/Savings City.html`, `app/Savings City_files/` | Anonymised copy of the real app (browser "Save page as" + the lazily loaded `CityCanvas-*.js`): minified JS bundles, CSS, logo, Google Fonts CSS. Reference + what the local runner serves. Never edit the bundles' code. |
| `local/server.js` | Serves `app/` with `/api/*` answered from a city JSON (in memory) and the scripts injected at document-start. |
| `local/shot.js` | Headless Chromium screenshot of the local app (Playwright). |
| `local/city.json` | Anonymous example city (the `/api/city` format, 93 projects). |
| `local/test-city.json`, `local/test-scene.js` | The small test city served at `/test` (3 buildings, 100 still people, officers, parked cars, seeded random, fixed frame step). Not a userscript. **Test here first** (see "Testing"). |
| `local/test-run.js` | One repeatable test in the test city: action, screenshots at game times, JSON report. |
| `tools/check-privacy.js` | The privacy guard (URLs, host names, e-mail addresses, city data, `.private-terms`). |
| `.githooks/pre-push` | Runs the guard before every push (enable with `git config core.hooksPath .githooks`). |
| `CONTEXT.md` | How the app works internally and how the scripts hook into it. Keep it current. |

## Conventions

- One script per feature, `savings-city-<feature>.user.js`; bump its `@version` on every change.
  Every script's `@match` stays `https://your-savings-city-host.example/*`.
- Settings are constants at the top of each script; comments in English, UI text in Dutch.
- Keep `README.md` (the script table with versions) and `CONTEXT.md` up to date.
- New shared needs (hooks, traps, borrowed classes) go into the core, not into each script.

## Updating the app files (only when a developer asks)

The app files in `app/` and the test city in `local/` are already in the repository; developing
and testing needs nothing else. Only when a developer hands you newer files from the real app (a
"Save page as" folder, files from DevTools → Network such as `index-*.js`, the lazily loaded
`CityCanvas-*.js`, `index-*.css`, `logo.webp`, or an `/api/city` dump) do you update them – by
hand, following these steps. Keep the given files outside the repository (a scratch folder, or
`incoming/`, which is git-ignored).

1. **Bundles and CSS:** copy the new `index-*.js`, `CityCanvas-*.js`, `index-*.css` (and
   `logo.webp` / `css2` if they changed) into `app/Savings City_files/` and delete the old
   bundles with the same name prefix, so there is exactly one build (the local runner takes the
   `index-*.js` / `index-*.css` it finds). Don't change their code. Search them for addresses
   (`grep -oE 'https?://[^"\x60 ]+'`): if a bundle contains the real host or another private
   address, stop and ask the developer what to do.
2. **HTML:** replace `app/Savings City.html` with the new one, then anonymise it:
   - every absolute URL to the real host (the "saved from url" comment, favicon, preloaded logos,
     …) → `https://your-savings-city-host.example/…`;
   - `./<name>_files/` paths → `./Savings City_files/` (rename the folder references if the page
     was saved under another name), and point the bundle references at the bundles in step 1;
   - the rendered page inside `<div id="root">`: real project names → made-up ones (like the test
     city's: "Snelle Exportscript"), people's names → `Bouwer A`, …, totals (hours saved, AI
     costs) and other real figures → the test city's values or made-up ones;
   - anything else that identifies the organisation or a person.
3. **City dump** → `local/city.json` (one project per line, `roads`, `revision`), per project:
   a fresh UUID for `id` (keep nothing from the real ids), a made-up `name`, `description`
   `Voorbeeldproject (geanonimiseerd).`, `authors` → `Bouwer A`, `Bouwer B`, … (the same person
   keeps the same letter), `link` → `https://example.com/` or `null`, `time_estimated_no_ai`,
   `time_spent_ai`, `budget_spent` × a random 0.7…1.3, rounded. Keep `gx`, `gy`, `facing`,
   `color`, dates, `open_for_placement` and `roads` (the city's shape).
4. Run `node tools/check-privacy.js` (with the real host and names in `.private-terms`, so it
   checks for them too) and fix whatever it finds.
5. See what changed in the app (`git diff --stat app/`; grep the new bundles for the shapes
   `CONTEXT.md` mentions, e.g. the helpers the core finds by code shape), fix the scripts that
   broke (minified names change every build; find things by shape/strings), bump their versions,
   and test with the local runner.
6. Update `CONTEXT.md` (bundle names and dates, what changed) and `README.md`, then commit.

## Testing

**Test in the test city first, then hand over to the user.** The full city is big and slow in
headless Chromium (a tall building cut into chunks takes minutes), people and cars wander off, and
every run is different – that's how sessions turn into endless test loops. The test city (`/test`)
is small, fast and the same on every run: 3 buildings (small, medium, large) in a ring road, 100
people standing still in rows, 8 officers in a row (with cops + walk mode), 6 cars parked nose to
tail, a fixed summer afternoon, seeded `Math.random`, a fixed 1/60 s frame step.

```bash
node local/server.js --port 8123 &
# one action at a known random state, screenshots at game times after it, a JSON report:
node local/test-run.js --plugins core,walk-mode,residents,cops --walk 7,1.6 --look 5,0.05,0.2 \
  --do "scResidents.blast(5, 0.2, 0.6, 2.5, 8, 0.3)" --at 0,1,3 --out /tmp/run
# or just a screenshot:
node local/shot.js 'http://localhost:8123/test?plugins=core,graphics' /tmp/test.png --wait 3000
```

Then look at the PNGs and `report.json`. Playwright comes pre-installed in most agent environments
(`NODE_PATH=$(npm root -g)` if `require('playwright')` fails); otherwise `npm install`.

How to test a change:

1. **Use the test city by default** (`local/test-run.js`, or `local/shot.js` on `/test`). Load only
   the scripts the change needs (`--plugins`). Where things stand: `local/test-scene.js` (header)
   and `CONTEXT.md` → "Testing without the real app". Need a different setup (more people, no
   officers)? Use the URL options (`--query "people=40&cops=0"`), not a new harness.
2. **Wait in game time** (`--at`, `scTest.wait(s)`, `scTest.frames(n)`), never with long wall-clock
   timeouts. Act right after `scTest.reseed()` (`test-run.js --do` does this) so the action
   starts from the same random state each run.
3. **Keep it short.** Check that the feature works and nothing throws (`[pageerror]` lines) – a
   few runs, not dozens. Don't fine-tune looks, feel or timing through endless screenshot rounds:
   that's what the user's own test is for. If you're on the third round of tweak-and-rerun for the
   same thing, stop and ask the user.
4. **Use the full city** (`/`) only for what the test city can't show: performance, highways, water,
   auto layout, many buildings. One check is enough.
5. **Then ask the user to test it for real**, in their own browser (Tampermonkey on the real app,
   or `http://localhost:8080/test` / `/` locally). Say exactly what to try and what they should
   see (e.g. "walk to the people on the north road, fire a rocket at them: 4–5 die, the rest run").
   Their report (often with screenshots) decides what's next – don't replace it with more
   automated rounds.

Repeatability: with the same seed and the same steps, the outcome of an action (who dies, who's
hit) has been the same on every run measured; exact positions afterwards matched in most runs but
not all (some per-frame randomness still depends on timing). Compare counts and events, not pixels.
The older full-city tools are still there: `local/harness.js` (fixed shots, `HARNESS_URL` can point
at `http://localhost:8123/test`) and the walk-mode tips in `CONTEXT.md`.

## Releases

Every change to a script is a release: it needs a version bump, and CI checks it on every pull
request and on every push to `main` (`.github/workflows/loader-version.yml`, `tools/check-loader-version.js`;
run it locally with `npm run check:version`). It fails when a changed `savings-city-*.user.js`
has no higher `@version`, or when the loader doesn't carry the new number. So a PR that changes a
script must:

- bump the changed scripts' own `@version`,
- bump the loader's `@version` to the new version **and** set every `?v=` on its `@require` lines
  and its console line (the one that prints the version) to the same number (that's what makes Tampermonkey fetch the scripts again),
- update `README.md` (versions in the table, new features).

Releases are commits to `main` (via the user's usual branch/PR flow); a release titled
`Release X.Y: <what changed>` is fine but not required.
