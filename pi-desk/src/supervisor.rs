//! Runs Pi RPC child processes. The app talks to it through a [`Handle`] and
//! receives [`Event`]s from the stream that [`run`] returns.
//!
//! Each child gets its own writer, reader, and waiter tasks, so a child that
//! stops reading stdin cannot stall the others. Stdout is split only on LF,
//! as Pi's RPC framing requires. Every spawn carries a generation number, so
//! events from a replaced process can be told apart from its successor's.

use futures::channel::mpsc;
use futures::{SinkExt, Stream, StreamExt};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc as tokio_mpsc, oneshot};

const STDERR_TAIL: usize = 8 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Spawn {
    pub agent: String,
    pub generation: u64,
    pub program: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: Vec<(String, String)>,
}

#[derive(Debug)]
pub enum Request {
    Spawn(Spawn),
    Send {
        agent: String,
        line: String,
    },
    /// Closes stdin, which asks Pi for an orderly shutdown.
    Close {
        agent: String,
    },
    Kill {
        agent: String,
    },
}

#[derive(Debug, Clone)]
pub enum Event {
    Ready(Handle),
    Lines {
        agent: String,
        generation: u64,
        lines: Vec<String>,
    },
    Exited {
        agent: String,
        generation: u64,
        code: Option<i32>,
        stderr: String,
    },
    SpawnFailed {
        agent: String,
        generation: u64,
        error: String,
    },
}

#[derive(Clone)]
pub struct Handle(mpsc::UnboundedSender<Request>);

impl std::fmt::Debug for Handle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("supervisor::Handle")
    }
}

impl Handle {
    pub fn send(&self, request: Request) {
        let _ = self.0.unbounded_send(request);
    }
}

struct Child {
    stdin: Option<tokio_mpsc::UnboundedSender<String>>,
    kill: Option<oneshot::Sender<()>>,
}

/// Starts the supervisor on the current tokio runtime. The first event is
/// [`Event::Ready`] with the handle that accepts requests.
pub fn run() -> impl Stream<Item = Event> {
    let (output, events) = mpsc::channel(256);
    tokio::spawn(supervise(output));
    events
}

async fn supervise(mut output: mpsc::Sender<Event>) {
    {
        let (sender, mut requests) = mpsc::unbounded();
        let _ = output.send(Event::Ready(Handle(sender))).await;
        let mut children: HashMap<String, Child> = HashMap::new();
        while let Some(request) = requests.next().await {
            match request {
                Request::Spawn(spec) => {
                    if let Some(old) = children.remove(&spec.agent) {
                        if let Some(kill) = old.kill {
                            let _ = kill.send(());
                        }
                    }
                    let agent = spec.agent.clone();
                    let generation = spec.generation;
                    match start(spec, output.clone()) {
                        Ok(child) => {
                            children.insert(agent, child);
                        }
                        Err(error) => {
                            let _ = output
                                .send(Event::SpawnFailed {
                                    agent,
                                    generation,
                                    error,
                                })
                                .await;
                        }
                    }
                }
                Request::Send { agent, line } => {
                    if let Some(stdin) = children.get(&agent).and_then(|child| child.stdin.as_ref())
                    {
                        let _ = stdin.send(line);
                    }
                }
                Request::Close { agent } => {
                    if let Some(child) = children.get_mut(&agent) {
                        child.stdin = None;
                    }
                }
                Request::Kill { agent } => {
                    if let Some(kill) = children.remove(&agent).and_then(|child| child.kill) {
                        let _ = kill.send(());
                    }
                }
            }
        }
    }
}

fn start(spec: Spawn, output: mpsc::Sender<Event>) -> Result<Child, String> {
    let mut command = tokio::process::Command::new(&spec.program);
    command
        .args(&spec.args)
        .current_dir(&spec.cwd)
        .envs(spec.env.iter().map(|(key, value)| (key, value)))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut process = command
        .spawn()
        .map_err(|error| format!("Could not start {}: {error}", spec.program))?;
    let mut stdin = process.stdin.take().ok_or("child has no stdin")?;
    let mut stdout = process.stdout.take().ok_or("child has no stdout")?;
    let mut stderr = process.stderr.take().ok_or("child has no stderr")?;

    let (line_sender, mut lines) = tokio_mpsc::unbounded_channel::<String>();
    tokio::spawn(async move {
        while let Some(line) = lines.recv().await {
            if stdin.write_all(line.as_bytes()).await.is_err() || stdin.flush().await.is_err() {
                break;
            }
        }
        // Dropping stdin here is the orderly shutdown request.
    });

    let agent = spec.agent.clone();
    let generation = spec.generation;
    let mut reader_output = output.clone();
    let reader = tokio::spawn(async move {
        let mut pending: Vec<u8> = Vec::new();
        let mut chunk = vec![0u8; 64 * 1024];
        loop {
            let read = match stdout.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(read) => read,
            };
            pending.extend_from_slice(&chunk[..read]);
            let mut batch = Vec::new();
            while let Some(end) = pending.iter().position(|byte| *byte == b'\n') {
                let line: Vec<u8> = pending.drain(..=end).collect();
                let line = String::from_utf8_lossy(&line[..line.len() - 1])
                    .trim_end_matches('\r')
                    .to_string();
                if !line.is_empty() {
                    batch.push(line);
                }
            }
            if !batch.is_empty()
                && reader_output
                    .send(Event::Lines {
                        agent: agent.clone(),
                        generation,
                        lines: batch,
                    })
                    .await
                    .is_err()
            {
                break;
            }
        }
        if !pending.is_empty() {
            let line = String::from_utf8_lossy(&pending).to_string();
            let _ = reader_output
                .send(Event::Lines {
                    agent: agent.clone(),
                    generation,
                    lines: vec![line],
                })
                .await;
        }
    });

    let errors = tokio::spawn(async move {
        let mut tail: Vec<u8> = Vec::new();
        let mut chunk = [0u8; 4096];
        while let Ok(read) = stderr.read(&mut chunk).await {
            if read == 0 {
                break;
            }
            tail.extend_from_slice(&chunk[..read]);
            if tail.len() > STDERR_TAIL {
                tail.drain(..tail.len() - STDERR_TAIL);
            }
        }
        String::from_utf8_lossy(&tail).trim().to_string()
    });

    let (kill, killed) = oneshot::channel::<()>();
    let agent = spec.agent;
    let mut waiter_output = output;
    tokio::spawn(async move {
        let status = tokio::select! {
            status = process.wait() => status.ok(),
            _ = killed => {
                let _ = process.kill().await;
                process.wait().await.ok()
            }
        };
        // Deliver every stdout line before reporting the exit.
        let _ = reader.await;
        let stderr = errors.await.unwrap_or_default();
        let code = status.and_then(|status| status.code());
        let _ = waiter_output
            .send(Event::Exited {
                agent,
                generation,
                code,
                stderr,
            })
            .await;
    });

    Ok(Child {
        stdin: Some(line_sender),
        kill: Some(kill),
    })
}
