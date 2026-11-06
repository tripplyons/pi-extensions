# pi-desk

Text origins snap to physical pixels after display and UI scaling, using the
same rule as Overseer. Both iced renderer backends use
[local patches](vendor/README.md). Interface text and Markdown share a native
sans family (San Francisco on macOS, Segoe UI on Windows, system sans on Linux).
A shared 12/13/14/16/18 px scale separates captions, controls, body text, headings,
and titles. Semibold marks hierarchy; code, paths, and key hints use monospace.
Disclosure chevrons, drag handles, and modifier and arrow keys are bundled
[Lucide](https://lucide.dev) SVG icons tinted with theme colors.
Secondary text stays readable against the neutral dark panels.

A Rust/iced desktop inbox for parallel Pi coding agents. Each task runs in the
project's own checkout, or in its own git worktree when you check Use worktree.
Questions and completed work enter your Inbox; answer, review
the diff, and merge without switching terminals. Panels, controls, selections,
and dark primary buttons use neutral grays. Errors, red/green diffs, and subdued
syntax colors keep semantic cues visible. Scrollbar tracks are
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
Model choices come from Pi's configured/authenticated models. When Pi has
scoped models (`enabledModels` in settings or `--models`, set with
`/scoped-models`), Model lists only those. Pi's RPC has no scoped-model query,
so discovery walks Pi's model cycle in its sessionless helper; this saves no
settings. A scope with only one available model cannot be listed this way, so
Model then lists every authenticated model. Effort lists only
the thinking levels Pi supports for that model, including "off" for models
without reasoning and "xhigh" or "max" where supported. Switching models lets Pi
normalize an unsupported effort level. The outlined Refresh models button sits
beside the selectors. Switching back to a task reuses its loaded options when
its saved settings have not changed. Refresh keeps the selectors visible but
unavailable until loading finishes; first load reserves the same selector area.

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

Agents have the same local permissions as Pi in your terminal. Main-checkout
tasks edit your project files directly. Worktrees isolate
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
   project's current branch as their base. Use worktree starts unchecked each
   time New task opens; Cmd+E toggles it. Unchecked tasks work in the project's checkout and
   record its HEAD commit; the task diff is everything since that commit. Check
   it to give each task its own worktree and `pi-desk/` branch. Model and effort apply to every task
   in the submitted list; each task can be changed independently afterward.
3. Four agents run at once by default. Settings lets you change the slot limit.
   Scheduling uses project order, then replies before new work, then oldest
   queued task first. Display order does not change scheduling. Priority is not
   used; older saved tasks still load, but their old priority values are ignored.
   Reorder projects by dragging or with Alt+Up/Down in a project view.
   A project's checkout holds one main-checkout task at a time, from its first
   start until it is merged, discarded, or marked done. Later main-checkout
   tasks for that project wait in Queued; worktree tasks are not affected.
4. Questions enter Inbox with choices, an optional recommendation, and a typed
   reply. Agents are asked to end with `Did:` and `Needs:` lines for review cards.
   Drop a file, such as a screenshot, onto the window to type its path into
   the open New task box or reply. With neither open, the drop starts a reply
   to the selected task. Paths with spaces are single-quoted.
5. Inspect the live Transcript or the highlighted Diff, including untracked
   files. Thinking blocks in live and saved transcripts default to a single
   collapsed row labeled "Thinking" with a truncated preview. Click a row to
   show or hide its full text; streaming updates do not expand it automatically.
   Context compaction adds transcript notes and keeps the task Working through
   the interruption and continuation. Pi-desk confirms Pi is idle before moving
   a task to review or reporting an abort. Use the command palette to open the
   task's checkout or worktree in a terminal or editor.
6. Approve a review to ask Pi for a specific commit message, then commit remaining
   changes, squash-merge locally into the base branch, and remove the worktree and
   branch. Nothing is pushed. Merge conflicts return the task to Pi with
   instructions to rebase and resolve them. For a main-checkout task, approval
   commits all changes in the checkout onto its branch, including any of your
   own uncommitted edits there. It refuses if the checkout is on another branch.
7. Reply to a Done task to reopen it. The task returns to Queued and resumes its
   Pi session with your reply. A worktree task gets its worktree back on its
   kept branch, or on a fresh branch from the base after a merge or discard. A
   main-checkout task diffs from the checkout's commit at the time of the reply.

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

The main window has a sidebar, task list, and detail pane. It opens on All tasks,
which shows every project and status, including Later and Done. Board mode groups work by status.
Lists and board columns group tasks as Needs you, Working, Queued, Later, and
Done. Within each group, the most recent activity comes first, regardless of
project. Row ages use that same activity time. Working rows show the newest
assistant text or thinking block from its start, as plain text cut to about two
lines. Creation time (newest
first) and then task ID break ties. Each view keeps its existing filters; project
lists omit Done tasks. The selected task changes only when you select another
task, move with J/K, or change views. Status changes and actions such as merge,
discard, mark done, Later, and replies keep it selected, along with focus mode.
When the selected task stops matching the view, for example when it moves from
Working to Inbox, its row stays listed until you select another task or change
views. Changing views keeps the selected task if it belongs to the new view;
otherwise the first row is selected. Focus mode ends when no task is selected,
so it does not return on its own when a new task arrives. Heading labels and counts
share one text baseline in both layouts. List and board previews slide upward over
180 ms when their text changes, with smooth height changes for wrapped text and
the review's Needs line. Rapid streaming updates are combined into the latest
pending preview rather than queued. Live assistant text in the Transcript and
working text in the focused card reveal each new visible line once, with a
6 px entrance over 180 ms. Wrapped lines enter too; tokens on existing lines
update in place without restarting the animation or queuing stale text.
Markdown formatting and links remain available. Completed history, switching
agents, and reflow from resize or zoom do not replay line entrances.
Use Hide sidebar / Show sidebar in the list or board header to toggle navigation
without hiding the task list. These actions are also in the command palette.
Focus mode hides the sidebar and list. Task summaries are always shown when available. Review previews put the outcome
and next action on separate lines rather than using dot separators. Task metadata
uses separate rows so long branch names wrap without crowding status. Later snoozes a row until
its due time; the Inbox count is the only attention indicator. There are no
system notifications or dock badges.

Merge, discard, and mark-done actions have a five-second undo window. The
selected task stays listed during the window; other views omit it. Discard
removes the worktree and branch, including uncommitted changes, after confirmation.
Mark done keeps the branch. For main-checkout tasks, discard and mark done stop
the agent and leave the checkout's files unchanged. Undo is not a way to reverse a merge after it runs.

## Keys

The New task composer supports macOS word navigation and deletion with Option,
line navigation and deletion with Cmd, Cmd+Up/Down for document navigation,
and Shift variants for selection. Clipboard shortcuts and Cmd+A select all work
as usual. Cmd+Z undoes composer edits; Cmd+Shift+Z redoes them. Cmd+E toggles Use
worktree. Cmd+Enter still files the task, and Escape closes the composer. Reply-editor shortcuts are unchanged.

Single-key shortcuts apply outside text inputs. Each letter shortcut runs the
command palette entry that shows the same key. Cmd+K opens the command palette.
Zoom shortcuts also work while typing or using a dialog. On Linux and Windows,
use Ctrl instead of Cmd. Controls with existing shortcuts show key chips;
overlays also show navigation, submit, and close hints where applicable.
Controls without shortcuts have no key chip.

| Key | Action |
| --- | --- |
| J / K, Down / Up | Next / previous row |
| E | Recommended answer, merge, or retry |
| 1–9 | Choose a numbered action |
| R | Reply, including to reopen a Done task |
| N | New task |
| Cmd+Enter | Submit task or reply |
| Cmd+E | Toggle Use worktree in New task |
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
replaced with a shell-quoted checkout or worktree path. Defaults use Ghostty if installed,
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
