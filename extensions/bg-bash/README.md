# Background bash

Restored from this repository's main branch. Requires tmux and zsh.

- `bash` runs zsh commands. Commands exceeding the foreground grace period continue as persistent tmux jobs.
- `bg_process` lists, reads, writes to, kills, or clears jobs. Operations default to the current Pi session; foreign jobs require explicit `scope: "all"`.
- `sleep` wakes on current-session shell exits, subagent or mixture completion, user steering, or swarm activity. It is not a guaranteed fixed delay. Cancellation and session shutdown cancel pending sleeps.

Job metadata and output live under `${XDG_CACHE_HOME:-~/.cache}/pi/bg-bash`, outside the repository. Reopening a Pi session restores access to its jobs. Shutting down Pi does not kill persistent jobs.

`PI_BG_BASH_TMUX_SOCKET` selects a private socket. Its parent directory must exist. Swarm and mixture set this to `bg.sock` under each worker's temporary directory. Relative socket access avoids macOS socket-path length limits. Without this setting, bg-bash uses tmux's default socket.

Each new shell receives current environment values rather than relying only on the persistent tmux server's initial environment. Worker cache paths stay in worker temporary storage. Detached jobs can outlive process-group stop or timeout; stop or clear only jobs you own.

Run `bun test extensions/bg-bash/index.test.ts`. Tests use a private tmux server, including a long socket-directory path, and clean up only their own server and files.
