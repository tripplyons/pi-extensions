use super::{faint, key, keys, muted};
use crate::app::{App, COMPOSER_ID, LATER_ID, Message, Overlay, PALETTE_ID, PROJECT_SEARCH_ID};
use crate::compose;
use crate::icon::{COMMAND, Icon, KeyPart, RETURN};
use crate::later::Preset;
use crate::text::one_line;
use crate::theme::{self, BOLD, MONO, MUTED, RED};
use iced::keyboard::{Key, key::Named};
use iced::widget::{
    Space, button, checkbox, column, container, pick_list, row, scrollable, text, text_editor,
    text_input,
};
use iced::{Alignment, Element, Fill};

fn sheet<'a>(width: u32, content: impl Into<Element<'a, Message>>) -> Element<'a, Message> {
    container(content)
        .width(width)
        .padding(20)
        .style(theme::sheet)
        .into()
}

fn title<'a>(label: &'a str) -> Element<'a, Message> {
    text(label).size(theme::size::HEADING).font(BOLD).into()
}

fn error<'a>(message: &'a Option<String>) -> Element<'a, Message> {
    match message {
        Some(message) => text(message.as_str())
            .size(theme::size::CAPTION)
            .color(RED)
            .into(),
        None => Space::new().into(),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ProjectOption {
    id: String,
    name: String,
}

impl std::fmt::Display for ProjectOption {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.name)
    }
}

pub fn view(app: &App) -> Option<Element<'_, Message>> {
    let overlay = app.overlay.as_ref()?;
    Some(match overlay {
        Overlay::Composer(composer) => {
            let options: Vec<ProjectOption> = app
                .desk
                .state
                .projects
                .iter()
                .map(|project| ProjectOption {
                    id: project.id.clone(),
                    name: project.name.clone(),
                })
                .collect();
            let selected = options
                .iter()
                .find(|option| Some(&option.id) == composer.project.as_ref())
                .cloned();
            let drafts = compose::split(&composer.content.text());
            let mut preview = column![].spacing(4);
            if drafts.len() > 1 {
                preview = preview.push(muted(format!(
                    "Files {} tasks, one agent each:",
                    drafts.len()
                )));
                for (index, draft) in drafts.iter().take(12).enumerate() {
                    preview = preview.push(
                        row![
                            text(format!("{}.", index + 1))
                                .size(theme::size::CONTROL)
                                .color(MUTED),
                            text(one_line(&draft.title, 80)).size(theme::size::CONTROL)
                        ]
                        .spacing(8),
                    );
                }
                if drafts.len() > 12 {
                    preview = preview.push(faint(format!("and {} more", drafts.len() - 12)));
                }
            } else if let Some(draft) = drafts.first() {
                preview = preview.push(muted(format!(
                    "Files one task: {}",
                    one_line(&draft.title, 80)
                )));
            }
            let base = match (&composer.base, composer.use_worktree) {
                (Ok(branch), true) => format!("Merges into {branch}"),
                (Ok(branch), false) => format!("Works in the main checkout on {branch}"),
                (Err(error), _) => error.clone(),
            };
            let use_worktree = composer.use_worktree;
            let editor = text_editor(&composer.content)
                .id(COMPOSER_ID)
                .placeholder(
                    "Describe the work. A bulleted or numbered list files one task per item.",
                )
                .on_action(Message::ComposerEdit)
                .height(180)
                .padding(12)
                .size(theme::size::BODY)
                .style(theme::editor)
                .key_binding(move |press| match press.key.as_ref() {
                    Key::Named(Named::Enter) if press.modifiers.command() => {
                        Some(text_editor::Binding::Custom(Message::ComposerSubmit))
                    }
                    Key::Named(Named::Escape) => {
                        Some(text_editor::Binding::Custom(Message::CloseOverlay))
                    }
                    Key::Character("e")
                        if press.modifiers.command()
                            && !press.modifiers.shift()
                            && !press.modifiers.alt() =>
                    {
                        Some(text_editor::Binding::Custom(Message::ComposerWorktree(
                            !use_worktree,
                        )))
                    }
                    Key::Character("p")
                        if press.modifiers.command()
                            && !press.modifiers.shift()
                            && !press.modifiers.alt() =>
                    {
                        Some(text_editor::Binding::Custom(Message::ComposerProjectSearch))
                    }
                    _ => crate::composer_edit::binding(press),
                });
            let count = drafts.len().max(1);
            let search: Option<Element<'_, Message>> = match &composer.project_search {
                None => None,
                Some(search) => {
                    let mut list = column![].spacing(1);
                    let matches = app.project_matches();
                    if matches.is_empty() {
                        list = list.push(faint("No matching projects"));
                    }
                    for (index, id) in matches.iter().enumerate() {
                        let name = app
                            .desk
                            .state
                            .projects
                            .iter()
                            .find(|project| &project.id == id)
                            .map(|project| project.name.as_str())
                            .unwrap_or_default();
                        list = list.push(
                            button(text(name).size(theme::size::CONTROL).width(Fill))
                                .width(Fill)
                                .padding([6, 10])
                                .style(theme::row(index == search.selected))
                                .on_press(Message::ComposerProjectPick(index)),
                        );
                    }
                    Some(
                        column![
                            text_input("Search projects", &search.query)
                                .id(PROJECT_SEARCH_ID)
                                .on_input(Message::ComposerProjectQuery)
                                .padding(8)
                                .size(theme::size::CONTROL)
                                .style(theme::input),
                            scrollable(list)
                                .style(theme::scrollbar)
                                .height(iced::Length::Shrink),
                            row![
                                row![
                                    keys(&[
                                        KeyPart::Icon(Icon::ArrowUp),
                                        KeyPart::Text("/"),
                                        KeyPart::Icon(Icon::ArrowDown),
                                    ]),
                                    faint("navigate")
                                ]
                                .spacing(5),
                                row![key("Enter"), faint("choose")].spacing(5),
                                row![key("Esc"), faint("back")].spacing(5),
                            ]
                            .spacing(16)
                            .align_y(Alignment::Center),
                        ]
                        .spacing(8)
                        .into(),
                    )
                }
            };
            sheet(
                640,
                column![
                    title("New task"),
                    row![
                        pick_list(options, selected, |option: ProjectOption| {
                            Message::ComposerProject(option.id)
                        })
                        .text_size(theme::size::CONTROL)
                        .padding([5, 10]),
                        keys(&[COMMAND, KeyPart::Text("P")]),
                        Space::new().width(Fill),
                        row![
                            checkbox(composer.use_worktree)
                                .label("Use worktree")
                                .on_toggle(Message::ComposerWorktree)
                                .size(16)
                                .spacing(8)
                                .text_size(theme::size::CONTROL)
                                .style(theme::checkbox),
                            keys(&[COMMAND, KeyPart::Text("E")]),
                        ]
                        .spacing(6)
                        .align_y(Alignment::Center),
                    ]
                    .spacing(12)
                    .align_y(Alignment::Center),
                    search,
                    super::session::controls(app, None),
                    editor,
                    scrollable(preview)
                        .style(theme::scrollbar)
                        .height(iced::Length::Shrink),
                    error(&composer.error),
                    row![
                        faint(base),
                        Space::new().width(Fill),
                        button(
                            row![text("Cancel").size(theme::size::CONTROL), key("Esc")]
                                .spacing(6)
                                .align_y(Alignment::Center)
                        )
                        .style(theme::ghost)
                        .padding([6, 12])
                        .on_press(Message::CloseOverlay),
                        button(
                            row![
                                text(if count == 1 {
                                    "File task".to_string()
                                } else {
                                    format!("File {count} tasks")
                                })
                                .size(theme::size::CONTROL),
                                keys(&[COMMAND, RETURN]),
                            ]
                            .spacing(6)
                            .align_y(Alignment::Center)
                        )
                        .style(theme::primary)
                        .padding([6, 12])
                        .on_press_maybe(
                            (!composer.session.loading).then_some(Message::ComposerSubmit)
                        ),
                    ]
                    .spacing(8)
                    .align_y(Alignment::Center),
                ]
                .spacing(14),
            )
        }
        Overlay::Palette(palette) => {
            let matches = app.palette_matches();
            let mut list = column![].spacing(1);
            for (index, command) in matches.into_iter().enumerate() {
                let hint: Element<'_, Message> = if command.keys.is_empty() {
                    Space::new().into()
                } else {
                    keys(command.keys)
                };
                list = list.push(
                    button(
                        row![
                            text(command.label).size(theme::size::CONTROL).width(Fill),
                            hint
                        ]
                        .align_y(Alignment::Center),
                    )
                    .width(Fill)
                    .padding([7, 10])
                    .style(theme::row(index == palette.selected))
                    .on_press(Message::PaletteRun(index)),
                );
            }
            sheet(
                560,
                column![
                    text_input("Type a command", &palette.query)
                        .id(PALETTE_ID)
                        .on_input(Message::PaletteQuery)
                        .padding(10)
                        .size(theme::size::BODY)
                        .style(theme::input),
                    scrollable(list)
                        .style(theme::scrollbar)
                        .height(iced::Length::Shrink),
                    row![
                        row![
                            keys(&[
                                KeyPart::Icon(Icon::ArrowUp),
                                KeyPart::Text("/"),
                                KeyPart::Icon(Icon::ArrowDown),
                            ]),
                            faint("navigate")
                        ]
                        .spacing(5),
                        row![key("Enter"), faint("run")].spacing(5),
                        row![key("Esc"), faint("close")].spacing(5),
                    ]
                    .spacing(16)
                    .align_y(Alignment::Center),
                ]
                .spacing(10)
                .height(iced::Length::Shrink)
                .max_width(560),
            )
        }
        Overlay::Later(picker) => {
            let mut list = column![].spacing(4);
            for (index, preset) in Preset::ALL.iter().enumerate() {
                list = list.push(
                    button(
                        row![
                            container(
                                text((index + 1).to_string())
                                    .size(theme::size::CAPTION)
                                    .font(MONO)
                                    .color(MUTED)
                            )
                            .width(18),
                            text(preset.label()).size(theme::size::BODY)
                        ]
                        .spacing(8),
                    )
                    .width(Fill)
                    .padding([8, 12])
                    .style(theme::choice(false))
                    .on_press(Message::LaterPreset(*preset)),
                );
            }
            let snoozed = app
                .desk
                .state
                .agent(&picker.agent)
                .is_some_and(|agent| agent.snooze_until.is_some());
            let mut body = column![
                title("Later"),
                muted("The row leaves the inbox until then. Queued work waits to start."),
                list,
                text_input("Or type 30m, 3h, 2d, or 14:30", &picker.custom)
                    .id(LATER_ID)
                    .on_input(Message::LaterCustom)
                    .on_submit(Message::LaterSubmit)
                    .padding(10)
                    .size(theme::size::BODY)
                    .style(theme::input),
                row![
                    row![key("Enter"), faint("apply typed time")].spacing(5),
                    row![key("Esc"), faint("cancel")].spacing(5),
                ]
                .spacing(16)
                .align_y(Alignment::Center),
                error(&picker.error),
            ]
            .spacing(12);
            if snoozed {
                body = body.push(
                    button(text("Wake now").size(theme::size::CONTROL))
                        .style(theme::ghost)
                        .padding([6, 12])
                        .on_press(Message::WakeNow),
                );
            }
            sheet(440, body)
        }
        Overlay::Settings(form) => sheet(
            560,
            column![
                title("Settings"),
                column![
                    muted("Running agents at once"),
                    text_input("4", &form.slots)
                        .on_input(Message::SettingsSlots)
                        .padding(8)
                        .size(theme::size::BODY)
                        .style(theme::input)
                ]
                .spacing(6),
                column![
                    muted("Open in terminal ({path} is the task checkout)"),
                    text_input("open -a Terminal {path}", &form.terminal)
                        .on_input(Message::SettingsTerminal)
                        .padding(8)
                        .size(theme::size::CONTROL)
                        .font(MONO)
                        .style(theme::input)
                ]
                .spacing(6),
                column![
                    muted("Open in editor"),
                    text_input("code {path}", &form.editor)
                        .on_input(Message::SettingsEditor)
                        .on_submit(Message::SaveSettings)
                        .padding(8)
                        .size(theme::size::CONTROL)
                        .font(MONO)
                        .style(theme::input)
                ]
                .spacing(6),
                faint(format!(
                    "State and worktrees live in {}",
                    app.store.root().display()
                )),
                error(&form.error),
                row![
                    Space::new().width(Fill),
                    button(
                        row![text("Cancel").size(theme::size::CONTROL), key("Esc")]
                            .spacing(6)
                            .align_y(Alignment::Center)
                    )
                    .style(theme::ghost)
                    .padding([6, 12])
                    .on_press(Message::CloseOverlay),
                    button(text("Save").size(theme::size::CONTROL))
                        .style(theme::primary)
                        .padding([6, 12])
                        .on_press(Message::SaveSettings),
                ]
                .spacing(8),
            ]
            .spacing(14),
        ),
        Overlay::ConfirmDiscard(id) => {
            let agent = app.desk.state.agent(id);
            let name = agent
                .map(|agent| agent.title.as_str())
                .unwrap_or("this task");
            let effect = if agent.is_some_and(|agent| agent.workspace.is_main()) {
                "stops. Its changes stay in the main checkout"
            } else {
                "stops, and its worktree and branch are deleted"
            };
            sheet(
                440,
                column![
                    title("Discard this task?"),
                    text(format!("“{name}” {effect}. You have five seconds to undo."))
                        .size(theme::size::CONTROL),
                    row![
                        Space::new().width(Fill),
                        button(
                            row![text("Cancel").size(theme::size::CONTROL), key("Esc")]
                                .spacing(6)
                                .align_y(Alignment::Center)
                        )
                        .style(theme::ghost)
                        .padding([6, 12])
                        .on_press(Message::CloseOverlay),
                        button(
                            row![
                                text("Discard").size(theme::size::CONTROL),
                                key("X"),
                                key("Enter")
                            ]
                            .spacing(6)
                            .align_y(Alignment::Center)
                        )
                        .style(|theme: &iced::Theme, status| {
                            let mut style = theme::primary(theme, status);
                            style.background = Some(RED.into());
                            style
                        })
                        .padding([6, 12])
                        .on_press(Message::ConfirmDiscard),
                    ]
                    .spacing(8),
                ]
                .spacing(14),
            )
        }
    })
}
