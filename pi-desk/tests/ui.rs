//! Headless UI tests with Rune's runtime. They check what the window shows
//! and what clicks and keys do. Snapshots are written to Cargo's test
//! temporary directory for visual review; they are not compared.

mod common;

use pi_desk::app::{App, Message, Overlay, View};
use pi_desk::icon::KeyPart;
use pi_desk::model::*;
use pi_desk::store::Store;
use rune::{ElementInfo, Env, Key, KeyEvent, Mods, Runtime};
use std::path::PathBuf;

const SIZE: (f32, f32) = (1440.0, 900.0);
/// Snapshots render at Retina scale for review.
const SCALE: f32 = 2.0;

/// The app inside a headless Rune window. Derefs to the app, so tests read
/// and change state directly, then render to check what the window shows.
struct Desk {
    rt: Runtime<App>,
}

impl std::ops::Deref for Desk {
    type Target = App;
    fn deref(&self) -> &App {
        &self.rt.state
    }
}

impl std::ops::DerefMut for Desk {
    fn deref_mut(&mut self) -> &mut App {
        &mut self.rt.state
    }
}

impl Desk {
    fn new(app: App) -> Desk {
        let mut rt = Runtime::new(app, pi_desk::views::root, SIZE, Env::new(true, SCALE));
        rt.on_key = Some(pi_desk::app::window_key);
        let mut desk = Desk { rt };
        desk.render();
        desk
    }

    fn resize(&mut self, size: (f32, f32)) {
        self.rt.set_viewport(size, SCALE);
        self.render();
    }

    /// Lays out the current state with every animation landed.
    fn render(&mut self) {
        self.rt.invalidate();
        self.rt.frame(0.0);
        self.rt.settle_all();
        self.rt.frame(1.0);
        // The viewport is read in the first layout; zoom needs a second.
        self.rt.invalidate();
        self.rt.frame(1.0);
        self.rt.settle_all();
        self.rt.frame(1.0);
    }

    fn elements(&mut self) -> Vec<ElementInfo> {
        self.render();
        self.rt.elements()
    }

    /// The shown element whose text is `text`, else whose label is.
    fn find(&mut self, text: &str) -> Option<ElementInfo> {
        let (w, h) = self.rt.viewport;
        let shown: Vec<ElementInfo> = self
            .elements()
            .into_iter()
            .filter(|element| {
                let [x, y, width, height] = element.rect;
                !element.exiting
                    && element.opacity > 0.0
                    && width > 0.0
                    && height > 0.0
                    && x < w
                    && y < h
                    && x + width > 0.0
                    && y + height > 0.0
            })
            .collect();
        let by_text = shown
            .iter()
            .find(|element| element.text.as_deref() == Some(text));
        by_text
            .or_else(|| {
                shown.iter().find(|element| {
                    element.text.is_none() && element.label.as_deref() == Some(text)
                })
            })
            .cloned()
    }

    fn shows(&mut self, text: &str) -> bool {
        self.find(text).is_some()
    }

    /// The window rect `[x, y, w, h]` of the shown element with this text.
    fn bounds(&mut self, text: &str) -> [f32; 4] {
        self.find(text)
            .unwrap_or_else(|| panic!("{text:?} is not shown"))
            .rect
    }

    /// The window rect of the element with this key or key path.
    fn keyed(&mut self, key: &str) -> Option<[f32; 4]> {
        self.render();
        self.rt.presented(key).map(|(rect, _)| rect)
    }

    /// Clicks the middle of the shown element with this text.
    fn click(&mut self, text: &str) {
        let [x, y, w, h] = self.bounds(text);
        let (x, y) = (x + w / 2.0, y + h / 2.0);
        let before = format!("{:?}", self.debug_state());
        self.rt.pointer_move(x, y);
        self.rt.pointer_down(x, y);
        self.rt.pointer_up(x, y);
        self.rt.frame(0.0);
        assert_ne!(
            before,
            format!("{:?}", self.debug_state()),
            "clicking {text:?} did nothing"
        );
    }

    fn debug_state(&self) -> String {
        format!(
            "{:?} {:?} {:?} {} {} {} {:?} {:?} {:?} {:?} {}",
            self.view,
            self.selected,
            self.overlay.as_ref().map(std::mem::discriminant),
            self.focus,
            self.show_sidebar,
            self.replying,
            self.expanded_thinking,
            self.expanded,
            self.menu,
            self.pending.len(),
            self.desk.state.agents.iter().map(|agent| format!("{:?}{:?}", agent.status, agent.question)).collect::<String>()
                + &format!("{:?}", match &self.overlay {
                    Some(Overlay::Composer(composer)) => Some(composer.use_worktree),
                    _ => None,
                }),
        )
    }

    /// A key at the window, as though nothing had focus.
    fn key(&mut self, name: &str) {
        self.press(name, Mods::default(), false);
    }

    fn press(&mut self, name: &str, mods: Mods, captured: bool) {
        let event = key_event(name, mods);
        if let Some(task) = self.rt.state.on_key(&event, captured) {
            self.rt.state.start(task);
        }
    }

    /// Runs started work until no future is left, delivering its messages.
    async fn settle(&mut self) {
        loop {
            while let Some(message) = self.inbox.try_recv() {
                self.send(message);
            }
            if !self.inbox.busy() {
                if let Some(message) = self.inbox.try_recv() {
                    self.send(message);
                    continue;
                }
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    }

    async fn finish(&mut self, task: pi_desk::task::Task) {
        self.start(task);
        self.settle().await;
    }

    fn snapshot(&mut self, name: &str) {
        self.render();
        let (w, h) = self.rt.viewport;
        let size = ((w * SCALE) as u32, (h * SCALE) as u32);
        let pixels = render_rt(&mut self.rt, size);
        let directory = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("ui");
        std::fs::create_dir_all(&directory).unwrap();
        let file = std::fs::File::create(directory.join(format!("{name}.png"))).unwrap();
        let mut encoder = png::Encoder::new(std::io::BufWriter::new(file), size.0, size.1);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder
            .write_header()
            .unwrap()
            .write_image_data(&pixels)
            .unwrap();
    }

    fn snapshot_size(&mut self, name: &str, size: (f32, f32)) {
        let old = self.rt.viewport;
        self.resize(size);
        self.snapshot(name);
        self.resize(old);
    }
}

fn render_rt(rt: &mut Runtime<App>, size: (u32, u32)) -> Vec<u8> {
    use rune::render::{Gpu, OFFSCREEN_FORMAT, Offscreen, Renderer};
    thread_local! {
        static GPU: Gpu = Gpu::headless();
    }
    GPU.with(|gpu| {
        let format = if rt.srgb_blend() {
            OFFSCREEN_FORMAT.remove_srgb_suffix()
        } else {
            OFFSCREEN_FORMAT
        };
        let mut renderer = Renderer::new(&gpu.device, format);
        renderer.set_srgb_blend(rt.srgb_blend());
        let target = Offscreen::with_format(&gpu.device, size.0, size.1, format);
        // Each snapshot uses a new renderer, so upload every glyph again.
        rt.text.atlas.invalidate();
        renderer.upload_images(&gpu.device, &gpu.queue, &mut rt.images);
        renderer.prepare_surfaces(&gpu.device, &gpu.queue, &rt.surfaces, size);
        renderer.prepare(
            &gpu.device,
            &gpu.queue,
            &mut rt.text.atlas,
            &rt.instances,
            size,
        );
        let mut encoder = gpu.device.create_command_encoder(&Default::default());
        renderer.draw(&mut encoder, &target.view, rt.clear_color());
        target.copy(&mut encoder);
        renderer.submit(&gpu.queue, encoder);
        target.read(&gpu.device)
    })
}

fn key_event(name: &str, mods: Mods) -> KeyEvent {
    let key = match name {
        "enter" => Key::Enter,
        "escape" | "Escape" => Key::Escape,
        "down" => Key::Down,
        "up" => Key::Up,
        other if mods.cmd => Key::Command(other.chars().next().unwrap()),
        other => Key::Text(other.into()),
    };
    KeyEvent { key, mods }
}

fn command() -> Mods {
    Mods {
        cmd: true,
        logo: cfg!(target_os = "macos"),
        ..Mods::default()
    }
}

fn agent(
    n: u32,
    project: &str,
    title: &str,
    status: Status,
    session_settings: SessionSettings,
    age: i64,
) -> Agent {
    let at = now() - age;
    Agent {
        id: format!("agent-{n}"),
        project_id: project.into(),
        title: title.into(),
        prompt: title.into(),
        session_settings,
        status,
        created_at: at,
        updated_at: at,
        base_branch: "main".into(),
        workspace: Workspace::Worktree {
            worktree: PathBuf::new(),
            branch: format!("pi-desk/task-{n}"),
        },
        session_id: format!("session-{n}"),
        session_file: None,
        summary: None,
        question: None,
        outbox: None,
        snooze_until: None,
        note: None,
        started: true,
    }
}

/// Saved state with one row in each interesting status.
fn seeded(dir: &std::path::Path) -> Desk {
    let repo = common::repo(dir);
    let mut question = agent(
        1,
        "p1",
        "Pick a cache size",
        Status::Question,
        SessionSettings::default(),
        600,
    );
    question.question = Some(Question {
        text: "The cache can hold 128 or 512 entries. Larger uses about 40 MB more memory. Which should it be?".into(),
        choices: vec!["128 entries".into(), "512 entries".into(), "Make it configurable".into()],
        recommended: Some(1),
        kind: QuestionKind::AskChoices,
        request_id: None,
        asked_at: now() - 600,
    });
    let mut review = agent(
        2,
        "p1",
        "Retry flaky network test",
        Status::Review,
        SessionSettings::default(),
        3600,
    );
    review.summary = Some(Summary {
        did: "Made the network test wait for the server socket.".into(),
        needs: "Review and merge".into(),
    });
    let failed = agent(
        3,
        "p2",
        "Update the README badges",
        Status::Failed {
            error: "Pi exited with 1:\nNo API key for provider".into(),
        },
        SessionSettings::default(),
        86400,
    );
    let mut recent = agent(
        4,
        "p2",
        "Fix the login crash",
        Status::Review,
        SessionSettings::default(),
        60,
    );
    recent.summary = Some(Summary {
        did: "Guarded the nil session.".into(),
        needs: "Review and merge".into(),
    });
    let mut queued = agent(
        5,
        "p1",
        "Write release notes",
        Status::Queued,
        SessionSettings::default(),
        30,
    );
    queued.started = false;
    queued.outbox = Some(Outbox {
        text: "Write release notes".into(),
        kind: OutboxKind::Initial,
    });
    let done = agent(
        6,
        "p1",
        "Rename the config module",
        Status::Done {
            outcome: Outcome::Merged,
        },
        SessionSettings::default(),
        200000,
    );
    let mut agents = vec![question, review, failed, recent, queued, done];
    for agent in &mut agents {
        let path = dir.join("worktrees").join(&agent.id);
        std::fs::create_dir_all(&path).unwrap();
        if let Workspace::Worktree { worktree, .. } = &mut agent.workspace {
            *worktree = path;
        }
    }
    let state = State {
        projects: vec![
            Project {
                id: "p1".into(),
                name: "api".into(),
                path: repo.clone(),
            },
            Project {
                id: "p2".into(),
                name: "website".into(),
                path: repo,
            },
        ],
        agents,
        settings: Settings::default(),
    };
    let store = Store::new(dir.join("state"));
    store.save(&state).unwrap();
    let mut app = App::new(store, common::fake_pi());
    // Point swarm reads at an empty directory instead of the user's runs.
    app.swarm_dir = dir.join("swarm");
    Desk::new(app)
}

#[test]
fn status_changes_keep_the_view_and_selection() {
    use pi_desk::{desk::Effect, supervisor::Event};

    for selected in [true, false] {
        let dir = tempfile::tempdir().unwrap();
        let mut app = seeded(dir.path());
        let effects = app.desk.schedule(now());
        let generation = effects
            .iter()
            .find_map(|effect| match effect {
                Effect::Spawn(spawn) if spawn.agent == "agent-5" => Some(spawn.generation),
                _ => None,
            })
            .unwrap();
        let view = if selected { View::Working } else { View::Inbox };
        let _ = app.update(Message::Show(view.clone()));
        let original = app.selected.clone();
        assert_eq!(original.as_deref() == Some("agent-5"), selected);
        let event = |record: &str| {
            Message::Supervisor(Event::Lines {
                agent: "agent-5".into(),
                generation,
                lines: vec![record.into()],
            })
        };
        let _ = app.update(event(r#"{"type":"extension_ui_request","id":"q1","method":"select","title":"Which?","options":["A","B"]}"#));
        assert_eq!(app.view, view);
        assert_eq!(app.selected, original);
        if selected {
            // The task no longer matches Working, but its row stays listed.
            assert!(app.rows().iter().any(|row| row.id == "agent-5"));
            let _ = app.update(Message::Choose(0));
            assert_eq!(app.view, View::Working);
            assert_eq!(app.selected, original);
        }
    }
}

#[test]
fn a_held_row_leaves_when_the_user_navigates() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = seeded(dir.path());
    app.desk.state.agents[3].snooze_until = Some(now() + 3600);
    let _ = app.update(Message::Show(View::Later));
    assert_eq!(app.selected.as_deref(), Some("agent-4"));
    // The snooze ends in the background: keep the task selected and listed.
    app.desk.state.agents[3].snooze_until = Some(now() - 1);
    let _ = app.update(Message::Tick);
    assert_eq!(app.view, View::Later);
    assert_eq!(app.selected.as_deref(), Some("agent-4"));
    assert_eq!(
        app.rows()
            .iter()
            .map(|row| row.id.as_str())
            .collect::<Vec<_>>(),
        ["agent-4"]
    );
    let _ = app.update(Message::Show(View::Done));
    assert_eq!(app.selected.as_deref(), Some("agent-6"));
    assert!(!app.rows().iter().any(|row| row.id == "agent-4"));
}

#[test]
fn changing_views_keeps_a_task_that_matches_the_new_view() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = seeded(dir.path());
    app.key("j");
    assert_eq!(app.selected.as_deref(), Some("agent-1"));
    let _ = app.update(Message::Show(View::All));
    assert_eq!(app.selected.as_deref(), Some("agent-1"));
    let _ = app.update(Message::Show(View::Project("p1".into())));
    assert_eq!(app.selected.as_deref(), Some("agent-1"));
    // The task isn't in this view, so the first row is selected instead.
    let _ = app.update(Message::Show(View::Working));
    assert_eq!(app.selected.as_deref(), Some("agent-5"));
    assert_eq!(app.rows().len(), 1);
}

#[test]
fn focus_mode_slides_the_task_list_out_and_keeps_the_detail_pane() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = seeded(dir.path());
    let list = app.keyed("list").unwrap();
    let detail = app.keyed("detail").unwrap();
    assert!(app.shows("New task"));
    app.key("f");
    assert!(app.focus);
    // Mid-slide, the list has moved part of the way out.
    app.rt.invalidate();
    app.rt.frame(0.0);
    app.rt.frame(0.1);
    let moving = app.rt.presented("list").unwrap().0;
    assert!(moving[0] < list[0] && moving[0] > list[0] - 600.0, "{moving:?}");
    let navigation = app.keyed("navigation").unwrap();
    assert_eq!(navigation[2], 0.0);
    let list_after = app.keyed("list").unwrap();
    assert!(list_after[0] + list_after[2] <= 0.5, "{list_after:?}");
    assert!(!app.shows("New task"));
    let wide = app.keyed("detail").unwrap();
    assert!(wide[0] < detail[0] && wide[2] > detail[2]);
    app.key("f");
    assert!(!app.focus);
    assert_eq!(app.keyed("list").unwrap(), list);
    assert_eq!(app.keyed("detail").unwrap(), detail);
    assert!(app.shows("New task"));
}

#[test]
fn the_sidebar_slides_out_behind_the_list_and_back() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = seeded(dir.path());
    let sidebar = app.keyed("sidebar").unwrap();
    let list = app.keyed("list").unwrap();
    let detail = app.keyed("detail").unwrap();
    app.key("s");
    assert!(!app.show_sidebar);
    // Mid-slide, the sidebar and list have moved part of the way left.
    app.rt.invalidate();
    app.rt.frame(0.0);
    app.rt.frame(0.1);
    let moving = app.rt.presented("sidebar").unwrap().0;
    assert!(moving[0] < sidebar[0] && moving[0] > sidebar[0] - sidebar[2], "{moving:?}");
    let moving_list = app.rt.presented("list").unwrap().0;
    assert!(moving_list[0] < list[0] && moving_list[0] > 0.0, "{moving_list:?}");
    assert_eq!(app.keyed("sidebar-slot").unwrap()[2], 0.0);
    let hidden = app.keyed("sidebar").unwrap();
    assert!(hidden[0] + hidden[2] <= 0.5, "{hidden:?}");
    assert!(!app.shows("New task"));
    assert!(app.keyed("list").unwrap()[0] <= 0.5);
    let wide = app.keyed("detail").unwrap();
    assert!(wide[0] < detail[0] && wide[2] > detail[2]);
    app.key("s");
    assert!(app.show_sidebar);
    assert_eq!(app.keyed("sidebar").unwrap(), sidebar);
    assert_eq!(app.keyed("list").unwrap(), list);
    assert_eq!(app.keyed("detail").unwrap(), detail);
    assert!(app.shows("New task"));
}

#[test]
fn discard_keeps_the_focused_task_selected() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = seeded(dir.path());
    let _ = app.update(Message::Show(View::Working));
    let _ = app.update(Message::Open("agent-5".into()));
    assert!(app.focus);
    let _ = app.update(Message::Discard);
    let _ = app.update(Message::ConfirmDiscard);
    assert_eq!(app.pending.len(), 1);
    assert_eq!(app.selected.as_deref(), Some("agent-5"));
    assert!(app.focus);
    assert!(app.rows().iter().any(|row| row.id == "agent-5"));
    // Other views don't count or list the task during its undo window.
    assert_eq!(app.count(&View::Working), 0);
    app.key("z");
    assert!(app.pending.is_empty());
    assert_eq!(app.selected.as_deref(), Some("agent-5"));
}

#[test]
fn the_app_opens_on_all_tasks() {
    let dir = tempfile::tempdir().unwrap();
    let app = seeded(dir.path());
    assert_eq!(app.view, View::All);
    assert_eq!(app.rows().len(), 6);
}

#[test]
fn command_p_fuzzy_searches_projects_in_the_composer() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = seeded(dir.path());
    app.key("n");
    let composer = |app: &App| match &app.overlay {
        Some(Overlay::Composer(composer)) => {
            (composer.project.clone(), composer.project_search.is_some())
        }
        _ => panic!("the composer should be open"),
    };
    assert_eq!(composer(&app), (Some("p2".into()), false));

    // Letters in order pick the project; Enter chooses the best match.
    app.press("p", command(), false);
    assert_eq!(composer(&app), (Some("p2".into()), true));
    let _ = app.update(Message::ComposerProjectQuery("AI".into()));
    assert_eq!(app.project_matches(), vec!["p1".to_string()]);
    app.key("enter");
    assert_eq!(composer(&app), (Some("p1".into()), false));

    // Escape leaves the search but keeps the composer open.
    app.press("p", command(), false);
    let _ = app.update(Message::ComposerProjectQuery("zzz".into()));
    assert!(app.project_matches().is_empty());
    assert!(app.shows("No matching projects"));
    app.key("enter");
    app.key("escape");
    assert_eq!(composer(&app), (Some("p1".into()), false));

    // An empty query lists every project in sidebar order.
    app.press("p", command(), false);
    assert_eq!(
        app.project_matches(),
        vec!["p1".to_string(), "p2".to_string()]
    );
    let _ = app.update(Message::ComposerProjectPick(1));
    assert_eq!(composer(&app), (Some("p2".into()), false));
    app.key("escape");
    assert!(app.overlay.is_none());
}

#[test]
fn command_e_toggles_use_worktree_in_the_composer() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = seeded(dir.path());
    app.key("n");
    let use_worktree = |app: &App| match &app.overlay {
        Some(Overlay::Composer(composer)) => composer.use_worktree,
        _ => panic!("the composer should be open"),
    };
    assert!(!use_worktree(&app));
    app.press("e", command(), false);
    assert!(use_worktree(&app));
    // Shifted or plain E leaves it alone.
    app.press(
        "e",
        Mods {
            shift: true,
            ..command()
        },
        false,
    );
    app.press("e", Mods::default(), false);
    assert!(use_worktree(&app));
    app.press("e", command(), false);
    assert!(!use_worktree(&app));
}

#[test]
fn a_reply_brings_a_done_task_back() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = seeded(dir.path());
    let _ = app.update(Message::Select("agent-6".into()));
    assert!(app.shows("Reply"));
    app.key("r");
    assert!(app.replying);
    app.reply = rune::TextEdit::new("Rename the tests too");
    let _ = app.update(Message::SendReply);
    let agent = app.desk.state.agent("agent-6").unwrap();
    assert!(!agent.status.is_done(), "{:?}", agent.status);
    assert_eq!(app.selected.as_deref(), Some("agent-6"));
}

#[test]
fn working_rows_show_the_start_of_the_latest_message() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = seeded(dir.path());
    app.desk.state.agent_mut("agent-5").unwrap().status = Status::Working;
    let messages = [serde_json::json!({"role":"assistant","content":[
        {"type":"text","text":"Older reply"},
        {"type":"thinking","thinking":"Checking the release script.\nThen the changelog."}
    ]})];
    app.desk.transcripts.insert(
        "agent-5".into(),
        pi_desk::transcript::Transcript::from_messages(messages.iter()),
    );
    assert!(app.shows("Checking the release script. Then the changelog."));
    assert!(!app.shows("Older reply"));
}

#[test]
fn long_task_branches_wrap_in_a_narrow_pane() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = seeded(dir.path());
    app.show_sidebar = false;
    let agent = app
        .desk
        .state
        .agents
        .iter_mut()
        .find(|agent| agent.id == "agent-4")
        .unwrap();
    let branch = "pi-desk/hello-world-with-a-long-task-name-and-a-unique-identifier-5efb6b";
    if let Workspace::Worktree { branch: saved, .. } = &mut agent.workspace {
        *saved = branch.into();
    }
    let size = (760.0, 900.0);
    app.resize(size);
    let [x, _, w, h] = app.bounds(branch);
    assert!(x + w <= size.0, "long branches must stay inside the pane");
    assert!(h > 20.0, "long branches wrap instead of truncating: {h}");
    app.snapshot("narrow-card");
}

#[test]
fn summaries_stay_visible_and_detail_tabs_have_no_extra_actions() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = seeded(dir.path());
    app.key("s"); // The old summary shortcut must no longer hide it.
    app.key("s");
    for text in ["Did", "Guarded the nil session.", "Needs", "Needs: Review and merge"] {
        assert!(app.shows(text), "{text:?} should be shown");
    }
    for label in [
        "Hide summary",
        "Show summary",
        "Refresh",
        "Terminal",
        "Editor",
    ] {
        assert!(!app.shows(label), "unexpected {label} control");
    }
    app.snapshot("always-summary");
}

#[test]
fn text_rows_align_and_wrapped_summaries_keep_their_first_line_alignment() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = seeded(dir.path());
    // The label and count are spans in one paragraph, not separate texts.
    let heading = app.keyed("task-list-heading").unwrap();
    assert!((heading[3] - 24.0).abs() < 0.01, "{heading:?}");
    assert!(app.shows("All tasks 6"));
    assert!(app.shows("Fix the login crash"));
    for name in ["Did", "Needs"] {
        let label = app.bounds(name);
        let value = app.keyed(&format!("summary-value-{name}")).unwrap();
        assert_eq!(label[1], value[1]);
        assert_eq!(label[3], value[3]);
    }
    let did = "Guarded the nil session, added a regression test, and checked that retries retain their work. ".repeat(3);
    app.desk
        .state
        .agents
        .iter_mut()
        .find(|agent| agent.id == "agent-4")
        .unwrap()
        .summary
        .as_mut()
        .unwrap()
        .did = did.clone();
    app.show_sidebar = false;
    app.resize((760.0, 900.0));
    let label = app.bounds("Did");
    let value = app.bounds(&did);
    assert_eq!(label[1], value[1]);
    assert!((label[3] - 21.0).abs() < 0.01, "{label:?}");
    assert!(value[3] > label[3]);
    let needs = app.bounds("Needs");
    assert!(needs[1] >= value[1] + value[3]);
    app.snapshot("aligned-wrapped-summary");
}

#[test]
fn a_dropped_file_types_its_path_into_the_reply() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = seeded(dir.path());
    let _ = app.update(Message::Select("agent-4".into()));
    assert!(!app.replying);
    // With no box open, a drop starts a reply to the selected task.
    app.rt.drop_files(
        vec![PathBuf::from(
            "/Users/me/Desktop/Screenshot 2026-11-03 at 10.00.00.png",
        )],
        Some((700.0, 400.0)),
    );
    app.render();
    assert!(app.replying);
    let _ = app.update(Message::FileDropped(PathBuf::from("/tmp/it's.png")));
    let _ = app.update(Message::FileDropped(PathBuf::from("/tmp/plain.png")));
    assert_eq!(
        app.reply.text,
        "'/Users/me/Desktop/Screenshot 2026-11-03 at 10.00.00.png' '/tmp/it'\\''s.png' /tmp/plain.png "
    );
}

#[tokio::test]
async fn a_dropped_file_types_its_path_into_the_task_composer() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = seeded(dir.path());
    let task = app.update(Message::NewTask);
    app.finish(task).await;
    let _ = app.update(Message::FileDropped(PathBuf::from("/tmp/shot.png")));
    let Some(Overlay::Composer(composer)) = &app.overlay else {
        panic!("composer should stay open")
    };
    assert_eq!(composer.content.text, "/tmp/shot.png ");
    assert!(!app.replying);
}

#[test]
fn done_heading_keeps_the_label_and_count_in_one_line_at_different_zoom_levels() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = seeded(dir.path());
    for agent in &mut app.desk.state.agents {
        if matches!(agent.id.as_str(), "agent-2" | "agent-4") {
            agent.status = Status::Done {
                outcome: Outcome::Merged,
            };
        }
    }
    let _ = app.update(Message::Show(View::Done));
    assert_eq!(app.rows().len(), 3);
    for (name, zoom) in [("done-heading", 1.0), ("done-heading-200", 2.0)] {
        let heading = app.keyed("task-list-heading").unwrap();
        assert!((heading[3] - 24.0 * zoom).abs() < 0.01, "{heading:?}");
        assert!(heading[2] > 50.0);
        app.snapshot(name);
        for _ in 0..10 {
            let _ = app.update(Message::ZoomIn);
        }
        app.show_sidebar = false;
    }
}

#[test]
fn zoom_shortcuts_work_while_typing_and_in_overlays() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = seeded(dir.path());
    let selected = app.selected.clone();
    for action in [
        Message::StartReply,
        Message::NewTask,
        Message::OpenPalette,
        Message::OpenSettings,
        Message::OpenLater,
        Message::Discard,
    ] {
        let _ = app.update(Message::CloseOverlay);
        let _ = app.update(Message::CancelReply);
        let _ = app.update(action);
        let overlay = app.overlay.as_ref().map(std::mem::discriminant);
        let reply = app.reply.text.clone();
        for (character, shift, expected) in [
            ("=", false, 1.1),
            ("+", true, 1.2),
            ("-", false, 1.1),
            ("0", false, 1.0),
        ] {
            app.press(character, Mods { shift, ..command() }, true);
            assert_eq!(app.scale_factor(), expected);
            assert_eq!(app.overlay.as_ref().map(std::mem::discriminant), overlay);
            assert_eq!(app.reply.text, reply);
            assert_eq!(app.selected, selected);
        }
    }
    let _ = app.update(Message::CloseOverlay);
    for mods in [
        Mods::default(),
        Mods {
            alt: true,
            ..command()
        },
    ] {
        app.press("=", mods, false);
        assert_eq!(app.scale_factor(), 1.0);
    }
}

#[test]
fn zoom_actions_are_bounded_resettable_and_session_only() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = seeded(dir.path());
    for _ in 0..30 {
        let _ = app.update(Message::ZoomOut);
    }
    assert_eq!(app.scale_factor(), 0.7);
    for _ in 0..30 {
        let _ = app.update(Message::ZoomIn);
    }
    assert_eq!(app.scale_factor(), 2.0);
    let resumed = App::new(Store::new(dir.path().join("state")), common::fake_pi());
    assert_eq!(resumed.scale_factor(), 1.0);
    let _ = app.update(Message::ResetZoom);
    for (query, expected) in [("Zoom in", 1.1), ("Zoom out", 1.0), ("Reset zoom", 1.0)] {
        let _ = app.update(Message::OpenPalette);
        let _ = app.update(Message::PaletteQuery(query.into()));
        let matches = app.palette_matches();
        assert_eq!(matches.len(), 1);
        assert!(!matches[0].keys.is_empty());
        if query == "Zoom in" {
            assert!(matches[0].label.contains("100%"));
        }
        let _ = app.update(Message::PaletteRun(0));
        assert!(app.overlay.is_none());
        assert_eq!(app.scale_factor(), expected);
    }
    let _ = app.update(Message::ZoomIn);
    let _ = app.update(Message::ResetZoom);
    assert_eq!(app.scale_factor(), 1.0);
}

#[test]
fn zoomed_layouts_reflow_at_the_scaled_window_viewport() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = seeded(dir.path());
    for _ in 0..3 {
        let _ = app.update(Message::ZoomOut);
    }
    app.snapshot("zoom-70");
    let _ = app.update(Message::ResetZoom);
    for _ in 0..2 {
        let _ = app.update(Message::ZoomIn);
    }
    for label in ["Hide sidebar", "Did", "Guarded the nil session."] {
        app.bounds(label);
    }
    app.snapshot("zoom-120");
    let _ = app.update(Message::OpenPalette);
    let _ = app.update(Message::PaletteQuery("zoom".into()));
    assert!(app.shows("Zoom in (current: 120%)"));
    app.snapshot("zoom-palette");
    let _ = app.update(Message::CloseOverlay);
    for _ in 0..8 {
        let _ = app.update(Message::ZoomIn);
    }
    // Use the existing sidebar toggle to leave more room at high zoom.
    app.key("s");
    for label in ["Show sidebar", "Did", "Needs"] {
        let [x, _, w, _] = app.bounds(label);
        assert!(x + w <= SIZE.0 + 0.5, "{label} at {x} + {w}");
    }
    app.snapshot("zoom-200-sidebar-hidden");
}

#[test]
fn existing_shortcuts_have_visible_control_and_overlay_hints() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = seeded(dir.path());
    let label = app.bounds("Hide sidebar");
    let hint = app.bounds("S");
    assert!(hint[0] >= label[0] + label[2]);
    assert!((hint[1] + hint[3] / 2.0 - label[1] - label[3] / 2.0).abs() < 6.0);

    let _ = app.update(Message::OpenSettings);
    assert!(app.shows("Cancel"));
    assert!(app.shows("Esc"));
    app.snapshot("settings-shortcuts");
    app.key("escape");
    assert!(app.overlay.is_none());

    app.key("l");
    for label in ["Enter", "apply typed time", "Esc", "cancel"] {
        assert!(app.shows(label), "{label:?}");
    }
    app.key("escape");
    let _ = app.update(Message::OpenPalette);
    for label in ["/", "navigate", "Enter", "run", "Esc", "close"] {
        assert!(app.shows(label), "{label:?}");
    }
    app.key("escape");
    app.key("n");
    assert!(app.shows("File task"));
    assert!(app.shows("Esc"));
    app.key("escape");
    app.key("x");
    assert!(app.shows("X"));
    assert!(app.shows("Enter"));
}

#[test]
fn sidebar_shortcut_respects_typing_modifiers_and_overlays() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = seeded(dir.path());
    let selected = app.selected.clone();
    app.key("s");
    assert!(!app.show_sidebar);
    app.key("s");
    assert!(app.show_sidebar);
    assert_eq!(app.selected, selected);

    let _ = app.update(Message::StartReply);
    app.press("s", Mods::default(), true);
    assert!(app.show_sidebar, "typing must not toggle the sidebar");
    let _ = app.update(Message::CancelReply);
    for mods in [
        Mods {
            ctrl: true,
            ..Mods::default()
        },
        Mods {
            alt: true,
            ..Mods::default()
        },
        Mods {
            logo: true,
            ..Mods::default()
        },
    ] {
        app.press("s", mods, false);
        assert!(app.show_sidebar, "modified S must not toggle the sidebar");
    }
    let _ = app.update(Message::OpenPalette);
    app.key("s");
    assert!(app.show_sidebar, "overlays own character input");
    assert!(app.overlay.is_some());
    app.key("Escape");
    assert!(app.commands().iter().any(|command| {
        command.label == "Hide sidebar" && command.keys == [KeyPart::Text("S")]
    }));
}

#[test]
fn sidebar_can_be_hidden_and_restored() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = seeded(dir.path());
    let selected = app.selected.clone();
    app.click("Hide sidebar");
    assert!(!app.show_sidebar);
    assert_eq!(app.selected, selected);
    assert!(!app.shows("New task"));
    assert!(app.shows("Show sidebar"));
    app.snapshot("sidebar-hidden");
    app.click("Show sidebar");
    assert!(app.show_sidebar);
    assert!(app.shows("New task"));
}

#[test]
fn every_view_groups_by_status_and_latest_activity() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = seeded(dir.path());
    for (id, status) in [
        (7, Status::Working),
        (8, Status::Review),
        (9, Status::Queued),
        (
            10,
            Status::Done {
                outcome: Outcome::Merged,
            },
        ),
        (11, Status::Working),
        (12, Status::Question),
    ] {
        app.desk.state.agents.push(agent(
            id,
            "p1",
            &format!("Task agent-{id}"),
            status,
            SessionSettings::default(),
            0,
        ));
    }
    let at = app.now;
    let ages = [1000, 300, 2000, 120, 10, 90, 200, 100, 30, 5, 40, 2];
    for (agent, age) in app.desk.state.agents.iter_mut().zip(ages) {
        agent.title = format!("Task {}", agent.id);
        agent.created_at = at - 10000;
        agent.updated_at = at - age;
        if agent.id == "agent-8" {
            agent.snooze_until = Some(at + 100);
        }
        if agent.id == "agent-12" {
            agent.snooze_until = Some(at + 1000);
        }
    }
    let all = vec![4, 2, 1, 3, 11, 7, 5, 9, 12, 8, 10, 6];
    for (view, expected) in [
        (View::All, all.clone()),
        (View::Inbox, vec![4, 2, 1, 3]),
        (View::Working, vec![11, 7, 5, 9]),
        (View::Later, vec![12, 8]),
        (View::Done, vec![10, 6]),
        (View::Project("p1".into()), vec![2, 1, 11, 7, 5, 9, 12, 8]),
    ] {
        let _ = app.update(Message::Show(view.clone()));
        let ids: Vec<String> = app.rows().iter().map(|agent| agent.id.clone()).collect();
        let expected: Vec<String> = expected.iter().map(|id| format!("agent-{id}")).collect();
        assert_eq!(ids, expected, "{view:?}");
    }
    let _ = app.update(Message::Show(View::All));
    // The age beside the newest row must use activity, not the stale inbox time.
    assert!(app.shows("2m"));
    assert!(!app.shows("URGENT"));
    assert!(!app.shows("EVERYTHING ELSE"));
    app.snapshot_size("status-recency-list", (1440.0, 1500.0));
}

#[test]
fn all_tasks_includes_every_project_status_and_snoozed_task() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = seeded(dir.path());
    app.desk.state.agents.push(agent(
        7,
        "p2",
        "Run the benchmark",
        Status::Working,
        SessionSettings::default(),
        20,
    ));
    let mut snoozed = agent(
        8,
        "p1",
        "Review tomorrow",
        Status::Review,
        SessionSettings::default(),
        20,
    );
    snoozed.snooze_until = Some(now() + 86400);
    app.desk.state.agents.push(snoozed);
    // Start from a project so the global view must clear the project filter.
    let _ = app.update(Message::Show(View::Project("p1".into())));
    app.click("All tasks");
    assert_eq!(app.view, View::All);
    let rows = app.rows();
    assert_eq!(rows.len(), 8);
    for agent in &app.desk.state.agents {
        assert!(rows.iter().any(|row| row.id == agent.id));
    }
    for title in [
        "Write release notes",
        "Run the benchmark",
        "Review tomorrow",
        "Rename the config module",
        "Update the README badges",
    ] {
        assert!(app.shows(title), "{title:?}");
    }
    assert!(
        app.commands()
            .iter()
            .any(|command| command.label == "Show all tasks")
    );
    app.snapshot("all-tasks");
}

#[test]
fn corrupt_saved_state_stays_untouched_after_user_actions() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::new(dir.path().join("state"));
    std::fs::create_dir_all(store.root()).unwrap();
    let file = store.state_file();
    std::fs::write(&file, "not valid json").unwrap();
    let mut app = App::new(store, common::fake_pi());
    assert!(
        app.error
            .as_ref()
            .unwrap()
            .contains("nothing will be saved")
    );
    let repo = common::repo(dir.path());
    let _ = app.update(Message::ProjectPicked(Some(repo)));
    let _ = app.update(Message::DismissError);
    assert_eq!(std::fs::read_to_string(file).unwrap(), "not valid json");
}

#[test]
fn thinking_is_one_line_by_default_and_expands_independently() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = seeded(dir.path());
    app.selected = Some("agent-4".into());
    let thinking = format!(
        "Check the caller.\n\n{}",
        "Inspect the remaining details. ".repeat(12)
    );
    let flat = thinking.split_whitespace().collect::<Vec<_>>().join(" ");
    let preview = format!("{}…", flat.chars().take(109).collect::<String>().trim_end());
    let messages = [serde_json::json!({"role":"assistant","content":[
        {"type":"thinking","thinking":thinking},
        {"type":"text","text":"The visible reply"},
        {"type":"thinking","thinking":"An independent second block"}
    ]})];
    app.desk.transcripts.insert(
        "agent-4".into(),
        pi_desk::transcript::Transcript::from_messages(messages.iter()),
    );
    assert!(app.expanded_thinking.is_empty());
    for width in [760.0, 1440.0] {
        app.resize((width, 900.0));
        let bounds = app.bounds(&preview);
        assert!(
            bounds[3] <= 18.0,
            "thinking preview must not wrap: {bounds:?}"
        );
        assert!(!app.shows(&thinking));
    }
    app.snapshot_size("thinking-collapsed-narrow", (760.0, 900.0));
    app.resize(SIZE);
    app.click(&preview);
    assert!(app.shows(&thinking));
    assert_eq!(app.expanded_thinking.len(), 1);
    app.click("An independent second block");
    assert_eq!(app.expanded_thinking.len(), 2);
    app.click(&preview);
    assert!(!app.shows(&thinking));
    assert_eq!(app.expanded_thinking.len(), 1);

    // Identical entry/block indices in another task must still start collapsed.
    app.selected = Some("agent-1".into());
    app.desk.transcripts.insert(
        "agent-1".into(),
        pi_desk::transcript::Transcript::from_messages(messages.iter()),
    );
    assert!(!app.shows(&thinking));
    assert!(!app.expanded_thinking.contains(&("agent-1".into(), 0, 2)));
}

#[test]
fn expanding_a_read_of_an_image_shows_the_image() {
    use base64::Engine;
    use serde_json::json;
    let dir = tempfile::tempdir().unwrap();
    let mut app = seeded(dir.path());
    app.images = Some(rune::ImageCache::new(std::sync::Arc::new(|| {})));
    app.selected = Some("agent-4".into());
    let mut png_bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut png_bytes, 40, 20);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let pixels: Vec<u8> = [220, 60, 40, 255].repeat(40 * 20);
        encoder
            .write_header()
            .unwrap()
            .write_image_data(&pixels)
            .unwrap();
    }
    let data = base64::engine::general_purpose::STANDARD.encode(&png_bytes);
    let messages = [
        json!({"role":"assistant","content":[{"type":"toolCall","id":"r1","name":"read","arguments":{"path":"shot.png"}}],"stopReason":"toolUse"}),
        json!({"role":"toolResult","toolCallId":"r1","toolName":"read","content":[
            {"type":"text","text":"Read image file [image/png]"},
            {"type":"image","data":data,"mimeType":"image/png"}
        ],"isError":false}),
    ];
    app.desk.transcripts.insert(
        "agent-4".into(),
        pi_desk::transcript::Transcript::from_messages(messages.iter()),
    );
    let label = "Image the tool returned";
    assert!(!app.shows(label));
    let head = app.bounds("shot.png");
    app.click("shot.png");
    // Decoding runs on the cache's worker. The shown element holds the same
    // handle, so wait on it, then lay out again.
    let picture = app.images.as_ref().unwrap().load(png_bytes.clone());
    picture.wait().unwrap();
    app.snapshot("tool-image-expanded");
    let [_, _, width, height] = app.bounds(label);
    assert_eq!((width, height), (40.0, 20.0));
    // Expanding must not scroll the row's header away.
    assert_eq!(app.bounds("shot.png"), head);
    app.click("shot.png");
    assert!(!app.shows(label));
}

#[test]
fn thinking_stays_collapsed_during_streaming_and_keeps_explicit_expansion() {
    use serde_json::json;
    let dir = tempfile::tempdir().unwrap();
    let mut app = seeded(dir.path());
    app.selected = Some("agent-4".into());
    let thinking = format!("A streaming thought.\n{}", "More detail. ".repeat(15));
    let mut transcript = pi_desk::transcript::Transcript::default();
    for record in [
        json!({"type":"message_start","message":{"role":"assistant","content":[]}}),
        json!({"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","contentIndex":0,"delta":thinking}}),
    ] {
        transcript.apply(&pi_desk::rpc::parse(&record.to_string()).unwrap());
    }
    app.desk.transcripts.insert("agent-4".into(), transcript);
    assert!(!app.shows(&thinking));
    app.click("Thinking");
    assert!(app.shows(&thinking));
    let completed = format!("{thinking}Final detail.");
    let final_message =
        json!({"role":"assistant","content":[{"type":"thinking","thinking":completed}]});
    for record in [
        json!({"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","contentIndex":0,"delta":"Final detail."}}),
        json!({"type":"message_end","message":final_message}),
    ] {
        app.desk
            .transcripts
            .get_mut("agent-4")
            .unwrap()
            .apply(&pi_desk::rpc::parse(&record.to_string()).unwrap());
        assert!(app.shows(&completed));
        assert_eq!(app.expanded_thinking.len(), 1);
    }
    app.click("Thinking");
    assert!(!app.shows(&completed));
    assert!(app.expanded_thinking.is_empty());
    app.desk.transcripts.insert(
        "agent-4".into(),
        pi_desk::transcript::Transcript::from_messages([&final_message]),
    );
    assert!(!app.shows(&completed));
}

#[test]
fn diff_and_transcript_tabs_render_content() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = seeded(dir.path());
    let id = app.selected.clone().unwrap();
    let messages = [
        serde_json::json!({"role": "user", "content": "Fix the crash"}),
        serde_json::json!({"role": "assistant", "content": [{"type": "text", "text": "Added a session guard."}]}),
    ];
    app.desk.transcripts.insert(
        id.clone(),
        pi_desk::transcript::Transcript::from_messages(messages.iter()),
    );
    assert!(app.shows("Fix the crash"));
    assert!(app.shows("Added a session guard."));
    app.snapshot("transcript");

    app.key("d");
    let diff = "diff --git a/src/main.rs b/src/main.rs\n--- a/src/main.rs\n+++ b/src/main.rs\n@@ -1 +1,2 @@\n-fn main() {}\n+fn main() {\n+    println!(\"hello\");\n";
    let _ = app.update(Message::DiffLoaded(
        id,
        Ok(pi_desk::app::LoadedDiff::parse(diff, None)),
    ));
    assert!(app.shows("src/main.rs"));
    let line = app.keyed("diff-line-0").expect("diff code must be shown");
    assert!(line[2] > 80.0, "diff line collapsed: {line:?}");
    assert!(app.shows("+    println!(\"hello\");"));
    app.snapshot("diff");
}

#[test]
fn rich_transcript_typography_uses_the_same_layout_live_and_completed() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = seeded(dir.path());
    let id = app.selected.clone().unwrap();
    app.focus = true;
    let message = serde_json::json!({"role":"assistant","content":[{"type":"text","text":
        "# Streaming stays still\n\nExisting lines stay in place as **new tokens** arrive. A wrapped line gets one entrance, not an endless slide. Read the [guide](https://example.com/guide) or check `src/main.rs`.\n\n## Checks\n\n- Consistent body text and **emphasis**.\n- Secondary labels remain readable.\n- Code stays monospace.\n\n```rust\nfn main() {\n    println!(\"one entrance per line\");\n}\n```\n\n> Wrapped text, headings, code, and links share the same type scale."
    }]});
    app.desk.transcripts.insert(
        id.clone(),
        pi_desk::transcript::Transcript::from_messages([&message]),
    );
    app.snapshot_size("typography-completed", (1100.0, 1300.0));
    app.desk
        .state
        .agents
        .iter_mut()
        .find(|agent| agent.id == id)
        .unwrap()
        .status = Status::Working;
    app.snapshot_size("typography-streaming", (1100.0, 1300.0));
}

#[test]
fn the_inbox_puts_latest_activity_first_and_opens_the_first_card() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = seeded(dir.path());
    let _ = app.update(Message::Show(View::Inbox));
    let titles: Vec<&str> = app
        .rows()
        .iter()
        .map(|agent| agent.title.as_str())
        .collect();
    assert_eq!(
        titles,
        [
            "Fix the login crash",
            "Pick a cache size",
            "Retry flaky network test",
            "Update the README badges"
        ]
    );
    assert_eq!(app.selected.as_deref(), Some("agent-4"));
    assert_eq!(app.count(&View::Inbox), 4);
    assert!(app.keyed("task-group-Needs you").is_some());
    for text in [
        "Merge",
        "Send back with a reply",
        "Guarded the nil session.",
        "Transcript",
    ] {
        assert!(app.shows(text), "{text:?} should be visible");
    }
    app.snapshot("inbox");
}

#[test]
fn question_cards_show_numbered_choices_and_a_click_answers() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = seeded(dir.path());
    app.key("j");
    assert_eq!(app.selected.as_deref(), Some("agent-1"));
    assert!(app.shows("recommended"));
    assert!(app.shows("Make it configurable"));
    app.snapshot("question");
    app.click("512 entries");
    let agent = app.desk.state.agent("agent-1").unwrap();
    assert!(agent.question.is_none());
    // The process is gone, so the answer waits as a prompt for the next run.
    assert_ne!(agent.status, Status::Question);
    // Answering keeps this thread open, even if resuming it fails.
    assert_eq!(app.selected.as_deref(), Some("agent-1"));
    assert!(app.rows().iter().any(|row| row.id == "agent-1"));
}

#[test]
fn answering_in_all_tasks_keeps_the_selected_thread() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = seeded(dir.path());
    let _ = app.update(Message::Show(View::All));
    // Select the question through the same navigation used by the UI.
    for _ in 0..app.rows().len() {
        if app.selected.as_deref() == Some("agent-1") {
            break;
        }
        app.key("j");
    }
    assert_eq!(app.selected.as_deref(), Some("agent-1"));
    let _ = app.update(Message::Choose(0));
    assert_eq!(app.selected.as_deref(), Some("agent-1"));
    assert_eq!(app.view, View::All);
}

#[test]
fn later_snoozes_and_undo_restores() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = seeded(dir.path());
    app.key("l");
    assert!(matches!(app.overlay, Some(Overlay::Later(_))));
    app.snapshot("later");
    app.key("3");
    assert!(app.overlay.is_none());
    assert!(app.desk.state.agent("agent-4").unwrap().snoozed(now()));
    // The snoozed task stays selected and listed.
    assert_eq!(app.selected.as_deref(), Some("agent-4"));
    assert!(app.rows().iter().any(|row| row.id == "agent-4"));
    app.key("z");
    assert!(!app.desk.state.agent("agent-4").unwrap().snoozed(now()));
}

#[test]
fn merge_and_discard_wait_out_an_undo_window() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = seeded(dir.path());
    app.key("e");
    assert_eq!(app.pending.len(), 1);
    // The task stays selected and listed while the merge waits.
    assert_eq!(app.selected.as_deref(), Some("agent-4"));
    assert!(app.rows().iter().any(|row| row.id == "agent-4"));
    assert!(app.shows("Undo"));
    app.snapshot("undo-bar");
    app.key("z");
    assert!(app.pending.is_empty());
    assert_eq!(app.selected.as_deref(), Some("agent-4"));

    app.key("x");
    assert!(matches!(app.overlay, Some(Overlay::ConfirmDiscard(_))));
    app.snapshot("discard");
    app.key("enter");
    assert_eq!(app.pending.len(), 1);
    app.key("z");
    assert!(app.pending.is_empty());
    assert_eq!(
        app.desk.state.agent("agent-4").unwrap().status,
        Status::Review
    );
}

#[tokio::test]
async fn switching_tasks_reuses_models_and_refresh_keeps_selectors_visible() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = seeded(dir.path());
    let target = Some("agent-4".to_string());
    let task = app.update(Message::RefreshSession(target.clone()));
    app.finish(task).await;
    let _ = app.update(Message::Select("agent-2".into()));
    let _ = app.update(Message::Select("agent-4".into()));
    assert!(!app.session_picker(&target).unwrap().loading);
    let task = app.update(Message::RefreshSession(target.clone()));
    assert!(app.session_picker(&target).unwrap().loading);
    assert!(app.shows("Model"));
    assert!(app.shows("Effort"));
    assert!(app.shows("Refreshing…"));
    app.finish(task).await;
    app.desk
        .state
        .agents
        .iter_mut()
        .find(|agent| agent.id == "agent-4")
        .unwrap()
        .session_settings
        .effort = Some("changed".into());
    let _ = app.update(Message::Select("agent-2".into()));
    let _ = app.update(Message::Select("agent-4".into()));
    assert!(app.session_picker(&target).unwrap().loading);
}

#[tokio::test]
async fn session_selectors_use_pi_levels_save_per_task_and_reset_new_tasks_to_defaults() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = seeded(dir.path());
    let target = Some("agent-4".to_string());
    let task = app.update(Message::RefreshSession(target.clone()));
    app.finish(task).await;
    assert!(app.shows("Model"));
    assert!(app.shows("Effort"));
    assert!(!app.shows("Urgent"));
    assert!(
        app.commands()
            .iter()
            .all(|command| !command.label.contains("Priority"))
    );
    let plain = ModelChoice {
        provider: "fake".into(),
        id: "plain".into(),
    };
    let task = app.update(Message::SessionModel(target.clone(), plain.clone()));
    app.finish(task).await;
    let picker = app.session_picker(&target).unwrap();
    assert_eq!(picker.options.as_ref().unwrap().levels, ["off"]);
    assert_eq!(picker.settings.effort.as_deref(), Some("off"));
    assert_eq!(
        app.desk
            .state
            .agent("agent-4")
            .unwrap()
            .session_settings
            .model,
        Some(plain)
    );
    let _ = app.update(Message::SessionEffort(target.clone(), "max".into()));
    assert_eq!(
        app.desk
            .state
            .agent("agent-4")
            .unwrap()
            .session_settings
            .effort
            .as_deref(),
        Some("off")
    );
    assert_eq!(
        app.desk.state.agent("agent-2").unwrap().session_settings,
        SessionSettings::default()
    );

    let reasoning = ModelChoice {
        provider: "fake".into(),
        id: "reasoning".into(),
    };
    // Choose the model the way the window does: open the menu, then pick.
    app.click("fake/plain");
    assert!(app.menu.is_some());
    app.click("fake/reasoning");
    app.settle().await;
    assert!(app.menu.is_none());
    assert_eq!(
        app.desk
            .state
            .agent("agent-4")
            .unwrap()
            .session_settings
            .model,
        Some(reasoning.clone())
    );
    let _ = app.update(Message::SessionEffort(target.clone(), "max".into()));
    assert_eq!(
        app.desk
            .state
            .agent("agent-4")
            .unwrap()
            .session_settings
            .effort
            .as_deref(),
        Some("max")
    );
    let saved = Store::new(dir.path().join("state")).load().unwrap();
    assert_eq!(
        saved.agent("agent-4").unwrap().session_settings,
        app.desk.state.agent("agent-4").unwrap().session_settings
    );
    app.snapshot("session-selectors");

    let task = app.update(Message::NewTask);
    app.finish(task).await;
    let picker = app.session_picker(&None).unwrap();
    assert_eq!(picker.settings.model, Some(reasoning));
    assert_eq!(picker.settings.effort.as_deref(), Some("medium"));
    let _ = app.update(Message::SessionEffort(None, "high".into()));
    let Some(Overlay::Composer(composer)) = &mut app.overlay else {
        panic!();
    };
    composer.content = rune::TextEdit::new("Fix the first thing");
    let before = app.desk.state.agents.len();
    let _ = app.update(Message::ComposerSubmit);
    assert_eq!(app.desk.state.agents.len(), before + 1);
    for agent in &app.desk.state.agents[before..] {
        assert_eq!(agent.session_settings.effort.as_deref(), Some("high"));
    }
    let task = app.update(Message::NewTask);
    app.finish(task).await;
    assert_eq!(
        app.session_picker(&None)
            .unwrap()
            .settings
            .effort
            .as_deref(),
        Some("medium")
    );
}

#[tokio::test]
async fn an_unavailable_saved_model_can_be_replaced_using_the_available_choices() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = seeded(dir.path());
    let target = Some("agent-4".to_string());
    let saved = SessionSettings {
        model: Some(ModelChoice {
            provider: "missing".into(),
            id: "old-model".into(),
        }),
        effort: Some("high".into()),
    };
    app.desk
        .state
        .agent_mut("agent-4")
        .unwrap()
        .session_settings = saved.clone();
    let task = app.update(Message::RefreshSession(target.clone()));
    app.finish(task).await;
    let picker = app.session_picker(&target).unwrap();
    assert_eq!(picker.settings, saved);
    assert!(picker.error.as_ref().unwrap().contains("unavailable"));
    assert!(picker.options.as_ref().unwrap().levels.is_empty());
    assert!(!picker.options.as_ref().unwrap().models.is_empty());
    let replacement = ModelChoice {
        provider: "fake".into(),
        id: "plain".into(),
    };
    let task = app.update(Message::SessionModel(target.clone(), replacement.clone()));
    app.finish(task).await;
    assert!(app.session_picker(&target).unwrap().error.is_none());
    assert_eq!(
        app.desk
            .state
            .agent("agent-4")
            .unwrap()
            .session_settings
            .model,
        Some(replacement)
    );
    assert_eq!(
        app.desk
            .state
            .agent("agent-4")
            .unwrap()
            .session_settings
            .effort
            .as_deref(),
        Some("off")
    );
}

#[tokio::test]
async fn stale_discovery_does_not_overwrite_a_new_composer_or_its_selection() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = seeded(dir.path());
    let stale = app.update(Message::NewTask);
    let current = app.update(Message::NewTask);
    app.finish(current).await;
    let model = ModelChoice {
        provider: "fake".into(),
        id: "plain".into(),
    };
    let task = app.update(Message::SessionModel(None, model.clone()));
    app.finish(task).await;
    app.finish(stale).await;
    assert_eq!(
        app.session_picker(&None).unwrap().settings.model,
        Some(model)
    );
    assert_eq!(
        app.session_picker(&None)
            .unwrap()
            .settings
            .effort
            .as_deref(),
        Some("off")
    );
    let task = app.update(Message::RefreshSession(None));
    let _ = app.update(Message::CloseOverlay);
    app.finish(task).await;
    assert!(app.overlay.is_none());
}

#[tokio::test]
async fn the_composer_files_the_whole_text_as_one_task() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = seeded(dir.path());
    let task = app.update(Message::NewTask);
    app.finish(task).await;
    let text = "In the API:\n- Add retries\n- Log slow queries\n- Remove the dead flag";
    let Some(Overlay::Composer(composer)) = &mut app.overlay else {
        panic!("composer should open")
    };
    composer.content = rune::TextEdit::new(text);
    assert!(app.shows("Files one task: In the API:"));
    assert!(app.shows("Works in the main checkout on main"));
    assert!(!app.shows("Files 3 tasks, one agent each:"));
    app.click("Use worktree");
    assert!(app.shows("Merges into main"));
    app.snapshot("composer");
    let before = app.desk.state.agents.len();
    app.click("File task");
    assert!(app.overlay.is_none());
    let filed = &app.desk.state.agents[before..];
    assert_eq!(filed.len(), 1, "a list must not split into tasks");
    assert!(matches!(filed[0].workspace, Workspace::Worktree { .. }));
    assert_eq!(filed[0].title, "In the API:");
    assert_eq!(filed[0].prompt, text);
    assert_eq!(filed[0].base_branch, "main");
}

#[tokio::test]
async fn the_composer_files_into_the_main_checkout_unless_worktree_is_checked() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = seeded(dir.path());
    let project = app.desk.state.projects[0].path.clone();
    let head = pi_desk::git::head(&project).unwrap();
    for title in ["First", "Second"] {
        let task = app.update(Message::NewTask);
        app.finish(task).await;
        let Some(Overlay::Composer(composer)) = &mut app.overlay else {
            panic!("composer should open")
        };
        // A fresh composer starts unchecked.
        assert!(!composer.use_worktree);
        composer.content = rune::TextEdit::new(title);
        let _ = app.update(Message::ComposerSubmit);
    }
    let filed: Vec<&Agent> = app
        .desk
        .state
        .agents
        .iter()
        .filter(|agent| matches!(agent.title.as_str(), "First" | "Second"))
        .collect();
    assert_eq!(filed.len(), 2);
    for agent in &filed {
        assert_eq!(
            agent.workspace,
            Workspace::Main {
                checkout: project.clone(),
                start: head.clone(),
            }
        );
    }
    // The checkout holds one task at a time, so only the first starts.
    assert_eq!(filed[0].status, Status::Working);
    assert_eq!(filed[1].status, Status::Queued);
}

#[test]
fn focus_palette_and_project_views_render() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = seeded(dir.path());
    app.key("b");
    assert!(!app.commands().iter().any(|command| command.label.contains("Board")));
    app.key("f");
    assert!(app.focus);
    app.snapshot("focus");
    app.key("escape");
    assert!(!app.focus);

    app.press("k", command(), false);
    let _ = app.update(Message::PaletteQuery("transcript".into()));
    let labels: Vec<String> = app
        .palette_matches()
        .into_iter()
        .map(|command| command.label)
        .collect();
    assert_eq!(labels, ["Show transcript"]);
    app.snapshot("palette");
    app.key("escape");

    let _ = app.update(Message::Show(View::Project("p2".into())));
    let titles: Vec<&str> = app
        .rows()
        .iter()
        .map(|agent| agent.title.as_str())
        .collect();
    assert_eq!(titles, ["Fix the login crash", "Update the README badges"]);
    app.press(
        "up",
        Mods {
            alt: true,
            ..Mods::default()
        },
        false,
    );
    assert_eq!(app.desk.state.projects[0].id, "p2");
    app.snapshot("project");
}

fn vim_type(app: &mut App, target: pi_desk::vim::Target, keys: &str) {
    for c in keys.chars() {
        let input = match c {
            '\x1b' => pi_desk::vim::Input::Escape,
            c => pi_desk::vim::Input::Char(c),
        };
        let _ = app.update(Message::Vim(target, input));
    }
}

#[test]
fn vim_reply_leaves_insert_on_jk_and_undoes_one_insert_at_a_time() {
    use pi_desk::vim::{Mode, Target};
    let dir = tempfile::tempdir().unwrap();
    let mut app = seeded(dir.path());
    let _ = app.update(Message::Select("agent-4".into()));
    app.key("r");
    assert_eq!(app.reply_vim.mode, Mode::Insert);
    assert!(app.shows("-- INSERT --"));
    vim_type(&mut app, Target::Reply, "hello worldjk");
    assert_eq!(app.reply.text, "hello world");
    assert_eq!(app.reply_vim.mode, Mode::Normal);
    assert!(app.shows("-- NORMAL --"));
    vim_type(&mut app, Target::Reply, "bdw");
    assert_eq!(app.reply.text, "hello ");
    vim_type(&mut app, Target::Reply, "Athere\x1b");
    assert_eq!(app.reply.text, "hello there");
    vim_type(&mut app, Target::Reply, "u");
    assert_eq!(app.reply.text, "hello ");
    vim_type(&mut app, Target::Reply, "u");
    assert_eq!(app.reply.text, "hello world");
    vim_type(&mut app, Target::Reply, "u");
    assert_eq!(app.reply.text, "");
    let _ = app.update(Message::Vim(Target::Reply, pi_desk::vim::Input::Redo));
    assert_eq!(app.reply.text, "hello world");
}

#[test]
fn typing_in_the_reply_box_goes_through_the_focused_field() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = seeded(dir.path());
    app.desk.state.settings.vim_mode = false;
    let _ = app.update(Message::Select("agent-4".into()));
    app.key("r");
    app.render();
    for c in ["o", "k"] {
        app.rt.key(key_event(c, Mods::default()));
    }
    app.render();
    assert_eq!(app.reply.text, "ok");
    // Window shortcuts don't fire while typing.
    assert!(app.show_sidebar);
    app.rt.key(key_event("enter", Mods::default()));
    app.render();
    assert!(!app.replying);
    assert_eq!(app.reply.text, "");
}

#[tokio::test]
async fn vim_escape_leaves_insert_before_it_closes_the_composer() {
    use pi_desk::vim::Mode;
    let dir = tempfile::tempdir().unwrap();
    let mut app = seeded(dir.path());
    let task = app.update(Message::NewTask);
    app.finish(task).await;
    app.render();
    for c in ["f", "i", "x"] {
        app.rt.key(key_event(c, Mods::default()));
    }
    // The focused box takes Escape first: it leaves insert mode.
    app.rt.key(key_event("escape", Mods::default()));
    app.render();
    let Some(Overlay::Composer(composer)) = &app.overlay else {
        panic!("composer should stay open")
    };
    assert_eq!(composer.vim.mode, Mode::Normal);
    assert_eq!(composer.content.text, "fix");
    app.rt.key(key_event("escape", Mods::default()));
    app.render();
    assert!(app.overlay.is_none());
}

#[test]
fn vim_settings_save_and_reject_long_escape_sequences() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = seeded(dir.path());
    let _ = app.update(Message::OpenSettings);
    assert!(app.shows("Vim mode in the reply and task boxes"));
    let _ = app.update(Message::SettingsVimEscape("jj kk".into()));
    let _ = app.update(Message::SaveSettings);
    assert!(app.overlay.is_some());
    let _ = app.update(Message::SettingsVimEscape("kj".into()));
    let _ = app.update(Message::SettingsVim(false));
    let _ = app.update(Message::SaveSettings);
    assert!(app.overlay.is_none());
    assert_eq!(app.desk.state.settings.vim_escape, "kj");
    assert!(!app.desk.state.settings.vim_mode);
}

/// Writes a session file with a `pi:goal` entry for `agent`.
fn goal_session(dir: &std::path::Path, app: &mut App, agent: &str, status: &str) {
    let file = dir.join(format!("{agent}.jsonl"));
    let goal = serde_json::json!({
        "type": "custom",
        "customType": "pi:goal",
        "data": {"objective": "Ship the release with green CI", "status": status, "createdAt": 1, "elapsedMs": 0, "tokens": 0, "continuations": 0}
    });
    std::fs::write(&file, format!("{{\"type\":\"session\"}}\n{goal}\n")).unwrap();
    app.desk.state.agent_mut(agent).unwrap().session_file = Some(file);
}

#[tokio::test]
async fn goals_show_on_rows_and_in_the_detail_card() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = seeded(dir.path());
    goal_session(dir.path(), &mut app, "agent-4", "active");
    goal_session(dir.path(), &mut app, "agent-2", "complete");
    let task = app.watch();
    app.finish(task).await;
    let _ = app.update(Message::Select("agent-4".into()));
    // No live process reports the goal, so the saved active goal is paused.
    assert!(app.shows("Goal"));
    assert!(app.shows("Ship the release with green CI"));
    assert!(app.shows("Paused"));
    assert!(app.keyed("goal").is_some());
    assert!(app.keyed("goal-line-agent-4").is_some());
    // Finished goals are not shown.
    assert!(app.keyed("goal-line-agent-2").is_none());
    app.snapshot("goal");

    // A live status from the goal extension makes it active.
    use pi_desk::{desk::Effect, supervisor::Event};
    let effects = app.desk.schedule(now());
    let _ = effects;
    let _ = app.update(Message::StartReply);
    app.reply = rune::TextEdit::new("Keep going");
    let effects = app.desk.reply("agent-4", "Keep going");
    let generation = effects
        .iter()
        .find_map(|effect| match effect {
            Effect::Spawn(spawn) if spawn.agent == "agent-4" => Some(spawn.generation),
            _ => None,
        })
        .expect("the reply starts the agent");
    let _ = app.update(Message::Supervisor(Event::Lines {
        agent: "agent-4".into(),
        generation,
        lines: vec![r#"{"type":"extension_ui_request","id":"s1","method":"setStatus","statusKey":"goal","statusText":"goal"}"#.into()],
    }));
    assert!(app.desk.goal_active("agent-4"));
    assert_eq!(
        app.goal("agent-4").unwrap().status,
        pi_desk::goal::GoalStatus::Active
    );
    assert!(app.shows("Active"));
}

#[tokio::test]
async fn swarm_roots_list_their_active_agents() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = seeded(dir.path());
    let run = app.swarm_dir.join("run-1");
    std::fs::create_dir_all(&run).unwrap();
    let node = |id: &str, parent: Option<&str>, name: &str, depth: u32, status: &str, session: &str| {
        serde_json::json!({
            "id": id, "parent": parent, "name": name, "depth": depth, "status": status,
            "session": session, "current": {"model": "anthropic/claude-sonnet-5-5"},
            "activity": {"status": "working"}
        })
    };
    let nodes = serde_json::json!({
        "root": "root",
        "nodes": {
            "root": node("root", None, "root", 0, "running", "session-4"),
            "a": node("a", Some("root"), "parser", 1, "running", "s-a"),
            "b": node("b", Some("a"), "parser-tests", 2, "review", "s-b"),
            "c": node("c", Some("root"), "docs", 1, "complete", "s-c"),
        }
    });
    std::fs::write(run.join("run.json"), nodes.to_string()).unwrap();
    let task = app.watch();
    app.finish(task).await;
    assert_eq!(app.workers("agent-4").len(), 2);
    let _ = app.update(Message::Select("agent-4".into()));
    assert!(app.shows("2 agents"));
    assert!(app.shows("Swarm"));
    assert!(app.shows("parser"));
    assert!(app.shows("parser-tests"));
    assert!(!app.shows("docs"), "finished workers are not listed");
    // Children sit further right than their parents.
    let parent = app.keyed("worker-a").unwrap();
    let child = app.keyed("worker-b").unwrap();
    assert!(child[1] > parent[1]);
    assert!(app.bounds("parser-tests")[0] > app.bounds("parser")[0]);
    app.snapshot("swarm");
}

#[test]
fn an_empty_app_shows_the_welcome_state() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = Desk::new(App::new(Store::new(dir.path().join("state")), common::fake_pi()));
    assert!(app.desk.state.projects.is_empty());
    for text in ["Add a project to start", "Add project", "New task", "All tasks"] {
        assert!(app.shows(text), "{text:?} should be shown");
    }
    app.snapshot("empty");
}

#[tokio::test]
async fn remaining_shortcuts_switch_tabs_answer_by_number_and_file_with_command_enter() {
    use pi_desk::app::Tab;
    let dir = tempfile::tempdir().unwrap();
    let mut app = seeded(dir.path());
    app.key("d");
    assert_eq!(app.tab, Tab::Diff);
    app.key("t");
    assert_eq!(app.tab, Tab::Transcript);

    // A number picks that choice on a question card.
    app.key("j");
    assert_eq!(app.selected.as_deref(), Some("agent-1"));
    app.key("3");
    assert!(app.desk.state.agent("agent-1").unwrap().question.is_none());

    let task = app.update(Message::NewTask);
    app.finish(task).await;
    let Some(Overlay::Composer(composer)) = &mut app.overlay else {
        panic!("composer should open")
    };
    composer.content = rune::TextEdit::new("Tidy the logs");
    let before = app.desk.state.agents.len();
    app.press("enter", command(), true);
    assert!(app.overlay.is_none());
    assert_eq!(app.desk.state.agents.len(), before + 1);
    assert_eq!(app.desk.state.agents[before].title, "Tidy the logs");
}

#[test]
fn a_press_below_the_last_line_focuses_a_text_box() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = seeded(dir.path());
    app.desk.state.settings.vim_mode = false;
    let _ = app.update(Message::Select("agent-4".into()));
    app.key("r");
    app.reply = rune::TextEdit::new("one line");
    app.render();
    assert!(!app.reply.focused);
    let [x, y, _, h] = app.keyed("reply").expect("the reply field is shown");
    // The box is four lines tall; the text takes one.
    let (px, py) = (x + 40.0, y + h + 30.0);
    app.rt.pointer_move(px, py);
    app.rt.pointer_down(px, py);
    app.rt.pointer_up(px, py);
    app.render();
    assert!(
        app.reply.focused,
        "a press below the text must focus the reply"
    );
    let (caret, _) = app.reply.range();
    assert!(
        caret > 0,
        "the caret goes to the last line, not the start: {caret}"
    );

    app.key("escape");
    app.rt.state.send(Message::NewTask);
    app.render();
    if let Some(Overlay::Composer(composer)) = &mut app.overlay {
        composer.content = rune::TextEdit::new("first");
    }
    app.render();
    let [x, y, _, h] = app.keyed("composer").expect("the composer field is shown");
    let (px, py) = (x + 40.0, y + h + 60.0);
    app.rt.pointer_move(px, py);
    app.rt.pointer_down(px, py);
    app.rt.pointer_up(px, py);
    app.render();
    let Some(Overlay::Composer(composer)) = &app.overlay else {
        panic!("the composer closed");
    };
    assert!(
        composer.content.focused,
        "a press below the text must focus the composer"
    );
    assert!(composer.content.range().0 > 0);
}

#[test]
fn the_titlebar_band_keeps_content_clear_of_the_window_controls() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = seeded(dir.path());
    assert!(
        app.shows("pi-desk"),
        "without a titlebar the sidebar names the app"
    );
    let mut insets = rune::ChromeInsets::default();
    insets.leading = 76.0;
    insets.height = pi_desk::views::TITLEBAR;
    app.rt.set_chrome_insets(insets);
    let title = app.bounds("pi-desk");
    assert!(
        title[0] >= insets.leading,
        "the title clears the traffic lights: {title:?}"
    );
    assert!(
        title[1] + title[3] <= insets.height,
        "the title sits in the band: {title:?}"
    );
    let sidebar = app.keyed("sidebar").expect("the sidebar is shown");
    assert!(
        sidebar[1] >= insets.height,
        "the sidebar starts below the band: {sidebar:?}"
    );
    let named = app
        .elements()
        .into_iter()
        .filter(|element| element.text.as_deref() == Some("pi-desk") && !element.exiting)
        .count();
    assert_eq!(named, 1, "the sidebar drops its own name under a titlebar");
    for (show, key) in [(false, "sidebar-toggle"), (true, "sidebar-toggle")] {
        app.show_sidebar = show;
        let toggle = app.keyed(key).expect("the sidebar toggle is shown");
        assert!(
            toggle[1] >= insets.height,
            "{key} sits below the band: {toggle:?}"
        );
    }
    app.snapshot("titlebar");
}

#[test]
fn long_transcripts_build_only_the_rows_near_the_bottom() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = seeded(dir.path());
    let id = app.selected.clone().unwrap();
    let messages: Vec<serde_json::Value> = (0..600)
        .map(|n| {
            serde_json::json!({"role": "assistant", "content": [
                {"type": "text", "text": format!("Message number {n}")}
            ]})
        })
        .collect();
    app.desk.transcripts.insert(
        id.clone(),
        pi_desk::transcript::Transcript::from_messages(messages.iter()),
    );
    app.tab = pi_desk::app::Tab::Transcript;
    assert!(
        app.shows("Message number 599"),
        "the transcript opens at its end"
    );
    let built = app
        .elements()
        .into_iter()
        .filter(|element| {
            element
                .text
                .as_deref()
                .is_some_and(|text| text.starts_with("Message number"))
        })
        .count();
    assert!(built < 200, "{built} of 600 rows were built");
}

#[test]
fn mono_spans_use_the_platform_monospace() {
    // Markdown inline code asks for the mono family, as code blocks do.
    assert_eq!(pi_desk::app::spec().families, ("Inter", "ui-monospace"));
}
#[tokio::test]
async fn the_task_selected_at_startup_loads_its_saved_transcript() {
    let dir = tempfile::tempdir().unwrap();
    let mut first = seeded(dir.path());
    let id = first.selected.clone().unwrap();
    let file = dir.path().join("saved.jsonl");
    let message = serde_json::json!({
        "type": "message", "id": "m1", "parentId": null,
        "message": {"role": "assistant", "content": [{"type": "text", "text": "Saved before restart."}]}
    });
    std::fs::write(
        &file,
        format!("{{\"type\":\"session\",\"id\":\"s\"}}\n{message}\n"),
    )
    .unwrap();
    first.desk.state.agent_mut(&id).unwrap().session_file = Some(file);
    first.store.save(&first.desk.state).unwrap();

    let mut app = App::new(Store::new(dir.path().join("state")), common::fake_pi());
    app.swarm_dir = dir.path().join("swarm");
    let mut app = Desk::new(app);
    assert_eq!(app.selected.as_deref(), Some(id.as_str()));
    app.settle().await;
    assert!(
        app.shows("Saved before restart."),
        "the startup selection's transcript must load"
    );
}
