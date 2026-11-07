use super::{ago, faint, key, list::subtitle, muted};
use crate::app::{App, Message, REPLY_ID, choices};
use crate::model::{QuestionKind, Status, Workspace};
use crate::text::one_line;
use crate::theme::{self, BOLD, FAINT, MONO, MUTED, RED};
use crate::vim::Target;
use iced::keyboard::{Key, key::Named};
use iced::widget::{Space, button, column, container, row, scrollable, text, text_editor};
use iced::{Alignment, Element, Fill};

fn action<'a>(hint: &'a str, label: &'a str, message: Message) -> Element<'a, Message> {
    button(
        row![text(label).size(theme::size::CONTROL), key(hint)]
            .spacing(6)
            .align_y(Alignment::Center),
    )
    .style(theme::ghost)
    .padding([5, 10])
    .on_press(message)
    .into()
}

/// The vim mode label and pending keys shown under a box.
pub fn mode<'a>(vim: &crate::vim::Vim) -> Element<'a, Message> {
    let pending = vim.pending();
    let label = if pending.is_empty() {
        vim.mode.label().to_string()
    } else {
        format!("{}  {pending}", vim.mode.label())
    };
    text(label)
        .size(theme::size::CAPTION)
        .font(MONO)
        .color(MUTED)
        .into()
}

fn reply_editor<'a>(app: &'a App, placeholder: &'static str) -> Element<'a, Message> {
    let vim = app.desk.state.settings.vim_mode;
    let escape = app.desk.state.settings.vim_escape.as_str();
    let editor = text_editor(&app.reply)
        .id(REPLY_ID)
        .placeholder(placeholder)
        .on_action(Message::ReplyEdit)
        .height(110)
        .padding(10)
        .size(theme::size::BODY)
        .style(theme::vim_editor(
            vim && app.reply_vim.mode == crate::vim::Mode::Normal,
        ))
        .key_binding(move |press| {
            let usual = |press: text_editor::KeyPress| match press.key.as_ref() {
                Key::Named(Named::Enter) if !press.modifiers.shift() => {
                    Some(text_editor::Binding::Custom(Message::SendReply))
                }
                Key::Named(Named::Escape) => {
                    Some(text_editor::Binding::Custom(Message::CancelReply))
                }
                _ => text_editor::Binding::from_key_press(press),
            };
            if vim {
                crate::vim::binding(press, Target::Reply, &app.reply_vim, escape, usual)
            } else {
                usual(press)
            }
        });
    let esc = if vim && !app.reply_vim.idle() {
        "normal mode"
    } else {
        "cancels"
    };
    let mut hints = row![
        row![key("Enter"), faint("sends")].spacing(5),
        row![key("Shift+Enter"), faint("adds a line")].spacing(5),
        row![key("Esc"), faint(esc)].spacing(5),
    ]
    .spacing(16)
    .align_y(Alignment::Center);
    if vim {
        hints = hints
            .push(Space::new().width(Fill))
            .push(mode(&app.reply_vim));
    }
    column![editor, hints].spacing(6).into()
}

/// Equal line metrics keep labels aligned with the first line of wrapped values.
fn summary_line<'a>(label: &'static str, value: &'a str) -> Element<'a, Message> {
    row![
        text(label)
            .size(theme::size::BODY)
            .line_height(iced::Pixels(20.0))
            .color(MUTED)
            .width(52),
        container(
            text(value)
                .size(theme::size::BODY)
                .line_height(iced::Pixels(20.0))
        )
        .width(Fill)
        .id(format!("summary-value-{label}")),
    ]
    .into()
}

pub fn view(app: &App) -> Element<'_, Message> {
    let Some(agent) = app.current() else {
        return Space::new().into();
    };
    let state = &app.desk.state;
    let project = state
        .project(&agent.project_id)
        .map(|project| project.name.as_str())
        .unwrap_or("");

    let mut header = column![
        row![
            faint(project).width(Fill),
            text(agent.status.label())
                .size(theme::size::CAPTION)
                .color(MUTED),
        ]
        .spacing(12)
        .align_y(Alignment::Center),
        row![
            text(match &agent.workspace {
                Workspace::Worktree { branch, .. } => branch.clone(),
                Workspace::Main { .. } => format!("{} (main checkout)", agent.base_branch),
            })
            .size(theme::size::CAPTION)
            .font(MONO)
            .color(FAINT)
            .width(Fill),
            faint(format!("started {} ago", ago(app.now, agent.created_at))),
        ]
        .spacing(12)
        .align_y(Alignment::Start),
    ]
    .spacing(6);
    if let Some(busy) = app.desk.busy(&agent.id) {
        header = header.push(
            text(format!("{}…", busy.label()))
                .size(theme::size::CAPTION)
                .color(MUTED),
        );
    }

    let mut body = column![
        header,
        text(agent.title.as_str())
            .size(theme::size::TITLE)
            .font(BOLD)
    ]
    .spacing(12);

    if !agent.status.is_done() {
        body = body.push(super::session::controls(app, Some(agent.id.clone())));
    } else {
        let settings = &agent.session_settings;
        body = body.push(
            row![
                faint(format!(
                    "Model: {}",
                    settings
                        .model
                        .as_ref()
                        .map(ToString::to_string)
                        .unwrap_or_else(|| "Pi default".into())
                )),
                faint(format!(
                    "Effort: {}",
                    settings.effort.as_deref().unwrap_or("Pi default")
                )),
            ]
            .spacing(24),
        );
    }

    if let Some(note) = &agent.note {
        body = body.push(text(note.as_str()).size(theme::size::CONTROL).color(MUTED));
    }

    if let Some(summary) = &agent.summary {
        let mut lines = column![summary_line("Did", &summary.did)].spacing(4);
        if !summary.needs.is_empty() {
            lines = lines.push(summary_line("Needs", &summary.needs));
        }
        body = body.push(lines);
    }

    match &agent.status {
        Status::Question => {
            if let Some(question) = &agent.question {
                body = body.push(
                    container(
                        scrollable(text(question.text.as_str()).size(theme::size::BODY))
                            .style(theme::scrollbar)
                            .height(iced::Length::Shrink),
                    )
                    .max_height(220),
                );
                if question.request_id.is_none() || !app.desk.is_live(&agent.id) {
                    body = body.push(faint("The agent stopped while waiting. Your answer starts it again with the answer as a prompt."));
                } else if question.kind == QuestionKind::Select {
                    body = body.push(faint("This dialog takes a choice. A reply dismisses it and steers the agent instead."));
                }
            }
        }
        Status::Failed { error } => {
            body = body.push(
                container(
                    scrollable(
                        text(error.as_str())
                            .size(theme::size::CAPTION)
                            .font(MONO)
                            .color(RED),
                    )
                    .style(theme::scrollbar),
                )
                .padding(10)
                .max_height(160)
                .style(theme::panel),
            );
        }
        Status::Working | Status::Queued => {
            if app.focus {
                body = body.push(super::live_text::LiveText::new(
                    format!("{}:status", agent.id),
                    one_line(&subtitle(app, agent), 240),
                    false,
                ));
            } else {
                body = body
                    .push(muted(one_line(&subtitle(app, agent), 240)).size(theme::size::CONTROL));
            }
        }
        _ => {}
    }

    let options = choices(agent);
    if !options.is_empty() {
        let mut list = column![].spacing(6);
        for (index, choice) in options.iter().enumerate().take(9) {
            let number = (index + 1).to_string();
            let mut line = row![
                container(
                    text(number)
                        .size(theme::size::CAPTION)
                        .font(MONO)
                        .color(MUTED)
                )
                .width(18),
                text(choice.label.clone())
                    .size(theme::size::BODY)
                    .width(Fill),
            ]
            .spacing(8)
            .align_y(Alignment::Center);
            if choice.recommended {
                line = line.push(
                    row![faint("recommended"), key("E")]
                        .spacing(6)
                        .align_y(Alignment::Center),
                );
            }
            list = list.push(
                button(line)
                    .width(Fill)
                    .padding([8, 12])
                    .style(theme::choice(choice.recommended))
                    .on_press(Message::Choose(index)),
            );
        }
        body = body.push(list);
    }

    if app.replying {
        let placeholder = match agent.status {
            Status::Question => "Answer in your own words",
            Status::Working => "Steer the agent; it reads this after its current step",
            Status::Queued => "Add to the message the agent receives when it starts",
            Status::Done { .. } => "Reopen the task; the agent picks up where it left off",
            _ => "Tell the agent what to change; it picks up where it left off",
        };
        body = body.push(reply_editor(app, placeholder));
    } else {
        let mut actions = row![].spacing(8);
        actions = actions.push(action("R", "Reply", Message::StartReply));
        if !agent.status.is_done() {
            actions = actions.push(action("L", "Later", Message::OpenLater));
            actions = actions.push(action("X", "Discard", Message::Discard));
        }
        body = body.push(actions);
    }

    container(body)
        .padding(20)
        .width(Fill)
        .style(theme::card)
        .into()
}
