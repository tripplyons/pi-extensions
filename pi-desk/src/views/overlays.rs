use super::{faint, ghost, keys, label, mono, muted, primary, send, strong, with_layer};
use crate::app::{App, Field, Message, Overlay};
use crate::compose;
use crate::icon::{COMMAND, Icon, KeyPart, RETURN};
use crate::later::Preset;
use crate::text::one_line;
use crate::theme::{self, KIT, P, size};
use crate::vim::Target;
use rune::{El, KeyEvent, ScrollSpec, TextStyle, Tx, col, el, row, text_input};
use rune_kit::{Checkbox, Select, SelectAppearance};

const NAVIGATE: &[KeyPart<'static>] = &[
    KeyPart::Icon(Icon::ArrowUp),
    KeyPart::Text("/"),
    KeyPart::Icon(Icon::ArrowDown),
];

fn sheet(key: &str, width: f32, content: El) -> El {
    content
        .key(key)
        .w(width)
        .padding(20.0)
        .gap(14.0)
        .radius(12.0)
        .fill(P.surface)
        .border(1.0, P.border)
        .shadow(16.0, 48.0, P.shadow)
        // Presses inside the sheet must not reach the scrim, which closes it.
        .on_press(|_: &mut App| {})
        .transition(
            rune::Transition::scale(0.97).combined(rune::Transition::opacity()),
        )
}

fn title(content: &str) -> El {
    strong(content, size::HEADING, P.text).key("title")
}

fn error(key: &str, message: &Option<String>) -> Option<El> {
    message
        .as_ref()
        .map(|message| label(message.as_str(), size::CAPTION, P.red).key(key).wrap())
}

fn hint(key: &str, parts: &[KeyPart<'_>], what: &str) -> El {
    row()
        .key(key)
        .gap(5.0)
        .center_y()
        .child(keys(parts))
        .child(faint(what))
}

fn hints(items: Vec<El>) -> El {
    row().key("hints").gap(16.0).center_y().children(items)
}

/// Lets the app see a field's arrows, Return, and Escape first.
fn overlay_keys(app: &mut App, event: &KeyEvent, tx: &mut Tx) -> bool {
    match app.on_key(event, true) {
        Some(task) => {
            app.start(task);
            app.flush(tx);
            true
        }
        None => false,
    }
}

/// A one-line field bound to `field`.
fn input(app: &App, edit: &rune::TextEdit, field: Field, placeholder: &str, style: TextStyle) -> El {
    let _ = app;
    text_input(edit, style)
        .single_line()
        .key(format!("{field:?}"))
        .w_full()
        .color(P.text)
        .placeholder(placeholder, P.faint)
        .caret(P.text, P.selection)
        .on_edit(move |app: &mut App| app.field(field))
        .on_input_key(overlay_keys)
}

/// A bordered frame around a one-line field.
fn framed(field: El) -> El {
    row()
        .w_full()
        .px(10.0)
        .h(34.0)
        .center_y()
        .radius(8.0)
        .fill(P.window)
        .border(1.0, P.border)
        .role("textbox")
        .child(field)
}

/// A pickable row in a list sheet.
fn option_row(key: &str, selected: bool, name: &str, message: Message) -> El {
    super::selectable(
        row()
            .key(key)
            .w_full()
            .h(32.0)
            .px(10.0)
            .gap(8.0)
            .center_y()
            .role("button")
            .label(name)
            .on_press_tx(send(message)),
        selected,
    )
    .radius(6.0)
}

pub fn view(app: &App) -> Option<El> {
    let overlay = app.overlay.as_ref()?;
    Some(match overlay {
        Overlay::Composer(composer) => composer_sheet(app, composer),
        Overlay::Palette(palette) => {
            let matches = app.palette_matches();
            let mut list = col().key("commands").w_full().gap(1.0);
            for (index, command) in matches.into_iter().enumerate() {
                let mut line = option_row(
                    &format!("command-{index}"),
                    index == palette.selected,
                    &command.label,
                    Message::PaletteRun(index),
                )
                .child(
                    label(command.label.as_str(), size::CONTROL, P.text)
                        .grow(1.0)
                        .shrink()
                        .truncate(),
                );
                if !command.keys.is_empty() {
                    line = line.child(keys(command.keys));
                }
                list = list.child(line);
            }
            let field = input(
                app,
                &palette.query,
                Field::Palette,
                "Type a command",
                theme::sans(size::BODY),
            )
            .on_input_change(|app: &mut App, tx: &mut Tx| {
                let query = app.field(Field::Palette).text.clone();
                app.dispatch(Message::PaletteQuery(query), tx);
            });
            sheet(
                "palette",
                560.0,
                col()
                    .child(framed(field).key("query"))
                    .child(
                        col()
                            .key("commands-scroll")
                            .w_full()
                            .max_h(380.0)
                            .scroll(ScrollSpec { stick_bottom: false })
                            .child(list),
                    )
                    .child(hints(vec![
                        hint("h-nav", NAVIGATE, "navigate"),
                        hint("h-run", &[KeyPart::Text("Enter")], "run"),
                        hint("h-esc", &[KeyPart::Text("Esc")], "close"),
                    ])),
            )
            .gap(10.0)
        }
        Overlay::Later(picker) => {
            let mut list = col().key("presets").w_full().gap(4.0);
            for (index, preset) in Preset::ALL.iter().enumerate() {
                list = list.child(
                    row()
                        .key(format!("preset-{index}"))
                        .w_full()
                        .px(12.0)
                        .py(8.0)
                        .gap(8.0)
                        .center_y()
                        .radius(8.0)
                        .border(1.0, P.border)
                        .hover(P.hover)
                        .press(P.press)
                        .motion(theme::SNAPPY)
                        .role("button")
                        .label(preset.label())
                        .on_press_tx(send(Message::LaterPreset(*preset)))
                        .child(mono((index + 1).to_string(), size::CAPTION, P.muted).w(18.0))
                        .child(label(preset.label(), size::BODY, P.text)),
                );
            }
            let snoozed = app
                .desk
                .state
                .agent(&picker.agent)
                .is_some_and(|agent| agent.snooze_until.is_some());
            let field = input(
                app,
                &picker.custom,
                Field::Later,
                "Or type 30m, 3h, 2d, or 14:30",
                theme::sans(size::BODY),
            )
            .on_input_change(|app: &mut App, tx: &mut Tx| {
                let text = app.field(Field::Later).text.clone();
                app.dispatch(Message::LaterCustom(text), tx);
            })
            .on_submit(|app: &mut App, tx: &mut Tx| app.dispatch(Message::LaterSubmit, tx));
            let mut body = col()
                .child(title("Later"))
                .child(muted("The row leaves the inbox until then. Queued work waits to start.").key("intro").wrap())
                .child(list)
                .child(framed(field).key("custom"))
                .child(hints(vec![
                    hint("h-apply", &[KeyPart::Text("Enter")], "apply typed time"),
                    hint("h-esc", &[KeyPart::Text("Esc")], "cancel"),
                ]));
            if let Some(error) = error("later-error", &picker.error) {
                body = body.child(error);
            }
            if snoozed {
                body = body.child(
                    row()
                        .key("wake-row")
                        .child(ghost("wake", "Wake now", &[], Message::WakeNow)),
                );
            }
            sheet("later", 440.0, body.gap(12.0))
        }
        Overlay::Settings(form) => {
            let setting = |key: &str, caption: &str, field: El| {
                col()
                    .key(key)
                    .w_full()
                    .gap(6.0)
                    .child(muted(caption.to_string()).wrap())
                    .child(framed(field))
            };
            let slots = input(app, &form.slots, Field::Slots, "4", theme::sans(size::BODY))
                .on_input_change(|app: &mut App, tx: &mut Tx| {
                    let text = app.field(Field::Slots).text.clone();
                    app.dispatch(Message::SettingsSlots(text), tx);
                });
            let terminal = input(
                app,
                &form.terminal,
                Field::Terminal,
                "open -a Terminal {path}",
                theme::mono(size::CONTROL),
            )
            .on_input_change(|app: &mut App, tx: &mut Tx| {
                let text = app.field(Field::Terminal).text.clone();
                app.dispatch(Message::SettingsTerminal(text), tx);
            });
            let editor = input(
                app,
                &form.editor,
                Field::Editor,
                "code {path}",
                theme::mono(size::CONTROL),
            )
            .on_input_change(|app: &mut App, tx: &mut Tx| {
                let text = app.field(Field::Editor).text.clone();
                app.dispatch(Message::SettingsEditor(text), tx);
            })
            .on_submit(|app: &mut App, tx: &mut Tx| app.dispatch(Message::SaveSettings, tx));
            let escape = input(
                app,
                &form.vim_escape,
                Field::VimEscape,
                "jk",
                theme::mono(size::CONTROL),
            )
            .on_input_change(|app: &mut App, tx: &mut Tx| {
                let text = app.field(Field::VimEscape).text.clone();
                app.dispatch(Message::SettingsVimEscape(text), tx);
            })
            .on_submit(|app: &mut App, tx: &mut Tx| app.dispatch(Message::SaveSettings, tx));
            let vim_mode = form.vim_mode;
            let mut body = col()
                .child(title("Settings"))
                .child(setting("slots", "Running agents at once", slots))
                .child(setting(
                    "terminal",
                    "Open in terminal ({path} is the task checkout)",
                    terminal,
                ))
                .child(setting("editor", "Open in editor", editor))
                .child(
                    Checkbox::new(vim_mode)
                        .label("Vim mode in the reply and task boxes")
                        .on_toggle_tx(move |app: &mut App, tx: &mut Tx| {
                            app.dispatch(Message::SettingsVim(!vim_mode), tx)
                        })
                        .build(&KIT)
                        .key("vim-mode"),
                )
                .child(setting(
                    "vim-escape",
                    "Keys that leave insert mode, typed within 1 second (empty turns this off)",
                    escape,
                ))
                .child(
                    faint(format!(
                        "State and worktrees live in {}",
                        app.store.root().display()
                    ))
                    .key("store")
                    .wrap(),
                );
            if let Some(error) = error("settings-error", &form.error) {
                body = body.child(error);
            }
            body = body.child(
                row()
                    .key("buttons")
                    .w_full()
                    .gap(8.0)
                    .justify_end()
                    .child(ghost(
                        "cancel",
                        "Cancel",
                        &[KeyPart::Text("Esc")],
                        Message::CloseOverlay,
                    ))
                    .child(primary("save", "Save", &[], Some(Message::SaveSettings), false)),
            );
            sheet("settings", 560.0, body)
        }
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
                "confirm-discard",
                440.0,
                col()
                    .child(title("Discard this task?"))
                    .child(
                        label(
                            format!("“{name}” {effect}. You have five seconds to undo."),
                            size::CONTROL,
                            P.text,
                        )
                        .key("message")
                        .wrap(),
                    )
                    .child(
                        row()
                            .key("buttons")
                            .w_full()
                            .gap(8.0)
                            .justify_end()
                            .child(ghost(
                                "cancel",
                                "Cancel",
                                &[KeyPart::Text("Esc")],
                                Message::CloseOverlay,
                            ))
                            .child(primary(
                                "discard",
                                "Discard",
                                &[KeyPart::Text("X"), KeyPart::Text("Enter")],
                                Some(Message::ConfirmDiscard),
                                true,
                            )),
                    ),
            )
        }
    })
}

fn composer_sheet(app: &App, composer: &crate::app::Composer) -> El {
    let names: Vec<String> = app
        .desk
        .state
        .projects
        .iter()
        .map(|project| project.name.clone())
        .collect();
    let current = composer
        .project
        .as_ref()
        .and_then(|id| app.desk.state.project(id))
        .map(|project| project.name.clone());
    let project = with_layer(|layer| {
        Select::new("composer-project", &names)
            .appearance(SelectAppearance::Field)
            .current(current.as_deref())
            .placeholder("Choose a project")
            .width(220.0)
            .open(composer.picking_project)
            .on_toggle(|app: &mut App| app.send(Message::ComposerProjectMenu))
            .on_close(|app: &mut App| app.send(Message::ComposerProjectMenu))
            .on_choose(|app: &mut App, value: &str, tx: &mut Tx| {
                let id = app
                    .desk
                    .state
                    .projects
                    .iter()
                    .find(|project| project.name == value)
                    .map(|project| project.id.clone());
                if let Some(id) = id {
                    app.dispatch(Message::ComposerProject(id), tx);
                }
            })
            .build(&KIT, layer)
    });
    let draft = compose::draft(&composer.content.text);
    let preview = match &draft {
        Some(draft) => muted(format!("Files one task: {}", one_line(&draft.title, 80))),
        None => faint("Files one task, titled from its first line."),
    }
    .key("preview")
    .truncate();
    let base = match (&composer.base, composer.use_worktree) {
        (Ok(branch), true) => format!("Merges into {branch}"),
        (Ok(branch), false) => format!("Works in the main checkout on {branch}"),
        (Err(error), _) => error.clone(),
    };
    let vim = app.desk.state.settings.vim_mode;
    let field = text_input(&composer.content, theme::sans(size::BODY))
        .key("composer")
        .placeholder("Describe the work. The whole text is one task.", P.faint)
        .on_edit(|app: &mut App| app.field(Field::Composer))
        .on_input_key(super::card::box_keys(Target::Composer))
        .on_input_change(|app: &mut App, tx: &mut Tx| app.dispatch(Message::ComposerEdited, tx))
        // Return adds a line here; Command-Return files the task.
        .on_submit(|app: &mut App, tx: &mut Tx| {
            app.field(Field::Composer).insert("\n");
            app.dispatch(Message::ComposerEdited, tx);
        });
    let mut editor = col().key("editor").w_full().gap(6.0).child(super::card::editor(
        field,
        vim && composer.vim.mode == crate::vim::Mode::Normal,
        8,
        16,
    ));
    if vim {
        editor = editor.child(super::card::mode(&composer.vim));
    }
    let use_worktree = composer.use_worktree;
    let mut body = col()
        .child(title("New task"))
        .child(
            row()
                .key("project-row")
                .w_full()
                .gap(12.0)
                .center_y()
                .child(project)
                .child(keys(&[COMMAND, KeyPart::Text("P")]))
                .child(el().key("spacer").grow(1.0))
                .child(
                    Checkbox::new(use_worktree)
                        .label("Use worktree")
                        .on_toggle_tx(move |app: &mut App, tx: &mut Tx| {
                            app.dispatch(Message::ComposerWorktree(!use_worktree), tx)
                        })
                        .build(&KIT)
                        .key("worktree"),
                )
                .child(keys(&[COMMAND, KeyPart::Text("E")])),
        );
    if let Some(search) = &composer.project_search {
        let mut list = col().key("matches").w_full().gap(1.0);
        let matches = app.project_matches();
        if matches.is_empty() {
            list = list.child(faint("No matching projects").key("none").px(10.0).py(6.0));
        }
        for (index, id) in matches.iter().enumerate() {
            let name = app
                .desk
                .state
                .project(id)
                .map(|project| project.name.as_str())
                .unwrap_or_default();
            list = list.child(
                option_row(
                    &format!("match-{index}"),
                    index == search.selected,
                    name,
                    Message::ComposerProjectPick(index),
                )
                .child(label(name, size::CONTROL, P.text)),
            );
        }
        let query = input(
            app,
            &search.query,
            Field::ProjectSearch,
            "Search projects",
            theme::sans(size::CONTROL),
        )
        .on_input_change(|app: &mut App, tx: &mut Tx| {
            let text = app.field(Field::ProjectSearch).text.clone();
            app.dispatch(Message::ComposerProjectQuery(text), tx);
        });
        body = body.child(
            col()
                .key("project-search")
                .w_full()
                .gap(8.0)
                .child(framed(query))
                .child(
                    col()
                        .key("matches-scroll")
                        .w_full()
                        .max_h(200.0)
                        .scroll(ScrollSpec { stick_bottom: false })
                        .child(list),
                )
                .child(hints(vec![
                    hint("h-nav", NAVIGATE, "navigate"),
                    hint("h-choose", &[KeyPart::Text("Enter")], "choose"),
                    hint("h-back", &[KeyPart::Text("Esc")], "back"),
                ])),
        );
    }
    body = body
        .child(super::session::controls(app, None))
        .child(editor)
        .child(preview);
    if let Some(error) = error("composer-error", &composer.error) {
        body = body.child(error);
    }
    let submit = (!composer.session.loading).then_some(Message::ComposerSubmit);
    body = body.child(
        row()
            .key("footer")
            .w_full()
            .gap(8.0)
            .center_y()
            .child(faint(base).grow(1.0).shrink().truncate())
            .child(ghost(
                "cancel",
                "Cancel",
                &[KeyPart::Text("Esc")],
                Message::CloseOverlay,
            ))
            .child(primary("file", "File task", &[COMMAND, RETURN], submit, false)),
    );
    sheet("composer-sheet", 640.0, body)
}
