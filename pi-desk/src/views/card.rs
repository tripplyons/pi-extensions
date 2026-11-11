use super::{ago, chip, faint, ghost, icon, key, keys, label, mono, send, strong};
use crate::app::{App, Message, choices};
use crate::goal::GoalStatus;
use crate::icon::{Icon, KeyPart};
use crate::model::{Agent, QuestionKind, Status, Workspace};
use crate::text::one_line;
use crate::theme::{self, P, size};
use crate::vim::Target;
use rune::{Color, El, KeyEvent, ScrollSpec, Tx, auto_grow, col, el, row, text, text_input};

fn action(key_name: &str, hint: &'static str, name: &str, message: Message) -> El {
    ghost(key_name, name, &[KeyPart::Text(hint)], message)
}

/// The vim mode label and pending keys shown under a box.
pub fn mode(vim: &crate::vim::Vim) -> El {
    let pending = vim.pending();
    let name = if pending.is_empty() {
        vim.mode.label().to_string()
    } else {
        format!("{}  {pending}", vim.mode.label())
    };
    mono(name, size::CAPTION, P.muted).key("vim-mode")
}

/// Hands a box's keys to the app before the field edits.
pub fn box_keys(target: Target) -> impl Fn(&mut App, &KeyEvent, &mut Tx) -> bool + 'static {
    move |app: &mut App, event: &KeyEvent, tx: &mut Tx| match app.box_key(target, event) {
        Some(task) => {
            app.start(task);
            app.flush(tx);
            true
        }
        None => false,
    }
}

/// A multi-line editing box's frame and colors.
pub fn editor(field: El, normal_mode: bool, min_lines: usize, max_lines: usize) -> El {
    let field = field
        .w_full()
        .color(P.text)
        .caret(
            P.text,
            if normal_mode {
                P.block_cursor
            } else {
                P.selection
            },
        );
    // The textbox role sends a press anywhere in the frame, including the
    // empty lines below the text, to the field.
    col()
        .w_full()
        .padding(10.0)
        .radius(8.0)
        .fill(P.window)
        .border(1.0, P.border)
        .role("textbox")
        .child(auto_grow(field, min_lines, max_lines))
}

fn hint(key_name: &str, parts: &[KeyPart<'_>], what: &str) -> El {
    row()
        .key(key_name)
        .gap(5.0)
        .center_y()
        .child(keys(parts))
        .child(faint(what))
}

fn reply_editor(app: &App, placeholder: &'static str) -> El {
    let vim = app.desk.state.settings.vim_mode;
    let field = text_input(&app.reply, theme::sans(size::BODY))
        .key("reply")
        .placeholder(placeholder, P.faint)
        .on_edit(|app: &mut App| &mut app.reply)
        .on_input_key(box_keys(Target::Reply))
        .on_input_change(|app: &mut App, tx: &mut Tx| app.dispatch(Message::ReplyEdited, tx))
        .on_submit(|app: &mut App, tx: &mut Tx| app.dispatch(Message::SendReply, tx));
    let esc = if vim && !app.reply_vim.idle() {
        "normal mode"
    } else {
        "cancels"
    };
    let mut hints = row()
        .key("reply-hints")
        .w_full()
        .gap(16.0)
        .center_y()
        .child(hint("h-send", &[KeyPart::Text("Enter")], "sends"))
        .child(hint("h-line", &[KeyPart::Text("Shift+Enter")], "adds a line"))
        .child(hint("h-esc", &[KeyPart::Text("Esc")], esc));
    if vim {
        hints = hints
            .child(el().key("spacer").grow(1.0))
            .child(mode(&app.reply_vim));
    }
    col()
        .key("reply-box")
        .w_full()
        .gap(6.0)
        .child(editor(
            field,
            vim && app.reply_vim.mode == crate::vim::Mode::Normal,
            4,
            10,
        ))
        .child(hints)
}

/// Equal line metrics keep labels aligned with the first line of wrapped values.
fn summary_line(name: &'static str, value: &str) -> El {
    row()
        .key(format!("summary-{name}"))
        .w_full()
        .gap(8.0)
        .items_start()
        .child(label(name, size::BODY, P.muted).w(52.0))
        .child(
            label(value, size::BODY, P.text)
                .key(format!("summary-value-{name}"))
                .wrap()
                .grow(1.0)
                .shrink()
                .selectable(true),
        )
}

/// The task's unfinished goal.
pub fn goal_block(app: &App, agent: &Agent) -> Option<El> {
    let goal = app.goal(&agent.id)?;
    let (status_color, status) = match goal.status {
        GoalStatus::Active => (P.green, "Active"),
        _ => (P.amber, goal.status.label()),
    };
    Some(
        col()
            .key("goal")
            .w_full()
            .gap(6.0)
            .padding(12.0)
            .radius(8.0)
            .fill(P.accent_soft)
            .border(1.0, P.accent.alpha(0.25))
            .child(
                row()
                    .key("goal-head")
                    .gap(8.0)
                    .center_y()
                    .child(icon(Icon::Target, 14.0, P.accent))
                    .child(text("Goal").font(theme::medium(size::CONTROL)).color(P.text))
                    .child(chip(status, status_color).key("goal-status")),
            )
            .child(
                label(goal.objective.as_str(), size::BODY, P.text)
                    .key("goal-objective")
                    .wrap()
                    .selectable(true),
            ),
    )
}

/// The swarm root's active agents, nested by parent.
pub fn swarm_section(app: &App, agent: &Agent) -> Option<El> {
    let workers = app.workers(&agent.id);
    if workers.is_empty() {
        return None;
    }
    let mut list = col().key("workers").w_full().gap(2.0);
    for worker in workers {
        let status_color = match worker.status.as_str() {
            "running" => P.green,
            "review" => P.amber,
            _ => P.muted,
        };
        let mut line = row()
            .key(format!("worker-{}", worker.id))
            .w_full()
            .h(26.0)
            .pl(8.0 + worker.level as f32 * 16.0)
            .pr(8.0)
            .gap(8.0)
            .center_y()
            .radius(6.0)
            .hover(P.hover)
            .child(el().w(6.0).h(6.0).radius(3.0).fill(status_color))
            .child(
                text(worker.name.as_str())
                    .font(theme::medium(size::CONTROL))
                    .color(P.text)
                    .shrink()
                    .truncate(),
            )
            .child(label(worker.status.as_str(), size::CAPTION, status_color));
        if let Some(activity) = &worker.activity {
            line = line.child(label(activity.as_str(), size::CAPTION, P.muted).shrink().truncate());
        }
        line = line.child(el().grow(1.0));
        if let Some(model) = &worker.model {
            line = line.child(mono(model.as_str(), size::CAPTION - 1.0, P.faint).shrink().truncate_head());
        }
        list = list.child(line);
    }
    let count = workers.len();
    Some(
        col()
            .key("swarm")
            .w_full()
            .gap(6.0)
            .child(
                row()
                    .key("swarm-head")
                    .gap(8.0)
                    .center_y()
                    .child(icon(Icon::Users, 14.0, P.muted))
                    .child(text("Swarm").font(theme::medium(size::CONTROL)).color(P.text))
                    .child(faint(format!(
                        "{count} active {}",
                        if count == 1 { "agent" } else { "agents" }
                    ))),
            )
            .child(
                col()
                    .key("workers-scroll")
                    .w_full()
                    .max_h(180.0)
                    .scroll(ScrollSpec { stick_bottom: false })
                    .child(list),
            ),
    )
}

pub fn view(app: &App) -> El {
    let Some(agent) = app.current() else {
        return el();
    };
    let state = &app.desk.state;
    let project = state
        .project(&agent.project_id)
        .map(|project| project.name.as_str())
        .unwrap_or("");

    let mut header = col()
        .key("card-header")
        .w_full()
        .gap(6.0)
        .child(
            row()
                .key("project-line")
                .w_full()
                .gap(12.0)
                .center_y()
                .child(faint(project).grow(1.0).shrink().truncate())
                .child(chip(agent.status.label(), status_color(&agent.status)).key("status")),
        )
        .child(
            row()
                .key("branch-line")
                .w_full()
                .gap(12.0)
                .items_start()
                .child(
                    mono(
                        match &agent.workspace {
                            Workspace::Worktree { branch, .. } => branch.clone(),
                            Workspace::Main { .. } => {
                                format!("{} (main checkout)", agent.base_branch)
                            }
                            Workspace::Folder { .. } => "Folder (no Git)".into(),
                        },
                        size::CAPTION,
                        P.faint,
                    )
                    .grow(1.0)
                    .shrink()
                    .min_w(0.0)
                    // Branches stay readable in full; long ones wrap.
                    .wrap_anywhere(),
                )
                .child(faint(format!("started {} ago", ago(app.now, agent.created_at)))),
        );
    if let Some(busy) = app.desk.busy(&agent.id) {
        header = header.child(
            label(format!("{}…", busy.label()), size::CAPTION, P.muted).key("busy"),
        );
    }

    let mut body = col()
        .key("card-body")
        .w_full()
        .gap(12.0)
        .child(header)
        .child(
            strong(agent.title.as_str(), size::TITLE, P.text)
                .key("title")
                .wrap()
                .selectable(true),
        );

    if let Some(goal) = goal_block(app, agent) {
        body = body.child(goal);
    }
    if let Some(swarm) = swarm_section(app, agent) {
        body = body.child(swarm);
    }

    if !agent.status.is_done() {
        body = body.child(super::session::controls(app, Some(agent.id.clone())));
    } else {
        let settings = &agent.session_settings;
        body = body.child(
            row()
                .key("settings-line")
                .gap(24.0)
                .child(faint(format!(
                    "Model: {}",
                    settings
                        .model
                        .as_ref()
                        .map(ToString::to_string)
                        .unwrap_or_else(|| "Pi default".into())
                )))
                .child(faint(format!(
                    "Effort: {}",
                    settings.effort.as_deref().unwrap_or("Pi default")
                ))),
        );
    }

    if let Some(note) = &agent.note {
        body = body.child(label(note.as_str(), size::CONTROL, P.muted).key("note").wrap());
    }

    if let Some(summary) = &agent.summary {
        let mut lines = col()
            .key("summary")
            .w_full()
            .gap(4.0)
            .child(summary_line("Did", &summary.did));
        if !summary.needs.is_empty() {
            lines = lines.child(summary_line("Needs", &summary.needs));
        }
        body = body.child(lines);
    }

    match &agent.status {
        Status::Question => {
            if let Some(question) = &agent.question {
                body = body.child(
                    col()
                        .key("question")
                        .w_full()
                        .max_h(220.0)
                        .scroll(ScrollSpec { stick_bottom: false })
                        .child(
                            label(question.text.as_str(), size::BODY, P.text)
                                .wrap()
                                .selectable(true),
                        ),
                );
                if question.request_id.is_none() || !app.desk.is_live(&agent.id) {
                    body = body.child(faint("The agent stopped while waiting. Your answer starts it again with the answer as a prompt.").key("question-note").wrap());
                } else if question.kind == QuestionKind::Select {
                    body = body.child(faint("This dialog takes a choice. A reply dismisses it and steers the agent instead.").key("question-note").wrap());
                }
            }
        }
        Status::Failed { error } => {
            body = body.child(
                col()
                    .key("failure")
                    .w_full()
                    .max_h(160.0)
                    .padding(10.0)
                    .radius(8.0)
                    .fill(P.red.alpha(0.08))
                    .border(1.0, P.red.alpha(0.25))
                    .scroll(ScrollSpec { stick_bottom: false })
                    .child(
                        mono(error.as_str(), size::CAPTION, P.red)
                            .wrap_anywhere()
                            .selectable(true),
                    ),
            );
        }
        Status::Working | Status::Queued => {
            body = body.child(
                label(
                    one_line(&super::list::subtitle(app, agent), 240),
                    size::CONTROL,
                    P.muted,
                )
                .key("status-line")
                .wrap()
                .max_lines(2),
            );
        }
        _ => {}
    }

    let options = choices(agent);
    let mut question_choices = None;
    if !options.is_empty() {
        let mut list = col().key("choices").w_full().gap(6.0);
        for (index, choice) in options.iter().enumerate().take(9) {
            let mut line = row()
                .key(format!("choice-{index}"))
                .w_full()
                .px(12.0)
                .py(8.0)
                .gap(8.0)
                .center_y()
                .radius(8.0)
                .border(
                    1.0,
                    if choice.recommended {
                        P.accent.alpha(0.45)
                    } else {
                        P.border
                    },
                )
                .fill(if choice.recommended {
                    P.accent_soft
                } else {
                    Color::TRANSPARENT
                })
                .hover(P.hover)
                .press(P.press)
                .motion(theme::SNAPPY)
                .label(choice.label.as_str())
                .role("button")
                .on_press_tx(send(Message::Choose(index)))
                .child(mono((index + 1).to_string(), size::CAPTION, P.muted).w(18.0))
                .child(
                    label(choice.label.as_str(), size::BODY, P.text)
                        .wrap()
                        .grow(1.0)
                        .shrink(),
                );
            if choice.recommended {
                line = line.child(faint("recommended")).child(key("E"));
            }
            list = list.child(line);
        }
        if agent.status == Status::Question {
            question_choices = Some(
                col()
                    .key("question-choices")
                    .w_full()
                    .max_h(240.0)
                    .min_h(60.0)
                    .shrink()
                    .scroll(ScrollSpec {
                        stick_bottom: false,
                    })
                    .scroll_edge_fade(8.0)
                    .child(list.px(20.0).py(8.0)),
            );
        } else {
            body = body.child(list);
        }
    }

    // Question choices and reply controls stay outside the message scroll.
    // Long choices scroll independently, so the question cannot hide them.
    let footer = if app.replying {
        let placeholder = match agent.status {
            Status::Question => "Answer in your own words",
            Status::Working => "Steer the agent; it reads this after its current step",
            Status::Queued => "Add to the message the agent receives when it starts",
            Status::Done { .. } => "Reopen the task; the agent picks up where it left off",
            _ => "Tell the agent what to change; it picks up where it left off",
        };
        reply_editor(app, placeholder)
    } else {
        let mut actions = row()
            .key("actions")
            .gap(8.0)
            .child(action("reply-action", "R", "Reply", Message::StartReply));
        if !agent.status.is_done() {
            actions = actions
                .child(action("later-action", "L", "Later", Message::OpenLater))
                .child(action("discard-action", "X", "Discard", Message::Discard));
        }
        actions
    };

    col()
        .key(format!("card-{}", agent.id))
        .w_full()
        .max_h(620.0)
        .shrink()
        .min_h(0.0)
        .radius(12.0)
        .fill(P.surface)
        .border(1.0, P.border)
        .shadow(4.0, 16.0, P.shadow)
        .child(
            col()
                .key("card-scroll")
                .w_full()
                .shrink()
                .min_h(0.0)
                .scroll(ScrollSpec { stick_bottom: false })
                .scroll_edge_fade(12.0)
                .child(body.padding(20.0).pb(12.0)),
        )
        .children(question_choices)
        .child(
            col()
                .key("card-footer")
                .w_full()
                .px(20.0)
                .pt(0.0)
                .pb(20.0)
                .child(footer),
        )
}

/// The color that marks a status in chips and dots.
pub fn status_color(status: &Status) -> Color {
    match status {
        Status::Question | Status::Review => P.amber,
        Status::Failed { .. } => P.red,
        Status::Working => P.green,
        Status::Queued => P.muted,
        Status::Done { .. } => P.faint,
    }
}
