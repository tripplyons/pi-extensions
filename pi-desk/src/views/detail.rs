use super::{card, empty, faint, key};
use crate::app::{App, Message, Tab};
use crate::git::LineKind;
use crate::theme::{
    self, ACCENT, ADDED_BG, FAINT, GREEN, MONO, MUTED, RAISED, RED, REMOVED_BG, TEXT,
};
use crate::transcript::{AssistantBlock, Entry};
use iced::widget::{
    Space, button, column, container, markdown, rich_text, row, rule, scrollable, span, text,
};
use iced::{Alignment, Color, Element, Fill, Length};

const DIFF_LINE_LIMIT: usize = 4000;

/// The right pane in list layout: the card above its tabs.
pub fn pane(app: &App) -> Element<'_, Message> {
    let content: Element<'_, Message> = if app.desk.state.projects.is_empty() {
        container(
            column![
                text("Add a project to start").size(16).color(MUTED),
                faint("pi-desk files each task as a Pi agent in its own git worktree."),
                button(text("Add project").size(13))
                    .style(theme::primary)
                    .padding([6, 12])
                    .on_press(Message::AddProject),
            ]
            .spacing(10)
            .align_x(Alignment::Center),
        )
        .center(Fill)
        .into()
    } else if app.current().is_some() {
        column![card::view(app), view(app)].spacing(16).into()
    } else {
        empty("Nothing selected", "Choose a row, or press N to file work.")
    };
    container(content)
        .padding(20)
        .width(Fill)
        .height(Fill)
        .into()
}

fn tab<'a>(label: String, hint: &'a str, active: bool, message: Message) -> Element<'a, Message> {
    button(
        row![text(label).size(13), key(hint)]
            .spacing(6)
            .align_y(Alignment::Center),
    )
    .style(theme::tab(active))
    .padding([6, 4])
    .on_press(message)
    .into()
}

/// Tabs and their content below the card.
pub fn view(app: &App) -> Element<'_, Message> {
    let Some(agent) = app.current() else {
        return Space::new().into();
    };
    let diff = app.diffs.get(&agent.id);
    let counts = diff
        .and_then(|diff| diff.files.as_ref().ok())
        .filter(|files| !files.is_empty())
        .map(|files| {
            let added: usize = files.iter().map(|file| file.added).sum();
            let removed: usize = files.iter().map(|file| file.removed).sum();
            format!("Diff  +{added} −{removed}")
        })
        .unwrap_or_else(|| "Diff".into());
    let underline = |active: bool| {
        container(Space::new())
            .width(Fill)
            .height(2)
            .style(theme::fill(if active {
                ACCENT
            } else {
                Color::TRANSPARENT
            }))
    };
    let transcript_active = app.tab == Tab::Transcript;
    let tabs = row![
        column![
            tab(
                "Transcript".into(),
                "T",
                transcript_active,
                Message::SetTab(Tab::Transcript)
            ),
            underline(transcript_active)
        ]
        .width(Length::Shrink),
        column![
            tab(counts, "D", !transcript_active, Message::SetTab(Tab::Diff)),
            underline(!transcript_active)
        ]
        .width(Length::Shrink),
    ]
    .spacing(14)
    .align_y(Alignment::Center);

    let content = match app.tab {
        Tab::Transcript => transcript(app, &agent.id),
        Tab::Diff => diff_view(app, &agent.id),
    };
    column![tabs, rule::horizontal(1).style(super::divider), content]
        .spacing(0)
        .height(Fill)
        .into()
}

pub(super) fn markdown_settings() -> markdown::Settings {
    let mut style = markdown::Style::from_palette(theme::theme().palette());
    style.link_color = ACCENT;
    style.inline_code_color = TEXT;
    style.inline_code_highlight = markdown::Highlight {
        background: RAISED.into(),
        border: iced::Border {
            radius: 3.0.into(),
            ..iced::Border::default()
        },
    };
    markdown::Settings::with_text_size(14, style)
}

fn transcript<'a>(app: &'a App, id: &str) -> Element<'a, Message> {
    let Some(transcript) = app.desk.transcripts.get(id) else {
        return empty("No transcript yet", "It appears once the agent starts.");
    };
    if transcript.entries.is_empty() {
        return empty("No transcript yet", "It appears once the agent starts.");
    }
    let settings = markdown_settings();
    let mut entries = column![].spacing(12).padding([14, 4]);
    for entry in &transcript.entries {
        let element: Element<'a, Message> = match entry {
            Entry::User { text: message } => {
                container(column![faint("You"), text(message.as_str()).size(14)].spacing(4))
                    .padding(12)
                    .width(Fill)
                    .style(theme::panel)
                    .into()
            }
            Entry::Assistant {
                id: message_id,
                blocks,
                error,
                ..
            } => {
                let mut content = column![].spacing(6);
                for (block_index, block) in blocks {
                    match block {
                        AssistantBlock::Text { text, markdown } => {
                            if app
                                .current()
                                .is_some_and(|agent| agent.status == crate::model::Status::Working)
                                && std::ptr::eq(entry, transcript.entries.last().unwrap())
                            {
                                content = content.push(super::live_text::LiveText::new(
                                    format!("{id}:{message_id}:{block_index}"),
                                    text.clone(),
                                    true,
                                ));
                            } else {
                                content = content.push(
                                    markdown::view(markdown.items(), settings).map(Message::Link),
                                );
                            }
                        }
                        AssistantBlock::Thinking { text: thinking } => {
                            let open = app.expanded_thinking.contains(&(
                                id.to_string(),
                                *message_id,
                                *block_index,
                            ));
                            let head = button(
                                row![
                                    text(if open { "▾" } else { "▸" }).size(11).color(FAINT),
                                    text("Thinking").size(12).color(MUTED),
                                    text(super::line(thinking, 110))
                                        .size(12)
                                        .color(FAINT)
                                        .wrapping(text::Wrapping::None)
                                        .width(Fill),
                                ]
                                .spacing(8)
                                .align_y(Alignment::Center),
                            )
                            .width(Fill)
                            .padding([3, 6])
                            .style(theme::row(false))
                            .on_press(Message::ToggleThinking(
                                id.to_string(),
                                *message_id,
                                *block_index,
                            ));
                            content = content.push(head);
                            if open && !thinking.is_empty() {
                                content = content.push(
                                    container(text(thinking.as_str()).size(13).color(MUTED))
                                        .padding(10)
                                        .width(Fill)
                                        .style(theme::panel),
                                );
                            }
                        }
                    }
                }
                if let Some(error) = error {
                    content = content.push(text(error.as_str()).size(13).color(RED));
                }
                content.into()
            }
            Entry::Tool {
                id,
                name,
                preview,
                output,
                is_error,
                running,
            } => {
                let open = app.expanded.contains(id);
                let state = if *running {
                    "…"
                } else if *is_error {
                    "failed"
                } else {
                    ""
                };
                let head = button(
                    row![
                        text(if open { "▾" } else { "▸" }).size(11).color(FAINT),
                        text(name.as_str()).size(12).font(MONO).color(ACCENT),
                        text(super::line(preview, 110))
                            .size(12)
                            .font(MONO)
                            .color(MUTED)
                            .width(Fill),
                        text(state)
                            .size(11)
                            .color(if *is_error { RED } else { FAINT }),
                    ]
                    .spacing(8)
                    .align_y(Alignment::Center),
                )
                .width(Fill)
                .padding([3, 6])
                .style(theme::row(false))
                .on_press(Message::ToggleTool(id.clone()));
                if open && !output.is_empty() {
                    column![
                        head,
                        container(
                            text(output.as_str())
                                .size(12)
                                .font(MONO)
                                .color(if *is_error { RED } else { TEXT })
                        )
                        .padding(10)
                        .width(Fill)
                        .style(theme::panel)
                    ]
                    .spacing(4)
                    .into()
                } else {
                    head.into()
                }
            }
            Entry::Note { text: note } => faint(note.as_str()).into(),
        };
        entries = entries.push(element);
    }
    scrollable(entries)
        .style(theme::scrollbar)
        .anchor_bottom()
        .height(Fill)
        .into()
}

fn diff_view<'a>(app: &'a App, id: &str) -> Element<'a, Message> {
    let Some(diff) = app.diffs.get(id) else {
        return empty("No diff", "The worktree has not been created yet.");
    };
    let files = match &diff.files {
        Err(error) => return empty("Could not read the diff", error.as_str()),
        Ok(files) if files.is_empty() => {
            return empty(
                if diff.loading {
                    "Loading…"
                } else {
                    "No changes yet"
                },
                "",
            );
        }
        Ok(files) => files,
    };
    let mut list = column![].spacing(1);
    for (index, file) in files.iter().enumerate() {
        list = list.push(
            button(
                row![
                    text(file.path.as_str()).size(12).font(MONO).width(Fill),
                    text(format!("+{}", file.added)).size(11).color(GREEN),
                    text(format!("−{}", file.removed)).size(11).color(RED),
                ]
                .spacing(6),
            )
            .width(Fill)
            .padding([4, 8])
            .style(theme::row(index == diff.selected))
            .on_press(Message::SelectFile(index)),
        );
    }
    let file = &files[diff.selected.min(files.len() - 1)];
    let colors = diff.colors.get(diff.selected);
    let mut lines = column![];
    for (index, line) in file.lines.iter().enumerate().take(DIFF_LINE_LIMIT) {
        let (background, prefix, base) = match line.kind {
            LineKind::Added => (ADDED_BG, "+", GREEN),
            LineKind::Removed => (REMOVED_BG, "−", RED),
            LineKind::Context => (Color::TRANSPARENT, " ", TEXT),
            LineKind::Hunk => (Color { a: 0.08, ..ACCENT }, "", ACCENT),
            LineKind::Meta => (Color::TRANSPARENT, "", FAINT),
        };
        let mut spans: Vec<text::Span<'_, ()>> =
            vec![span(prefix.to_string()).color(base).font(MONO)];
        match colors
            .and_then(|colors| colors.get(index))
            .filter(|spans| !spans.is_empty())
        {
            Some(colored) => {
                for (range, color) in colored {
                    let piece = line.text.get(range.clone()).unwrap_or_default().to_string();
                    spans.push(span(piece).color(color.unwrap_or(TEXT)).font(MONO));
                }
            }
            None => spans.push(
                span(line.text.clone())
                    .color(if line.kind == LineKind::Context {
                        TEXT
                    } else {
                        base
                    })
                    .font(MONO),
            ),
        }
        lines = lines.push(
            container(rich_text(spans).size(12))
                .id(format!("diff-line-{index}"))
                .padding([0, 10])
                .style(theme::fill(background)),
        );
    }
    if file.lines.len() > DIFF_LINE_LIMIT {
        lines = lines.push(
            container(faint(format!(
                "{} more lines. Open the editor to see the rest.",
                file.lines.len() - DIFF_LINE_LIMIT
            )))
            .padding(10),
        );
    }
    row![
        scrollable(list)
            .style(theme::scrollbar)
            .width(240)
            .height(Fill),
        rule::vertical(1).style(super::divider),
        scrollable(lines.padding([8, 0]))
            .style(theme::scrollbar)
            .direction(scrollable::Direction::Both {
                vertical: Default::default(),
                horizontal: Default::default()
            })
            .width(Fill)
            .height(Fill),
    ]
    .height(Fill)
    .into()
}
