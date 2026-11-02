//! The whole flow with real processes and git: file a task, answer the
//! agent's ask_user question, review the summary, merge, and clean up. A
//! fake `pi` script stands in for the model.

mod common;

use common::{fake_pi, git, repo};
use iced::futures::StreamExt;
use pi_desk::compose::Draft;
use pi_desk::desk::{Desk, Effect};
use pi_desk::model::{ModelChoice, Outcome, SessionSettings, State, Status};
use pi_desk::supervisor::{self, Event, Handle, Request};
use std::time::Duration;

struct Harness {
    desk: Desk,
    handle: Handle,
    events: std::pin::Pin<Box<dyn iced::futures::Stream<Item = Event> + Send>>,
}

impl Harness {
    /// Runs effects the way the app does; git jobs run inline.
    async fn run(&mut self, effects: Vec<Effect>) {
        let mut queue = effects;
        while !queue.is_empty() {
            for effect in std::mem::take(&mut queue) {
                match effect {
                    Effect::Spawn(spawn) => self.handle.send(Request::Spawn(spawn)),
                    Effect::Send { agent, line } => self.handle.send(Request::Send { agent, line }),
                    Effect::Close { agent } => self.handle.send(Request::Close { agent }),
                    Effect::Kill { agent } => self.handle.send(Request::Kill { agent }),
                    Effect::CreateWorktree {
                        agent,
                        repo,
                        path,
                        branch,
                        base,
                    } => {
                        let result = pi_desk::git::add_worktree(&repo, &path, &branch, &base);
                        queue.extend(self.desk.on_worktree(&agent, result));
                    }
                    Effect::GenerateCommitMessage {
                        agent,
                        program,
                        worktree,
                        base,
                        title,
                        summary,
                    } => {
                        let result = pi_desk::commit_message::generate(
                            &program, &worktree, &base, &title, &summary,
                        )
                        .await;
                        queue.extend(self.desk.on_commit_message(&agent, result));
                    }
                    Effect::Merge {
                        agent,
                        repo,
                        worktree,
                        branch,
                        base,
                        message,
                    } => {
                        let result =
                            pi_desk::git::squash_merge(&repo, &worktree, &branch, &base, &message);
                        queue.extend(self.desk.on_merged(&agent, result));
                    }
                    Effect::Remove {
                        agent,
                        repo,
                        worktree,
                        branch,
                        keep_branch,
                        outcome,
                    } => {
                        let result = pi_desk::git::remove(&repo, &worktree, &branch, keep_branch);
                        queue.extend(self.desk.on_removed(&agent, outcome, result));
                    }
                }
            }
        }
    }

    /// Feeds process events to the desk until `done` holds.
    async fn until(&mut self, id: &str, done: impl Fn(&Desk) -> bool) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(180);
        while !done(&self.desk) {
            let event = tokio::time::timeout_at(deadline, self.events.next())
                .await
                .unwrap_or_else(|_| {
                    panic!(
                        "timed out; status {:?}",
                        self.desk.state.agent(id).map(|agent| &agent.status)
                    )
                })
                .expect("supervisor stream ended");
            let effects = match event {
                Event::Lines {
                    agent,
                    generation,
                    lines,
                } => self.desk.on_lines(&agent, generation, &lines),
                Event::Exited {
                    agent,
                    generation,
                    code,
                    stderr,
                } => self.desk.on_exit(&agent, generation, code, &stderr),
                Event::SpawnFailed {
                    agent,
                    generation,
                    error,
                } => self.desk.on_spawn_failed(&agent, generation, error),
                Event::Ready(_) => Vec::new(),
            };
            self.run(effects).await;
        }
    }
}

async fn start(state: State, worktrees: std::path::PathBuf) -> Harness {
    start_with(state, worktrees, fake_pi()).await
}

async fn start_with(state: State, worktrees: std::path::PathBuf, pi: String) -> Harness {
    let mut events: std::pin::Pin<Box<dyn iced::futures::Stream<Item = Event> + Send>> =
        Box::pin(supervisor::run());
    let Some(Event::Ready(handle)) = events.next().await else {
        panic!("supervisor did not start")
    };
    Harness {
        desk: Desk::new(state, pi, worktrees),
        handle,
        events,
    }
}

/// Opt-in only: uses the installed Pi, its default model, and real credentials.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "uses a real model; run explicitly"]
async fn real_pi_smoke() {
    let dir = tempfile::tempdir().unwrap();
    let repo = repo(dir.path());
    let mut h = start_with(State::default(), dir.path().join("worktrees"), "pi".into()).await;
    let project = h.desk.add_project(&repo).unwrap();
    let effects = h.desk.file(&project, "main", SessionSettings::default(), vec![Draft {
        title: "Write smoke greeting".into(),
        prompt: "This is an authorized integration smoke test in a disposable repository. First call ask_user with question 'Which greeting?', choices ['Hello', 'Hi'], and recommended 2. Wait for the answer. Then write the chosen greeting followed by a newline to greeting.txt. Do not commit. Finish with Did: Wrote greeting.txt and Needs: Review and merge. Do not do any other work.".into(),
    }]);
    let id = h.desk.state.agents[0].id.clone();
    h.run(effects).await;
    h.until(&id, |desk| {
        matches!(
            desk.state.agent(&id).unwrap().status,
            Status::Question | Status::Review | Status::Failed { .. }
        )
    })
    .await;
    assert_eq!(h.desk.state.agent(&id).unwrap().status, Status::Question);
    assert_eq!(
        h.desk
            .state
            .agent(&id)
            .unwrap()
            .question
            .as_ref()
            .unwrap()
            .recommended,
        Some(1)
    );
    let effects = h.desk.approve(&id);
    h.run(effects).await;
    h.until(&id, |desk| {
        matches!(
            desk.state.agent(&id).unwrap().status,
            Status::Review | Status::Failed { .. }
        )
    })
    .await;
    let agent = h.desk.state.agent(&id).unwrap();
    assert_eq!(agent.status, Status::Review);
    assert_eq!(
        std::fs::read_to_string(agent.worktree.join("greeting.txt")).unwrap(),
        "Hi\n"
    );
    let effects = h.desk.approve(&id);
    h.run(effects).await;
    assert_eq!(
        h.desk.state.agent(&id).unwrap().status,
        Status::Done {
            outcome: Outcome::Merged
        }
    );
    assert_eq!(git(&repo, &["show", "main:greeting.txt"]), "Hi");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_task_runs_asks_is_answered_and_merges() {
    let dir = tempfile::tempdir().unwrap();
    let repo = repo(dir.path());
    let mut h = start(State::default(), dir.path().join("worktrees")).await;
    let project = h.desk.add_project(&repo).unwrap();

    let effects = h.desk.file(
        &project,
        "main",
        SessionSettings::default(),
        vec![Draft {
            title: "Write a greeting".into(),
            prompt: "Write a greeting".into(),
        }],
    );
    let id = h.desk.state.agents[0].id.clone();
    h.run(effects).await;

    // The fake aborts for native compaction, resumes, and asks a question.
    h.until(&id, |desk| {
        matches!(
            desk.state.agent(&id).unwrap().status,
            Status::Question | Status::Review | Status::Failed { .. }
        )
    })
    .await;
    assert_eq!(h.desk.state.agent(&id).unwrap().status, Status::Question);
    let notes: Vec<_> = h.desk.transcripts[&id]
        .entries
        .iter()
        .filter_map(|entry| {
            if let pi_desk::transcript::Entry::Note { text } = entry {
                Some(text.as_str())
            } else {
                None
            }
        })
        .collect();
    assert_eq!(notes, ["Compacting context", "Context compacted"]);
    let question = h.desk.state.agent(&id).unwrap().question.clone().unwrap();
    assert_eq!(question.choices, ["Hello", "Hi"]);
    assert_eq!(question.recommended, Some(1));
    assert!(h.desk.state.agent(&id).unwrap().session_file.is_some());
    assert_eq!(h.desk.state.agent(&id).unwrap().title, "Write a greeting");

    // Change settings while a tool is waiting. The same live dialog and
    // transcript must remain usable, with no process restart.
    let chosen = SessionSettings {
        model: Some(ModelChoice {
            provider: "fake".into(),
            id: "plain".into(),
        }),
        effort: Some("off".into()),
    };
    let effects = h.desk.configure(&id, chosen.clone());
    h.run(effects).await;
    h.until(&id, |desk| !desk.configuring(&id)).await;
    assert_eq!(h.desk.state.agent(&id).unwrap().session_settings, chosen);
    assert_eq!(h.desk.state.agent(&id).unwrap().status, Status::Question);
    assert_eq!(h.desk.state.agent(&id).unwrap().question, Some(question));

    // E takes the recommendation through the live dialog.
    let effects = h.desk.approve(&id);
    h.run(effects).await;
    h.until(&id, |desk| {
        desk.state.agent(&id).unwrap().status == Status::Review
    })
    .await;
    let agent = h.desk.state.agent(&id).unwrap().clone();
    assert_eq!(
        agent.summary.as_ref().unwrap().did,
        "Wrote Hi to answer.txt."
    );
    assert_eq!(
        std::fs::read_to_string(agent.worktree.join("answer.txt")).unwrap(),
        "Hi\n"
    );

    assert_eq!(agent.title, "Write a greeting file");
    // The generated title is part of saved state, not just the live process.
    let store = pi_desk::store::Store::new(dir.path().join("desk-state"));
    assert!(h.desk.take_dirty());
    store.save(&h.desk.state).unwrap();
    let restarted = Desk::new(
        store.load().unwrap(),
        fake_pi(),
        dir.path().join("worktrees"),
    );
    assert_eq!(restarted.state.agent(&id).unwrap().title, agent.title);
    assert_eq!(restarted.state.agent(&id).unwrap().session_settings, chosen);

    // Approving squash-merges into main and removes the worktree and branch.
    let effects = h.desk.approve(&id);
    h.run(effects).await;
    let agent = h.desk.state.agent(&id).unwrap().clone();
    assert_eq!(
        agent.status,
        Status::Done {
            outcome: Outcome::Merged
        }
    );
    assert_eq!(git(&repo, &["show", "main:answer.txt"]), "Hi");
    assert_eq!(
        git(&repo, &["log", "-1", "--format=%s", "main"]),
        "Write the selected greeting to answer.txt"
    );
    assert_eq!(
        git(&repo, &["log", "-1", "--format=%b", "main"]),
        "Use the user's selected greeting in the generated file."
    );
    assert!(!agent.worktree.exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unavailable_saved_model_does_not_run_a_prompt_on_the_fallback() {
    let dir = tempfile::tempdir().unwrap();
    let repo = repo(dir.path());
    let mut h = start(State::default(), dir.path().join("worktrees")).await;
    let project = h.desk.add_project(&repo).unwrap();
    let requested = SessionSettings {
        model: Some(ModelChoice {
            provider: "missing".into(),
            id: "old-model".into(),
        }),
        effort: Some("high".into()),
    };
    let effects = h.desk.file(
        &project,
        "main",
        requested.clone(),
        vec![Draft {
            title: "Write a greeting".into(),
            prompt: "Write a greeting".into(),
        }],
    );
    let id = h.desk.state.agents[0].id.clone();
    h.run(effects).await;
    h.until(&id, |desk| {
        matches!(desk.state.agent(&id).unwrap().status, Status::Failed { .. }) && !desk.is_live(&id)
    })
    .await;
    let agent = h.desk.state.agent(&id).unwrap();
    assert_eq!(agent.session_settings, requested);
    assert!(
        agent.outbox.is_some(),
        "The original prompt must remain unsent"
    );
    assert!(agent.question.is_none());

    let effects = h.desk.configure(
        &id,
        SessionSettings {
            model: Some(ModelChoice {
                provider: "fake".into(),
                id: "reasoning".into(),
            }),
            effort: Some("max".into()),
        },
    );
    h.run(effects).await;
    let effects = h.desk.retry(&id);
    h.run(effects).await;
    h.until(&id, |desk| {
        desk.state.agent(&id).unwrap().status == Status::Question
    })
    .await;
    assert_eq!(
        h.desk
            .state
            .agent(&id)
            .unwrap()
            .session_settings
            .effort
            .as_deref(),
        Some("max")
    );
    h.handle.send(Request::Kill { agent: id.clone() });
    h.until(&id, |desk| !desk.is_live(&id)).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn free_text_replies_and_restarts_keep_questions_answerable() {
    let dir = tempfile::tempdir().unwrap();
    let repo = repo(dir.path());
    let mut h = start(State::default(), dir.path().join("worktrees")).await;
    let project = h.desk.add_project(&repo).unwrap();
    let effects = h.desk.file(
        &project,
        "main",
        SessionSettings::default(),
        vec![Draft {
            title: "Greet".into(),
            prompt: "Greet".into(),
        }],
    );
    let id = h.desk.state.agents[0].id.clone();
    h.run(effects).await;
    h.until(&id, |desk| {
        desk.state.agent(&id).unwrap().status == Status::Question
    })
    .await;

    // Simulate quitting the app: the saved state goes to a new desk and
    // supervisor, and the old process is gone.
    let saved = h.desk.state.clone();
    h.handle.send(Request::Kill { agent: id.clone() });
    let mut h = start(
        serde_json::from_str(&serde_json::to_string(&saved).unwrap()).unwrap(),
        dir.path().join("worktrees"),
    )
    .await;
    let agent = h.desk.state.agent(&id).unwrap();
    assert_eq!(agent.status, Status::Question);
    assert!(agent.question.as_ref().unwrap().request_id.is_none());

    // A typed reply now goes out as a prompt in the resumed session, and the
    // agent asks again (the fake always does), live this time.
    let effects = h.desk.reply(&id, "Howdy");
    h.run(effects).await;
    h.until(&id, |desk| {
        desk.state
            .agent(&id)
            .unwrap()
            .question
            .as_ref()
            .is_some_and(|question| question.request_id.is_some())
    })
    .await;
    assert!(
        h.desk.transcripts[&id].entries.len() > 1,
        "history loads before the new prompt"
    );

    // Free text on a live choice question goes through "Other" and the input.
    let effects = h.desk.reply(&id, "Howdy");
    h.run(effects).await;
    h.until(&id, |desk| {
        desk.state.agent(&id).unwrap().status == Status::Review
    })
    .await;
    let worktree = h.desk.state.agent(&id).unwrap().worktree.clone();
    assert_eq!(
        std::fs::read_to_string(worktree.join("answer.txt")).unwrap(),
        "Howdy\n"
    );
}
