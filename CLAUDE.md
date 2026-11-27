@AGENTS.md

The instructions for this repository are in `AGENTS.md` (imported above) – most importantly the
**privacy rules**: this repository is public; no real web addresses of the app or its owner and no
personal data, ever. Run `node tools/check-privacy.js` before every commit.

**Testing:** test in the test city first (`node local/test-run.js …` / `http://localhost:8123/test`,
see AGENTS.md → "Testing"), keep it to a few runs, then ask the user to test it for real in their
browser, telling them exactly what to try and what they should see.
