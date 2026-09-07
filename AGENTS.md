# Repository instructions

This repository owns the Pi extensions under `extensions/`. Read `README.md`
before changing the package layout or installation workflow.

- Keep one extension per directory, with `index.ts` as its entry point.
- Keep tests beside each extension. The manifest loads entry points only.
- When adding, removing, or changing an extension's user-facing behavior, update
  the root `README.md` extension count and table as needed. Keep entries brief.
  Do not add large per-extension sections to the root README; put configuration,
  examples, and detailed behavior in the extension's README.
- Keep runtime configuration, credentials, caches, and session state outside this repo.
- Preserve bundled licenses and upstream attribution.
- Use Pi's installed documentation for extension and package APIs.
- Run focused tests first, then `npm test` and `git diff --check`.
- Test package discovery when changing the manifest or moving resources.
- Commit or push only when requested. Use short imperative commit messages.
