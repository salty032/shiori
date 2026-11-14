# Development setup

[日本語](SETUP.md) ・ **English**

## Prerequisites

- Node.js (LTS) is required. If it isn't installed:
  ```
  winget install OpenJS.NodeJS.LTS
  ```
  After installing, **reopen your terminal** so the PATH change takes effect.

- If `npm` won't run in PowerShell, change the execution policy:
  ```powershell
  Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
  ```

## Install

```
cd app
npm install
```

`postinstall` runs the following automatically:

1. `scripts/fetch-ffmpeg.mjs` fetches `app/resources/ffmpeg.exe` (an LGPL build, about 92 MB).
   It isn't kept in the repository, so this fetch always runs right after a clone (the first
   run takes a few minutes). It's skipped if the correct binary is already present.
2. `electron-rebuild` builds the native `better-sqlite3` and `onnxruntime-node` modules for
   Electron (this takes a few minutes).

### Re-fetch ffmpeg only

```
cd app
npm run fetch-ffmpeg          # fetch only if missing
node scripts/fetch-ffmpeg.mjs --force   # force a re-fetch
```

The URL and SHA256 are pinned inside the script. **Do not swap in a GPL build** — Shiori
itself is under a proprietary license, so bundling GPL ffmpeg would create a license conflict
(see NOTICE.md for details).

## Run

Double-click `dev.bat` in the repository root, or:

```
cd app
npm run dev
```

## Type checking

```
cd app
npm run typecheck
```

`extension/` is plain JavaScript that never goes through a bundler, so it is outside the type
checker. Its syntax, and the existence of every file the manifest points at, are checked by
`extension-integrity.test.ts` as part of `npm test` — you do not need to run `node --check` on
each file yourself. For a more thorough pass, use `npm run ext:lint` (web-ext fetches from the
network, so it is not part of `verify`; run it once before a release if you changed the extension).

## Tests

```
cd app
npm test
```

Most tests run in a Node environment (the default in `vitest.config.ts`), but hooks that
touch the DOM (such as `useSelection.test.ts`) select the jsdom environment individually via
a `// @vitest-environment jsdom` comment at the top of the file. `jsdom` and
`@testing-library/react` are in devDependencies, so no setup beyond `npm install` is needed.

Run type checking and tests together:

```
cd app
npm run verify
```

## Known setup issues

| Symptom | Cause | Fix |
|---|---|---|
| Electron crashes on launch with `electron.app` undefined | `ELECTRON_RUN_AS_NODE=1` is set in your environment | `dev.bat` clears the variable before launching. If you run `npm run dev` directly, first run `Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue` |
| Error that the Electron binary can't be found | Right after a clone, `npm install` hasn't run yet, so the binary isn't downloaded | Run `npm install` (or re-fetch just the binary with `node node_modules/electron/install.js`) |
