use super::{faint, icon, key, keys};
use crate::app::{App, Message, View};
use crate::icon::{COMMAND, Icon, KeyPart};
use crate::theme::{self, ACCENT, BOLD, FAINT, MUTED};
use iced::widget::{Space, button, column, container, mouse_area, row, scrollable, text};
use iced::{Alignment, Element, Fill, mouse};

fn item<'a>(app: &App, label: &'a str, count: Option<usize>, view: View) -> Element<'a, Message> {
    let selected = app.view == view;
    let count: Element<'a, Message> = match count {
        Some(count) if count > 0 => text(count.to_string())
            .size(theme::size::CAPTION)
            .color(if selected { ACCENT } else { MUTED })
            .into(),
        _ => Space::new().into(),
    };
    button(
        row![text(label).size(theme::size::CONTROL).width(Fill), count].align_y(Alignment::Center),
    )
    .width(Fill)
    .padding([6, 10])
    .style(theme::row(selected))
    .on_press(Message::Show(view))
    .into()
}

pub fn view(app: &App) -> Element<'_, Message> {
    let state = &app.desk.state;

    let mut projects = column![].spacing(1);
    let target = app.dragging.as_ref().and_then(|(_, target)| *target);
    for (index, project) in state.projects.iter().enumerate() {
        let active = app.count(&View::Project(project.id.clone()));
        let selected = app.view == View::Project(project.id.clone());
        let handle =
            mouse_area(container(icon(Icon::Grip, theme::size::CAPTION, FAINT)).padding([6, 4]))
                .interaction(mouse::Interaction::Grab)
                .on_press(Message::DragProject(project.id.clone()));
        let label = button(
            row![
                text(project.name.as_str())
                    .size(theme::size::CONTROL)
                    .width(Fill),
                if active > 0 {
                    text(active.to_string())
                        .size(theme::size::CAPTION)
                        .color(MUTED)
                } else {
                    text("")
                },
            ]
            .align_y(Alignment::Center),
        )
        .width(Fill)
        .padding([6, 8])
        .style(theme::row(selected))
        .on_press(Message::Show(View::Project(project.id.clone())));
        let marker = container(Space::new())
            .width(Fill)
            .height(2)
            .style(theme::fill(if target == Some(index) {
                ACCENT
            } else {
                iced::Color::TRANSPARENT
            }));
        projects = projects.push(column![
            marker,
            mouse_area(row![handle, label].align_y(Alignment::Center))
                .on_enter(Message::HoverProject(index))
        ]);
    }
    if state.projects.is_empty() {
        projects = projects.push(
            container(faint("Add a git repository to file work in it.").size(theme::size::CAPTION))
                .padding([4, 10]),
        );
    }

    let nav = column![
        item(app, "All tasks", None, View::All),
        item(app, "Inbox", Some(app.count(&View::Inbox)), View::Inbox),
        item(
            app,
            "Working",
            Some(app.count(&View::Working)),
            View::Working
        ),
        item(app, "Later", Some(app.count(&View::Later)), View::Later),
        item(app, "Done", None, View::Done),
    ]
    .spacing(1);

    let header = row![
        text("Projects")
            .size(theme::size::CAPTION)
            .font(BOLD)
            .width(Fill),
        button(text("+").size(theme::size::BODY).color(MUTED))
            .padding([0, 8])
            .style(theme::row(false))
            .on_press(Message::AddProject),
    ]
    .align_y(Alignment::Center)
    .padding([0, 4]);

    let footer = column![
        button(
            row![
                text("New task").size(theme::size::CONTROL).width(Fill),
                key("N")
            ]
            .align_y(Alignment::Center)
        )
        .width(Fill)
        .padding([8, 10])
        .style(theme::ghost)
        .on_press(Message::NewTask),
        row![
            button(text("Settings").size(theme::size::CAPTION))
                .style(theme::row(false))
                .padding([4, 8])
                .on_press(Message::OpenSettings),
            Space::new().width(Fill),
            button(
                row![
                    text("Commands").size(theme::size::CAPTION).color(MUTED),
                    keys(&[COMMAND, KeyPart::Text("K")])
                ]
                .spacing(6)
                .align_y(Alignment::Center)
            )
            .style(theme::row(false))
            .padding([4, 6])
            .on_press(Message::OpenPalette),
        ]
        .align_y(Alignment::Center),
    ]
    .spacing(8);

    container(
        column![
            container(text("pi-desk").font(BOLD).size(theme::size::BODY)).padding([2, 10]),
            nav,
            Space::new().height(14),
            header,
            scrollable(projects).style(theme::scrollbar).height(Fill),
            footer,
        ]
        .spacing(8),
    )
    .width(220)
    .height(Fill)
    .padding([16, 10])
    .style(theme::sidebar)
    .into()
}
