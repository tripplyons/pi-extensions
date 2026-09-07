# Repository instructions

This repository owns the Pi extensions under `extensions/`. Read `README.md`
before changing the package layout or installation workflow.

- Keep one extension per directory, with `index.ts` as its entry point.
- Keep tests beside each extension. The manifest loads entry points only.
- Keep runtime configuration, credentials, caches, and session state outside this repo.
- Preserve bundled licenses and upstream attribution.
- Use Pi's installed documentation for extension and package APIs.
- Run focused tests first, then `npm test` and `git diff --check`.
- Test package discovery when changing the manifest or moving resources.
- Commit or push only when requested. Use short imperative commit messages.
