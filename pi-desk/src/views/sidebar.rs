use super::{faint, icon, keys, label, selectable, send, strong};
use crate::app::{App, Message, View};
use crate::icon::{COMMAND, Icon, KeyPart};
use crate::theme::{self, P, size};
use rune::{Color, Cursor, Drag, El, Phase, Tx, col, el, row, text};

pub const WIDTH: f32 = 228.0;
/// The height of one project row, for turning a drag into a place.
const PROJECT_PITCH: f32 = 30.0;

fn item(app: &App, key: &str, name: &str, count: Option<usize>, view: View) -> El {
    let selected = app.view == view;
    let mut line = row()
        .key(key)
        .w_full()
        .h(30.0)
        .px(10.0)
        .center_y()
        .gap(8.0)
        .label(name)
        .role("button")
        .on_press_tx(send(Message::Show(view)))
        .child(
            text(name)
                .font(if selected {
                    theme::medium(size::CONTROL)
                } else {
                    theme::sans(size::CONTROL)
                })
                .color(if selected { P.text } else { P.muted })
                .grow(1.0)
                .shrink()
                .truncate(),
        );
    if let Some(count) = count.filter(|count| *count > 0) {
        line = line.child(label(
            count.to_string(),
            size::CAPTION,
            if selected { P.accent } else { P.faint },
        ));
    }
    selectable(line, selected)
}

/// The sidebar. `brand` names the app at the top, for windows without a
/// drawn titlebar.
pub fn view(app: &App, brand: bool) -> El {
    let state = &app.desk.state;
    let dragging = app.dragging.as_ref();

    let mut projects = col().key("projects").w_full().gap(0.0);
    for (index, project) in state.projects.iter().enumerate() {
        let view = View::Project(project.id.clone());
        let active = app.count(&view);
        let selected = app.view == view;
        let from = dragging
            .and_then(|(id, _)| state.projects.iter().position(|p| &p.id == id));
        let target = dragging.and_then(|(_, target)| *target);
        let marker = |above: bool| {
            let on = target == Some(index)
                && from.is_some_and(|from| from != index && (from > index) == above);
            el().h(2.0)
                .w_full()
                .radius(1.0)
                .fill(if on { P.accent } else { Color::TRANSPARENT })
        };
        let id = project.id.clone();
        let handle = row()
            .key("grip")
            .w(18.0)
            .h_full()
            .center()
            .cursor(if dragging.is_some() {
                Cursor::Grabbing
            } else {
                Cursor::Grab
            })
            .label("Reorder")
            .on_drag(move |app: &mut App, drag: &mut Drag, tx: &mut Tx| match drag.phase {
                Phase::Down => app.dispatch(Message::DragProject(id.clone()), tx),
                Phase::Move => {
                    let count = app.desk.state.projects.len() as isize;
                    let steps = (drag.dy / PROJECT_PITCH).round() as isize;
                    let target = (index as isize + steps).clamp(0, count - 1) as usize;
                    app.dispatch(Message::HoverProject(target), tx);
                }
                Phase::Up => app.dispatch(Message::MouseReleased, tx),
            })
            .child(icon(Icon::Grip, size::CAPTION, P.faint));
        let mut line = row()
            .key("row")
            .w_full()
            .h(PROJECT_PITCH - 4.0)
            .pr(10.0)
            .center_y()
            .gap(4.0)
            .label(project.name.as_str())
            .role("button")
            .on_press_tx(send(Message::Show(view)))
            .child(handle)
            .child(
                text(project.name.as_str())
                    .font(if selected {
                        theme::medium(size::CONTROL)
                    } else {
                        theme::sans(size::CONTROL)
                    })
                    .color(if selected { P.text } else { P.muted })
                    .grow(1.0)
                    .shrink()
                    .truncate(),
            );
        if active > 0 {
            line = line.child(label(active.to_string(), size::CAPTION, P.faint));
        }
        projects = projects.child(
            col()
                .key(format!("project-{}", project.id))
                .w_full()
                .child(marker(true).key("above"))
                .child(selectable(line, selected))
                .child(marker(false).key("below")),
        );
    }
    if state.projects.is_empty() {
        projects = projects.child(
            faint("Add a folder or git repository to file work in it.")
                .key("no-projects")
                .wrap()
                .px(10.0)
                .py(4.0),
        );
    }

    let nav = col()
        .key("nav")
        .w_full()
        .gap(1.0)
        .child(item(app, "nav-all", "All tasks", None, View::All))
        .child(item(app, "nav-inbox", "Inbox", Some(app.count(&View::Inbox)), View::Inbox))
        .child(item(
            app,
            "nav-working",
            "Working",
            Some(app.count(&View::Working)),
            View::Working,
        ))
        .child(item(app, "nav-later", "Later", Some(app.count(&View::Later)), View::Later))
        .child(item(app, "nav-done", "Done", None, View::Done));

    let header = row()
        .key("projects-header")
        .w_full()
        .pl(10.0)
        .center_y()
        .child(
            text("PROJECTS")
                .font(theme::medium(size::CAPTION - 1.0).tracking(0.6))
                .color(P.faint)
                .grow(1.0),
        )
        .child(
            row()
                .key("add-project")
                .w(24.0)
                .h(24.0)
                .center()
                .radius(6.0)
                .hover(P.hover)
                .press(P.press)
                .label("Add project")
                .role("button")
                .on_press_tx(send(Message::AddProject))
                .child(icon(Icon::Plus, 14.0, P.muted)),
        );

    let new_task = row()
        .key("new-task")
        .w_full()
        .h(34.0)
        .px(10.0)
        .gap(8.0)
        .center_y()
        .radius(8.0)
        .fill(P.raised)
        .border(1.0, P.border)
        .hover(P.hover)
        .press(P.press)
        .motion(theme::SNAPPY)
        .label("New task")
        .role("button")
        .on_press_tx(send(Message::NewTask))
        .child(icon(Icon::Plus, 14.0, P.text))
        .child(label("New task", size::CONTROL, P.text).grow(1.0))
        .child(keys(&[KeyPart::Text("N")]));

    let footer = row()
        .key("footer")
        .w_full()
        .center_y()
        .justify_between()
        .child(
            row()
                .key("settings")
                .px(8.0)
                .h(28.0)
                .center_y()
                .radius(6.0)
                .hover(P.hover)
                .press(P.press)
                .label("Settings")
                .role("button")
                .on_press_tx(send(Message::OpenSettings))
                .child(label("Settings", size::CAPTION, P.muted)),
        )
        .child(
            row()
                .key("commands")
                .gap(6.0)
                .center_y()
                .px(8.0)
                .h(28.0)
                .radius(6.0)
                .hover(P.hover)
                .press(P.press)
                .label("Commands")
                .role("button")
                .on_press_tx(send(Message::OpenPalette))
                .child(label("Commands", size::CAPTION, P.muted))
                .child(keys(&[COMMAND, KeyPart::Text("K")])),
        );

    let mut sidebar = col()
        .key("sidebar")
        .w(WIDTH)
        .h_full()
        .px(10.0)
        .pt(if brand { 16.0 } else { 12.0 })
        .pb(12.0)
        .gap(10.0)
        .fill(P.sidebar);
    if brand {
        sidebar = sidebar.child(
            row()
                .key("brand")
                .px(10.0)
                .h(24.0)
                .center_y()
                .child(strong("pi-desk", size::BODY, P.text)),
        );
    }
    sidebar
        .child(nav)
        .child(el().key("nav-gap").h(8.0))
        .child(header)
        .child(super::scroller("projects-scroll", projects))
        .child(new_task)
        .child(footer)
}
