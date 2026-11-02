# pi-desk

A Rust/iced desktop inbox for parallel Pi coding agents. Each task runs in its
own git worktree. Questions and completed work enter your Inbox; answer, review
the diff, and merge without switching terminals. Panels, controls, selections,
and dark primary buttons use neutral grays. Muted status dots, errors, red/green diffs,
and subdued syntax colors keep semantic cues visible. Scrollbar tracks are
transparent so panel backgrounds stay unchanged; only the thumb is colored,
with the usual hover and drag feedback.

Inspired by [Agentbox](https://github.com/savannahfeder/agentbox). No Agentbox
code or assets are included.

## Run

Requires a current stable Rust toolchain (edition 2024), Git 2.38 or newer
(`merge-tree --write-tree`), and Pi 1.4.0 or newer on PATH. Install this repo's
Pi extensions and sign in to your chosen provider first:

```sh
pi install /absolute/path/to/pi-extensions
cargo run --manifest-path pi-desk/Cargo.toml --release
```

New tasks start with Pi's configured default model and effort. Model and Effort
selectors in New task and the task detail card let you override them per task.
Model choices come from Pi's configured/authenticated models. Effort lists only
the thinking levels Pi supports for that model, including "off" for models
without reasoning and "xhigh" or "max" where supported. Switching models lets Pi
normalize an unsupported effort level.

Each task saves its own model and effort and restores them when resumed. New
tasks do not inherit the last task's selection. Changes during a run apply to
the next model request, including after tools, without aborting, restarting,
or discarding progress. An in-flight model request continues with its original
settings. Selection errors appear on the card and do not fail the task. Refresh
models reloads Pi's configuration; an unavailable saved model stays selected
until you choose an available replacement. Before sending a startup or resume
prompt, pi-desk checks that Pi selected the saved model. A fallback stops the
task with a retryable error instead of running on a different model.

Pi-desk uses Pi's credentials, settings, and installed extensions. It loads
selector options with a short-lived `pi --mode rpc --no-session` process that
makes no model requests. There is no separate agent daemon. Each active agent
is a `pi --mode rpc --session-id <id>` child process. The app sets
`PI_ASK_USER_TIMEOUT=0` so its questions have no deadline. The ask-user extension
must include this repo's timeout and recommendation changes.

Task titles start with the first line of the submitted task. pi-desk reads the
Pi session name at agent startup and after each completed run, and saves it as
the task title when available. This repo's auto-rename extension generates a
short name after the first turn, using GPT 6 Luna with OpenAI authentication.
It does not replace an existing Pi session name. If naming is unavailable or
fails, pi-desk keeps the current task title. No separate naming call is made by
pi-desk; branch names and task prompts do not change.

Agents have the same local permissions as Pi in your terminal. Worktrees isolate
git changes, not processes, secrets, networking, or files outside the worktree.
Only run tasks and extensions you trust. Run one pi-desk instance per state
directory; concurrent writers are not supported.

## Build and install a macOS app

On macOS, run from the repository root:

```sh
./pi-desk/scripts/build-macos-app.sh --install
```

This builds a native release binary for the current Mac, packages and verifies
`pi-desk/target/macos/pi-desk.app`, and installs it as
`/Applications/pi-desk.app`. Open it from Finder or Spotlight. Quit any other
pi-desk instance first, since concurrent writers to the same state directory are
not supported. Pi, Git, credentials, and this repo's extensions are still required;
they are not bundled. Finder launches use the usual local tool directories on PATH.

The script requires Rust and Apple's command-line tools. It uses built-in macOS
packaging tools, with no extra Cargo packaging dependency. To build without
installing, omit `--install`. To install without access to `/Applications`, use
`--install-dir "$HOME/Applications"`, or copy the built app with Finder.
The script does not run `sudo`, launch the app, or stop running processes.

Run the same command to update. Before replacement, the script checks that the
destination has pi-desk's bundle identifier and is not a symlink. It refuses to
replace unrelated files or apps, and asks you to quit pi-desk before replacing
an existing installation. It verifies the new bundle before replacement and
keeps the old bundle until the replacement is in place.

The app uses an ad-hoc signature for local use, not a Developer ID signature or
Apple notarization. It has the standard macOS application icon and is built for
this Mac's architecture, not as a universal binary. Application state and
worktrees remain outside the bundle in the existing state directory; updating
the app does not reset them.

## Flow

1. Click **+** beside Projects and choose a git repository. Check out the branch
   that new tasks should merge into, and configure git author identity first.
2. Open **New task** with the regular outlined sidebar button or N. Plain text
   creates one task; a list creates one task per
   item, with a preview before filing. Submit with Cmd+Enter. Tasks use the
   project's current branch as their base. Model and effort apply to every task
   in the submitted list; each task can be changed independently afterward.
3. Four agents run at once by default. Settings lets you change the slot limit.
   Scheduling uses project order, then replies before new work, then oldest
   queued task first. Display order does not change scheduling. Priority is not
   used; older saved tasks still load, but their old priority values are ignored.
   Reorder projects by dragging or with Alt+Up/Down in a project view.
4. Questions enter Inbox with choices, an optional recommendation, and a typed
   reply. Agents are asked to end with `Did:` and `Needs:` lines for review cards.
5. Inspect the live Transcript or the highlighted Diff, including untracked
   files. Thinking blocks in live and saved transcripts default to a single
   collapsed row labeled "Thinking" with a truncated preview. Click a row to
   show or hide its full text; streaming updates do not expand it automatically.
   Context compaction adds transcript notes and keeps the task Working through
   the interruption and continuation. Pi-desk confirms Pi is idle before moving
   a task to review or reporting an abort. Use the command palette to open the
   worktree in a terminal or editor.
6. Approve a review to ask Pi for a specific commit message, then commit remaining
   changes, squash-merge locally into the base branch, and remove the worktree and
   branch. Nothing is pushed. Merge conflicts return the task to Pi with
   instructions to rebase and resolve them.

Before merging, pi-desk makes a separate `pi --print --no-session` request with
no tools or MCP access. It sends the task title, completed-work summary, and final
diff, including committed, uncommitted, and untracked changes. For large diffs,
it sends the first 120,000 bytes plus the full changed-file list and marks the
truncation. Pi uses its configured default model and credentials; installed
extensions remain loaded for provider and authentication behavior. Context files,
skills, and prompt templates are disabled for this request. The task's session
is not resumed or changed. The returned subject and optional body become both
the remaining-work commit message and the final squash commit message. If the
request fails, times out after two minutes, or returns an empty or invalid message,
the task stays in Review with an error. No Git changes are made by that request;
approve again to retry. Tasks with no changes need no model request or merge.

The main window has a sidebar, task list, and detail pane. All tasks shows every
project and status, including Later and Done. Board mode groups work by status.
Lists and board columns group tasks as Needs you, Working, Queued, Later, and
Done. Within each group, the most recent activity comes first, regardless of
project. Row ages use that same activity time. Creation time (newest
first) and then task ID break ties. Each view keeps its existing filters; project
lists omit Done tasks. Heading labels and counts
share one text baseline in both layouts. List and board previews slide upward over
180 ms when their text changes, with smooth height changes for wrapped text and
the review's Needs line. Rapid streaming updates are combined into the latest
pending preview rather than queued. The full Transcript and detail card do not
animate.
Use Hide sidebar / Show sidebar in the list or board header to toggle navigation
without hiding the task list. These actions are also in the command palette.
Focus mode hides the sidebar and list. Task summaries are always shown when available. Review previews put the outcome
and next action on separate lines rather than using dot separators. Task metadata
uses separate rows so long branch names wrap without crowding status. Later snoozes a row until
its due time; the Inbox count is the only attention indicator. There are no
system notifications or dock badges.

Merge, discard, and mark-done actions have a five-second undo window. Discard
removes the worktree and branch, including uncommitted changes, after confirmation.
Mark done keeps the branch. Undo is not a way to reverse a merge after it runs.

## Keys

Single-key shortcuts apply outside text inputs. Cmd+K opens the command palette.
Zoom shortcuts also work while typing or using a dialog. On Linux and Windows,
use Ctrl instead of Cmd. Controls with existing shortcuts show key chips;
overlays also show navigation, submit, and close hints where applicable.
Controls without shortcuts have no key chip.

| Key | Action |
| --- | --- |
| J / K, Down / Up | Next / previous row |
| E | Recommended answer, merge, or retry |
| 1–8 | Choose a numbered action |
| R | Reply |
| N | New task |
| Cmd+Enter | Submit task or reply |
| L | Later |
| X | Discard, with confirmation |
| Z | Undo |
| D / T | Diff / Transcript |
| F | Focus mode |
| B | Board mode |
| S | Hide / show sidebar |
| Cmd+Plus or Cmd+= | Zoom in |
| Cmd+Minus | Zoom out |
| Cmd+0 | Reset zoom to 100% |
| Escape | Close overlay, cancel reply, or leave focus mode |

Zoom scales the whole interface in 10-percentage-point steps, from 70% to 200%.
The command palette includes Zoom in, Zoom out, and Reset zoom, and shows the
current percentage. Zoom starts at 100% on each launch and does not change the
saved state. At high zoom, hide the sidebar with S or use focus mode with F to
leave more room for task details.

## State and restart

App state and worktrees live under `~/.pi/agent/pi-desk/`, outside this repo.
`PI_CODING_AGENT_DIR` overrides `~/.pi/agent`. Pi owns session files in its usual
session directory. The app stores session IDs and paths, so working agents can
resume with their history after relaunch.

Open questions are saved, but RPC dialog handles are not. After restart, an
answer is sent as a follow-up prompt in the resumed session instead of to a
stale dialog. Agents can ask a new question if needed. Later and queued work
also survive restart. A corrupt state file produces an error and disables app
state saves for that run; it is not silently replaced with an empty file.

Settings includes terminal and editor shell command templates. `{path}` is
replaced with a shell-quoted worktree path. Defaults use Ghostty if installed,
otherwise Terminal, and `$EDITOR` (or `vi`). Templates are trusted shell commands.

`PI_DESK_PI` overrides the Pi executable, for example to test with the fake:

```sh
PI_DESK_PI="$PWD/pi-desk/tests/fake-pi" \
PI_CODING_AGENT_DIR="$(mktemp -d)" \
cargo run --manifest-path pi-desk/Cargo.toml
```

Add a disposable git repository and file a task. The fake asks a greeting
question and writes the answer to `answer.txt`, without calling a model.

## Tests

```sh
cargo test --manifest-path pi-desk/Cargo.toml
npm test
```

Tests use temporary repositories and a fake Pi process for compaction and
continuation, question, restart, reply, review, merge, conflict, and cleanup
behavior. UI tests use iced's supported `iced_test::Simulator` to inspect widgets,
click choices, and render
headless screenshots. No macOS screen-recording permission is needed. Fresh
screenshots are written under `pi-desk/target/tmp/ui/`; these are review artifacts,
not pixel-regression baselines.

The opt-in smoke test uses the installed Pi, default model, and real credentials:

```sh
cargo test --manifest-path pi-desk/Cargo.toml --test end_to_end \
  real_pi_smoke -- --ignored --nocapture
```

It runs one task in a disposable repository, answers a real `ask_user` question,
then merges and removes its worktree. It is excluded from `npm test`.

The current iced/wgpu dependency tree includes `block 0.1.6`, which emits a Rust
future-incompatibility warning on macOS. Builds and tests currently pass.
