use super::faint;
use crate::app::{App, Message};
use crate::model::Id;
use crate::theme;
use iced::widget::{button, column, pick_list, row, text};
use iced::{Element, Fill, Length};

/// Shared controls for the composer and existing tasks.
pub fn controls(app: &App, target: Option<Id>) -> Element<'_, Message> {
    let mut content = column![].spacing(6);
    let picker = app.session_picker(&target);
    let busy = target.as_ref().is_some_and(|id| app.desk.configuring(id));
    if let Some(picker) = picker {
        if let Some(options) = &picker.options
            && !picker.loading
            && !busy
        {
            let model_target = target.clone();
            let effort_target = target.clone();
            content = content.push(
                row![
                    column![
                        faint("Model"),
                        pick_list(
                            options.models.as_slice(),
                            picker.settings.model.as_ref(),
                            move |model| Message::SessionModel(model_target.clone(), model)
                        )
                        .text_size(12)
                        .padding([5, 8])
                        .width(Fill),
                    ]
                    .spacing(4)
                    .width(Fill),
                    column![
                        faint("Effort"),
                        pick_list(
                            options.levels.as_slice(),
                            picker.settings.effort.as_ref(),
                            move |effort| Message::SessionEffort(effort_target.clone(), effort)
                        )
                        .text_size(12)
                        .padding([5, 8])
                        .width(Fill),
                    ]
                    .spacing(4)
                    .width(Length::Fixed(110.0)),
                ]
                .spacing(10),
            );
        } else {
            content = content.push(faint(format!(
                "Model: {}  ·  Effort: {}",
                picker
                    .settings
                    .model
                    .as_ref()
                    .map(ToString::to_string)
                    .unwrap_or_else(|| "Pi default".into()),
                picker.settings.effort.as_deref().unwrap_or("Pi default")
            )));
        }
        if picker.loading || busy {
            content = content.push(faint(if busy {
                "Applying settings to the next model request…"
            } else {
                "Loading Pi model options…"
            }));
        }
        if let Some(error) = &picker.error {
            content = content.push(text(error).size(12).color(theme::RED));
        }
    }
    if picker.is_none_or(|picker| !picker.loading) && !busy {
        content = content.push(
            button(
                text(if picker.is_some_and(|picker| picker.options.is_some()) {
                    "Refresh models"
                } else {
                    "Load model options"
                })
                .size(11),
            )
            .padding([2, 0])
            .style(theme::ghost)
            .on_press(Message::RefreshSession(target)),
        );
    }
    content.into()
}
