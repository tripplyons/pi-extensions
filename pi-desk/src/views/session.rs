use super::faint;
use crate::app::{App, Message};
use crate::model::Id;
use crate::theme;
use iced::widget::{button, column, pick_list, row, text};
use iced::{Alignment, Element, Fill, Length};

/// Shared controls for the composer and existing tasks.
pub fn controls(app: &App, target: Option<Id>) -> Element<'_, Message> {
    let picker = app.session_picker(&target);
    let busy = target.as_ref().is_some_and(|id| app.desk.configuring(id));
    let loading = picker.is_some_and(|picker| picker.loading);
    let disabled = loading || busy;
    let options = picker.and_then(|picker| picker.options.as_ref());
    let settings = picker.map(|picker| &picker.settings);
    let model_target = target.clone();
    let effort_target = target.clone();
    // Empty menus preserve the selected labels and geometry without allowing
    // settings changes while a discovery/apply request is in flight.
    let models = options
        .filter(|_| !disabled)
        .map_or(&[][..], |options| options.models.as_slice());
    let levels = options
        .filter(|_| !disabled)
        .map_or(&[][..], |options| options.levels.as_slice());
    let refresh = button(
        text(if loading {
            "Refreshing…"
        } else if options.is_some() {
            "Refresh models"
        } else {
            "Load model options"
        })
        .size(theme::size::CAPTION),
    )
    .padding([5, 10])
    .width(Length::Fixed(136.0))
    .style(theme::ghost)
    .on_press_maybe((!disabled).then_some(Message::RefreshSession(target)));
    let mut content = column![
        row![
            column![
                faint("Model"),
                pick_list(
                    models,
                    settings.and_then(|settings| settings.model.as_ref()),
                    move |model| Message::SessionModel(model_target.clone(), model)
                )
                .placeholder(if loading {
                    "Loading models…"
                } else {
                    "Pi default"
                })
                .text_size(theme::size::CAPTION)
                .padding([5, 8])
                .width(Fill),
            ]
            .spacing(4)
            .width(Fill),
            column![
                faint("Effort"),
                pick_list(
                    levels,
                    settings.and_then(|settings| settings.effort.as_ref()),
                    move |effort| Message::SessionEffort(effort_target.clone(), effort)
                )
                .placeholder("Pi default")
                .text_size(theme::size::CAPTION)
                .padding([5, 8])
                .width(Fill),
            ]
            .spacing(4)
            .width(Length::Fixed(110.0)),
            refresh,
        ]
        .spacing(10)
        .align_y(Alignment::End)
    ]
    .spacing(6);
    if busy {
        content = content.push(faint("Applying settings to the next model request…"));
    }
    if let Some(error) = picker.and_then(|picker| picker.error.as_ref()) {
        content = content.push(text(error).size(theme::size::CAPTION).color(theme::RED));
    }
    content.into()
}
