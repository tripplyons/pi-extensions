# Sessions

Use Pi's native session commands; this package does not maintain a second history:

- `/new`: start a fresh session.
- `/resume`: choose an existing session.
- `/fork`: create a separate session from a previous user message.
- `/tree`: navigate branches within a session.
- `/name <name>`: set its display name.
- `/session`: inspect session statistics.
- `/export [path.html|path.jsonl]`: export the session.

Custom extension state follows the active branch. Navigating before a preference
change restores the earlier preference, not the newest entry on another branch.
Goals load paused after session navigation; `/goal resume` explicitly restarts
automatic continuation. Shell jobs remain owned by their original session and
are not implicitly transferred to forks.

`tests/sessions.test.ts` uses real temporary session files to verify reopening,
model and effort restoration, names, branch state, fork isolation, and new-session
reset. Interactive pickers and rendered exports require separate UI verification.
