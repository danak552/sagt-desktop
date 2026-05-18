# Contributing to Sagt.ai Desktop

Thank you for your interest. This is a small project maintained by a solo founder — please read this before opening issues or pull requests.

## Scope

- **Windows only** is actively maintained. The codebase is Tauri v2 (Rust + React).
- **Mac contributions** are welcome but review time is not guaranteed.
- **Linux** is not on the roadmap.

## Running locally

```bash
cd desktop
npm install
npm run tauri:dev   # Opens the app with DevTools (F12) enabled
```

You need:
- [Rust toolchain](https://rustup.rs)
- [Node.js 18+](https://nodejs.org)
- A `.env` file in `desktop/` — copy `.env.example` and fill in the values

TypeScript check before committing:
```bash
npx tsc --noEmit
```

## What I am NOT looking for

- Refactors or code style changes without a bug fix or feature attached
- New dependencies without a clear justification
- Issues that are actually support requests — use [GitHub Discussions](../../discussions) for those

## Bug reports

Use the Bug Report issue template. Include:
- App version (shown in Settings)
- Windows version
- Steps to reproduce
- What you expected vs what happened

## Pull requests

- Open an issue first for anything beyond a trivial fix
- Keep PRs small and focused on one thing
- The CI must pass (TypeScript + Tauri build)

## Note on the AI model

The `ggml-kb-whisper-small.bin` model file is **not included** in this repository. It is fetched from a private bucket during the official CI build. You can substitute any GGML-compatible Whisper model for local development.
