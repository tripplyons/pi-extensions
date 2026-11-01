//! Headless UI tests with iced_test's simulator. They check what the window
//! shows and what clicks and keys do. Snapshots are written to Cargo's test
//! temporary directory for visual review; they are not compared.

mod common;

use iced::keyboard::{Key, Modifiers, key::Named};
use iced_test::simulator::Simulator;
use pi_desk::app::{App, Message, Overlay, View};
use pi_desk::model::*;
use pi_desk::store::Store;
use std::path::PathBuf;

const SIZE: (f32, f32) = (1440.0, 900.0);

fn agent(
    n: u32,
    project: &str,
    title: &str,
    status: Status,
    priority: Priority,
    age: i64,
) -> Agent {
    let at = now() - age;
    Agent {
        id: format!("agent-{n}"),
        project_id: project.into(),
        title: title.into(),
        prompt: title.into(),
        priority,
        status,
        created_at: at,
        updated_at: at,
        inbox_at: Some(at),
        base_branch: "main".into(),
        branch: format!("pi-desk/task-{n}"),
        worktree: PathBuf::new(),
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
fn seeded(dir: &std::path::Path) -> App {
    let repo = common::repo(dir);
    let mut question = agent(
        1,
        "p1",
        "Pick a cache size",
        Status::Question,
        Priority::High,
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
        Priority::Medium,
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
        Priority::Medium,
        86400,
    );
    let mut urgent = agent(
        4,
        "p2",
        "Fix the login crash",
        Status::Review,
        Priority::Urgent,
        60,
    );
    urgent.summary = Some(Summary {
        did: "Guarded the nil session.".into(),
        needs: "Review and merge".into(),
    });
    let mut queued = agent(
        5,
        "p1",
        "Write release notes",
        Status::Queued,
        Priority::Low,
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
        Priority::Medium,
        200000,
    );
    let mut agents = vec![question, review, failed, urgent, queued, done];
    for agent in &mut agents {
        agent.worktree = dir.join("worktrees").join(&agent.id);
        std::fs::create_dir_all(&agent.worktree).unwrap();
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
    App::new(store, common::fake_pi())
}

fn ui(app: &App) -> Simulator<'_, Message> {
    // iced applies application scale by reducing the logical window viewport.
    let size = (SIZE.0 / app.scale_factor(), SIZE.1 / app.scale_factor());
    Simulator::with_size(iced::Settings::default(), size, app.view())
}

fn snapshot(app: &App, name: &str) {
    snapshot_size(app, name, SIZE);
}

fn snapshot_size(app: &App, name: &str, size: (f32, f32)) {
    // Match the logical viewport used by iced at this application zoom level.
    let size = (size.0 / app.scale_factor(), size.1 / app.scale_factor());
    let directory = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("ui");
    // matches_image adds the renderer name, as in `inbox-wgpu.png`. Remove the
    // last run's file so this writes a fresh image instead of comparing.
    if let Ok(entries) = std::fs::read_dir(&directory) {
        for entry in entries.flatten() {
            if entry
                .file_name()
                .to_string_lossy()
                .starts_with(&format!("{name}-"))
            {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    let path = directory.join(format!("{name}.png"));
    let shot = Simulator::with_size(iced::Settings::default(), size, app.view())
        .snapshot(&pi_desk::theme::theme())
        .unwrap();
    assert!(shot.matches_image(&path).unwrap());
}

fn key(app: &mut App, name: &str) {
    let key = match name {
        "enter" => Key::Named(Named::Enter),
        "escape" => Key::Named(Named::Escape),
        "down" => Key::Named(Named::ArrowDown),
        other => Key::Character(other.into()),
    };
    let _ = app.update(Message::Key {
        key,
        modifiers: Modifiers::empty(),
        captured: false,
    });
}

fn click(app: &mut App, label: &str) {
    let messages: Vec<Message> = {
        let mut ui = ui(app);
        ui.click(label)
            .unwrap_or_else(|error| panic!("no {label:?}: {error:?}"));
        ui.into_messages().collect()
    };
    assert!(!messages.is_empty(), "clicking {label:?} did nothing");
    for message in messages {
        let _ = app.update(message);
    }
}

#[test]
fn task_metadata_wraps_below_priority_in_a_narrow_pane() {
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
    agent.priority = Priority::Medium;
    agent.branch =
        "pi-desk/hello-world-with-a-long-task-name-and-a-unique-identifier-5efb6b".into();
    let branch = agent.branch.clone();
    let size = (760.0, 900.0);
    let mut rendered = Simulator::with_size(iced::Settings::default(), size, app.view());
    let priority = rendered.find("Medium").unwrap().visible_bounds().unwrap();
    let branch = rendered
        .find(branch.as_str())
        .unwrap()
        .visible_bounds()
        .unwrap();
    assert!(
        branch.y >= priority.y + priority.height,
        "branch must be below metadata"
    );
    assert!(
        branch.height > 20.0,
        "long branches must wrap rather than clip"
    );
    assert!(branch.x + branch.width <= size.0);
    snapshot_size(&app, "narrow-card", size);
}

#[test]
fn summaries_stay_visible_and_detail_tabs_have_no_extra_actions() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = seeded(dir.path());
    key(&mut app, "s"); // The old summary shortcut must no longer hide it.
    let mut rendered = ui(&app);
    rendered.find("Did").unwrap();
    rendered.find("Guarded the nil session.").unwrap();
    rendered.find("Needs").unwrap();
    rendered.find("Needs: Review and merge").unwrap();
    for label in [
        "Hide summary",
        "Show summary",
        "Refresh",
        "Terminal",
        "Editor",
    ] {
        assert!(rendered.find(label).is_err(), "unexpected {label} control");
    }
    snapshot(&app, "always-summary");
}

#[test]
fn text_rows_align_and_wrapped_summaries_keep_their_first_line_alignment() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = seeded(dir.path());
    {
        let mut rendered = ui(&app);
        // The label and count are spans in one paragraph, not separate text widgets.
        let heading = rendered
            .find(iced_test::selector::id("task-list-heading"))
            .unwrap()
            .visible_bounds()
            .unwrap();
        assert!((heading.height - 24.0).abs() < 0.01);
        let dot = rendered
            .find(iced_test::selector::id("task-status-agent-4"))
            .unwrap()
            .visible_bounds()
            .unwrap();
        let title = rendered
            .find("Fix the login crash")
            .unwrap()
            .visible_bounds()
            .unwrap();
        assert_eq!(dot.y, title.y);
        assert_eq!(dot.height, title.height);
        let did = rendered.find("Did").unwrap().visible_bounds().unwrap();
        let value = rendered
            .find(iced_test::selector::id("summary-value-Did"))
            .unwrap()
            .visible_bounds()
            .unwrap();
        assert_eq!(did.y, value.y);
        assert_eq!(did.height, value.height);
        let needs = rendered.find("Needs").unwrap().visible_bounds().unwrap();
        let value = rendered
            .find(iced_test::selector::id("summary-value-Needs"))
            .unwrap()
            .visible_bounds()
            .unwrap();
        assert_eq!(needs.y, value.y);
        assert_eq!(needs.height, value.height);
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
    let mut rendered = Simulator::with_size(iced::Settings::default(), (760.0, 900.0), app.view());
    let label = rendered.find("Did").unwrap().visible_bounds().unwrap();
    let value = rendered
        .find(did.as_str())
        .unwrap()
        .visible_bounds()
        .unwrap();
    assert_eq!(label.y, value.y);
    assert!((label.height - 20.0).abs() < 0.01);
    assert!(value.height > label.height);
    let needs = rendered.find("Needs").unwrap().visible_bounds().unwrap();
    assert!(needs.y >= value.y + value.height);
    snapshot_size(&app, "aligned-wrapped-summary", (760.0, 900.0));
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
    for name in ["done-heading", "done-heading-200"] {
        let heading = ui(&app)
            .find(iced_test::selector::id("task-list-heading"))
            .unwrap()
            .visible_bounds()
            .unwrap();
        assert!((heading.height - 24.0).abs() < 0.01);
        assert!(heading.width > 50.0);
        snapshot(&app, name);
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
        let reply = app.reply.text();
        for (character, modifiers, expected) in [
            ("=", Modifiers::COMMAND, 1.1),
            ("+", Modifiers::COMMAND | Modifiers::SHIFT, 1.2),
            ("-", Modifiers::COMMAND, 1.1),
            ("0", Modifiers::COMMAND, 1.0),
        ] {
            let _ = app.update(Message::Key {
                key: Key::Character(character.into()),
                modifiers,
                captured: true,
            });
            assert_eq!(app.scale_factor(), expected);
            assert_eq!(app.overlay.as_ref().map(std::mem::discriminant), overlay);
            assert_eq!(app.reply.text(), reply);
            assert_eq!(app.selected, selected);
        }
    }
    let _ = app.update(Message::CloseOverlay);
    for modifiers in [Modifiers::empty(), Modifiers::COMMAND | Modifiers::ALT] {
        let _ = app.update(Message::Key {
            key: Key::Character("=".into()),
            modifiers,
            captured: false,
        });
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
    snapshot(&app, "zoom-70");
    let _ = app.update(Message::ResetZoom);
    for _ in 0..2 {
        let _ = app.update(Message::ZoomIn);
    }
    for label in ["Board", "Hide sidebar", "Did", "Guarded the nil session."] {
        ui(&app).find(label).unwrap().visible_bounds().unwrap();
    }
    snapshot(&app, "zoom-120");
    let _ = app.update(Message::OpenPalette);
    let _ = app.update(Message::PaletteQuery("zoom".into()));
    ui(&app).find("Zoom in (current: 120%)").unwrap();
    snapshot(&app, "zoom-palette");
    let _ = app.update(Message::CloseOverlay);
    for _ in 0..8 {
        let _ = app.update(Message::ZoomIn);
    }
    // Use the existing sidebar toggle to leave more room at high zoom.
    key(&mut app, "s");
    for label in ["Show sidebar", "Board", "Did", "Needs"] {
        let bounds = ui(&app).find(label).unwrap().visible_bounds().unwrap();
        assert!(bounds.x + bounds.width <= SIZE.0 / app.scale_factor());
    }
    snapshot(&app, "zoom-200-sidebar-hidden");
}

#[test]
fn existing_shortcuts_have_visible_control_and_overlay_hints() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = seeded(dir.path());
    {
        let mut rendered = ui(&app);
        let label = rendered.find("Board").unwrap().visible_bounds().unwrap();
        let hint = rendered.find("B").unwrap().visible_bounds().unwrap();
        assert!(hint.x >= label.x + label.width);
        assert!((hint.y - label.y).abs() < 6.0);
    }
    click(&mut app, "Board");
    ui(&app).find("List").unwrap();
    ui(&app).find("B").unwrap();
    click(&mut app, "List");

    let _ = app.update(Message::OpenSettings);
    ui(&app).find("Cancel").unwrap();
    ui(&app).find("Esc").unwrap();
    snapshot(&app, "settings-shortcuts");
    key(&mut app, "escape");
    assert!(app.overlay.is_none());

    key(&mut app, "l");
    for label in ["Enter", "apply typed time", "Esc", "cancel"] {
        ui(&app).find(label).unwrap();
    }
    key(&mut app, "escape");
    let _ = app.update(Message::OpenPalette);
    for label in ["↑ / ↓", "navigate", "Enter", "run", "Esc", "close"] {
        ui(&app).find(label).unwrap();
    }
    key(&mut app, "escape");
    key(&mut app, "n");
    ui(&app).find("⌘↵").unwrap();
    ui(&app).find("Esc").unwrap();
    key(&mut app, "escape");
    key(&mut app, "x");
    ui(&app).find("X").unwrap();
    ui(&app).find("Enter").unwrap();
}

#[test]
fn sidebar_shortcut_respects_typing_modifiers_and_overlays() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = seeded(dir.path());
    let selected = app.selected.clone();
    key(&mut app, "s");
    assert!(!app.show_sidebar);
    key(&mut app, "s");
    assert!(app.show_sidebar);
    assert_eq!(app.selected, selected);
    key(&mut app, "b");
    key(&mut app, "s");
    assert!(app.board);
    assert!(!app.show_sidebar);
    key(&mut app, "s");
    assert!(app.show_sidebar);

    let _ = app.update(Message::StartReply);
    let _ = app.update(Message::Key {
        key: Key::Character("s".into()),
        modifiers: Modifiers::empty(),
        captured: true,
    });
    assert!(app.show_sidebar, "typing must not toggle the sidebar");
    let _ = app.update(Message::CancelReply);
    for modifiers in [Modifiers::CTRL, Modifiers::ALT, Modifiers::LOGO] {
        let _ = app.update(Message::Key {
            key: Key::Character("s".into()),
            modifiers,
            captured: false,
        });
        assert!(app.show_sidebar, "modified S must not toggle the sidebar");
    }
    let _ = app.update(Message::OpenPalette);
    key(&mut app, "s");
    assert!(app.show_sidebar, "overlays own character input");
    assert!(app.overlay.is_some());
    key(&mut app, "Escape");
    assert!(
        app.commands()
            .iter()
            .any(|command| { command.label == "Hide sidebar" && command.keys == "S" })
    );
}

#[test]
fn sidebar_can_be_hidden_and_restored_in_list_and_board() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = seeded(dir.path());
    let selected = app.selected.clone();
    click(&mut app, "Hide sidebar");
    assert!(!app.show_sidebar);
    assert_eq!(app.selected, selected);
    assert!(ui(&app).find("New task").is_err());
    ui(&app).find("Show sidebar").unwrap();
    snapshot(&app, "sidebar-hidden");
    click(&mut app, "Show sidebar");
    assert!(app.show_sidebar);
    ui(&app).find("New task").unwrap();
    click(&mut app, "Board");
    click(&mut app, "Hide sidebar");
    assert!(!app.show_sidebar);
    assert!(ui(&app).find("New task").is_err());
    snapshot(&app, "board-sidebar-hidden");
    click(&mut app, "Show sidebar");
    assert!(app.show_sidebar);
    ui(&app).find("New task").unwrap();
}

#[test]
fn every_view_groups_by_status_and_latest_activity_including_board_columns() {
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
            Priority::Low,
            0,
        ));
    }
    let at = app.now;
    let ages = [1000, 300, 2000, 120, 10, 90, 200, 100, 30, 5, 40, 2];
    for (agent, age) in app.desk.state.agents.iter_mut().zip(ages) {
        agent.title = format!("Task {}", agent.id);
        agent.created_at = at - 10000;
        agent.inbox_at = Some(at - 9999);
        agent.updated_at = at - age;
        // Make the oldest attention row urgent to prove priority no longer leads.
        if agent.id == "agent-3" {
            agent.priority = Priority::Urgent;
        }
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
    let mut list = ui(&app);
    list.find("2m").unwrap();
    assert!(list.find("URGENT").is_err());
    assert!(list.find("EVERYTHING ELSE").is_err());
    drop(list);
    snapshot_size(&app, "status-recency-list", (1440.0, 1500.0));
    key(&mut app, "b");
    let mut board = ui(&app);
    let mut previous_x = None;
    for (group, ids) in [
        ("Needs you", vec![4, 2, 1, 3]),
        ("Working", vec![11, 7]),
        ("Queued", vec![5, 9]),
        ("Later", vec![12, 8]),
        ("Done", vec![10, 6]),
    ] {
        let heading = board
            .find(iced_test::selector::id(format!("board-heading-{group}")))
            .unwrap()
            .visible_bounds()
            .unwrap();
        if let Some(x) = previous_x {
            assert!(heading.x > x);
        }
        previous_x = Some(heading.x);
        let mut previous_y = None;
        for id in ids {
            let title = format!("Task agent-{id}");
            let bounds = board
                .find(title.as_str())
                .unwrap()
                .visible_bounds()
                .unwrap();
            if let Some(y) = previous_y {
                assert!(bounds.y > y, "{group}: {title}");
            }
            previous_y = Some(bounds.y);
        }
    }
    drop(board);
    snapshot(&app, "status-recency-board");
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
        Priority::Medium,
        20,
    ));
    let mut snoozed = agent(
        8,
        "p1",
        "Review tomorrow",
        Status::Review,
        Priority::Low,
        20,
    );
    snoozed.snooze_until = Some(now() + 86400);
    app.desk.state.agents.push(snoozed);
    // Start from a project so the global view must clear the project filter.
    let _ = app.update(Message::Show(View::Project("p1".into())));
    click(&mut app, "All tasks");
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
        ui(&app).find(title).unwrap();
    }
    assert!(
        app.commands()
            .iter()
            .any(|command| command.label == "Show all tasks")
    );
    snapshot(&app, "all-tasks");
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
        let mut rendered =
            Simulator::with_size(iced::Settings::default(), (width, 900.0), app.view());
        let bounds = rendered
            .find(preview.as_str())
            .unwrap()
            .visible_bounds()
            .unwrap();
        assert!(
            bounds.height <= 18.0,
            "thinking preview must not wrap: {bounds:?}"
        );
        assert!(rendered.find(thinking.as_str()).is_err());
    }
    snapshot_size(&app, "thinking-collapsed-narrow", (760.0, 900.0));
    click(&mut app, &preview);
    ui(&app).find(thinking.as_str()).unwrap();
    assert_eq!(app.expanded_thinking.len(), 1);
    click(&mut app, "An independent second block");
    assert_eq!(app.expanded_thinking.len(), 2);
    click(&mut app, &preview);
    assert!(ui(&app).find(thinking.as_str()).is_err());
    assert_eq!(app.expanded_thinking.len(), 1);

    // Identical entry/block indices in another task must still start collapsed.
    app.selected = Some("agent-1".into());
    app.desk.transcripts.insert(
        "agent-1".into(),
        pi_desk::transcript::Transcript::from_messages(messages.iter()),
    );
    assert!(ui(&app).find(thinking.as_str()).is_err());
    assert!(!app.expanded_thinking.contains(&("agent-1".into(), 0, 2)));
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
    assert!(ui(&app).find(thinking.as_str()).is_err());
    click(&mut app, "Thinking");
    ui(&app).find(thinking.as_str()).unwrap();
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
        ui(&app).find(completed.as_str()).unwrap();
        assert_eq!(app.expanded_thinking.len(), 1);
    }
    click(&mut app, "Thinking");
    assert!(ui(&app).find(completed.as_str()).is_err());
    assert!(app.expanded_thinking.is_empty());
    app.desk.transcripts.insert(
        "agent-4".into(),
        pi_desk::transcript::Transcript::from_messages([&final_message]),
    );
    assert!(ui(&app).find(completed.as_str()).is_err());
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
    assert!(ui(&app).find("Fix the crash").is_ok());
    snapshot(&app, "transcript");

    key(&mut app, "d");
    let diff = "diff --git a/src/main.rs b/src/main.rs\n--- a/src/main.rs\n+++ b/src/main.rs\n@@ -1 +1,2 @@\n-fn main() {}\n+fn main() {\n+    println!(\"hello\");\n";
    let _ = app.update(Message::DiffLoaded(id, Ok(diff.into())));
    assert!(ui(&app).find("src/main.rs").is_ok());
    let line = ui(&app)
        .find(iced_test::selector::id("diff-line-0"))
        .unwrap();
    let visible = line.visible_bounds().expect("diff code must be visible");
    assert!(visible.width > 80.0, "diff line collapsed: {visible:?}");
    snapshot(&app, "diff");
}

#[test]
fn the_inbox_puts_latest_activity_first_and_opens_the_first_card() {
    let dir = tempfile::tempdir().unwrap();
    let app = seeded(dir.path());
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
    assert_eq!(app.inbox_count(), 4);
    let mut ui = ui(&app);
    for text in [
        "NEEDS YOU",
        "Merge",
        "Send back with a reply",
        "Guarded the nil session.",
        "Transcript",
    ] {
        assert!(ui.find(text).is_ok(), "{text:?} should be visible");
    }
    snapshot(&app, "inbox");
}

#[test]
fn question_cards_show_numbered_choices_and_a_click_answers() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = seeded(dir.path());
    key(&mut app, "j");
    assert_eq!(app.selected.as_deref(), Some("agent-1"));
    {
        let mut ui = ui(&app);
        assert!(ui.find("recommended").is_ok());
        assert!(ui.find("Make it configurable").is_ok());
    }
    snapshot(&app, "question");
    click(&mut app, "512 entries");
    let agent = app.desk.state.agent("agent-1").unwrap();
    assert!(agent.question.is_none());
    // The process is gone, so the answer waits as a prompt for the next run.
    assert_ne!(agent.status, Status::Question);
    assert!(!app.rows().iter().any(|row| row.id == "agent-1"));
    // The next row takes its place.
    assert_eq!(app.selected.as_deref(), Some("agent-2"));
}

#[test]
fn later_snoozes_and_undo_restores() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = seeded(dir.path());
    key(&mut app, "l");
    assert!(matches!(app.overlay, Some(Overlay::Later(_))));
    snapshot(&app, "later");
    key(&mut app, "3");
    assert!(app.overlay.is_none());
    assert!(app.desk.state.agent("agent-4").unwrap().snoozed(now()));
    assert!(!app.rows().iter().any(|row| row.id == "agent-4"));
    key(&mut app, "z");
    assert!(!app.desk.state.agent("agent-4").unwrap().snoozed(now()));
}

#[test]
fn merge_and_discard_wait_out_an_undo_window() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = seeded(dir.path());
    key(&mut app, "e");
    assert_eq!(app.pending.len(), 1);
    assert!(!app.rows().iter().any(|row| row.id == "agent-4"));
    {
        let mut ui = ui(&app);
        assert!(ui.find("Undo").is_ok());
    }
    snapshot(&app, "undo-bar");
    key(&mut app, "z");
    assert!(app.pending.is_empty());
    assert_eq!(app.selected.as_deref(), Some("agent-4"));

    key(&mut app, "x");
    assert!(matches!(app.overlay, Some(Overlay::ConfirmDiscard(_))));
    snapshot(&app, "discard");
    key(&mut app, "enter");
    assert_eq!(app.pending.len(), 1);
    key(&mut app, "z");
    assert!(app.pending.is_empty());
    assert_eq!(
        app.desk.state.agent("agent-4").unwrap().status,
        Status::Review
    );
}

#[test]
fn the_composer_previews_a_list_and_files_one_task_per_item() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = seeded(dir.path());
    click(&mut app, "New task");
    let Some(Overlay::Composer(composer)) = &mut app.overlay else {
        panic!("composer should open")
    };
    composer.content = iced::widget::text_editor::Content::with_text(
        "In the API:\n- Add retries\n- Log slow queries\n- Remove the dead flag",
    );
    {
        let mut ui = ui(&app);
        assert!(ui.find("Files 3 tasks, one agent each:").is_ok());
        assert!(ui.find("Merges into main").is_ok());
    }
    snapshot(&app, "composer");
    let before = app.desk.state.agents.len();
    let _ = app.update(Message::ComposerSubmit);
    assert!(app.overlay.is_none());
    let filed: Vec<&Agent> = app.desk.state.agents[before..].iter().collect();
    assert_eq!(
        filed
            .iter()
            .map(|agent| agent.title.as_str())
            .collect::<Vec<_>>(),
        ["Add retries", "Log slow queries", "Remove the dead flag"]
    );
    assert!(
        filed
            .iter()
            .all(|agent| agent.prompt.starts_with("In the API:") && agent.base_branch == "main")
    );
}

#[test]
fn board_focus_palette_and_project_views_render() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = seeded(dir.path());
    key(&mut app, "b");
    assert!(app.board);
    {
        let mut ui = ui(&app);
        for column in ["Queued", "Needs you", "Done"] {
            assert!(
                ui.find(iced_test::selector::id(format!("board-heading-{column}")))
                    .is_ok(),
                "{column:?} column"
            );
        }
    }
    snapshot(&app, "board");
    key(&mut app, "b");
    key(&mut app, "f");
    assert!(app.focus);
    snapshot(&app, "focus");
    key(&mut app, "escape");
    assert!(!app.focus);

    let _ = app.update(Message::Key {
        key: Key::Character("k".into()),
        modifiers: Modifiers::COMMAND,
        captured: false,
    });
    let _ = app.update(Message::PaletteQuery("prior hi".into()));
    let labels: Vec<String> = app
        .palette_matches()
        .into_iter()
        .map(|command| command.label)
        .collect();
    assert_eq!(labels, ["Priority: High"]);
    snapshot(&app, "palette");
    key(&mut app, "escape");

    let _ = app.update(Message::Show(View::Project("p2".into())));
    let titles: Vec<&str> = app
        .rows()
        .iter()
        .map(|agent| agent.title.as_str())
        .collect();
    assert_eq!(titles, ["Fix the login crash", "Update the README badges"]);
    let _ = app.update(Message::Key {
        key: Key::Named(Named::ArrowUp),
        modifiers: Modifiers::ALT,
        captured: false,
    });
    assert_eq!(app.desk.state.projects[0].id, "p2");
    snapshot(&app, "project");
}
