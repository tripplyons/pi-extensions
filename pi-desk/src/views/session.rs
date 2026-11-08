use super::{faint, label, with_layer};
use crate::app::{App, Menu, Message};
use crate::model::Id;
use crate::theme::{KIT, P, size};
use rune::{El, Tx, col, row, text};
use rune_kit::{Select, SelectAppearance};

fn field(key: &str, name: &str, width: Option<f32>, select: El) -> El {
    let column = col().key(key).gap(4.0).child(faint(name)).child(select);
    match width {
        Some(width) => column.w(width),
        None => column.grow(1.0).shrink().min_w(160.0),
    }
}

/// Shared model and effort controls for the composer and existing tasks.
pub fn controls(app: &App, target: Option<Id>) -> El {
    let picker = app.session_picker(&target);
    let busy = target.as_ref().is_some_and(|id| app.desk.configuring(id));
    let loading = picker.is_some_and(|picker| picker.loading);
    let disabled = loading || busy;
    let options = picker.and_then(|picker| picker.options.as_ref());
    let settings = picker.map(|picker| &picker.settings);
    let suffix = target.as_deref().unwrap_or("composer");

    let models: Vec<String> = options
        .map(|options| options.models.iter().map(ToString::to_string).collect())
        .unwrap_or_default();
    let current_model = settings
        .and_then(|settings| settings.model.as_ref())
        .map(ToString::to_string);
    let model_menu = Menu::Model(target.clone());
    let effort_menu = Menu::Effort(target.clone());
    let model = {
        let (toggle, choose) = (model_menu.clone(), target.clone());
        let select = Select::new(format!("model-{suffix}"), &models)
            .appearance(SelectAppearance::Field)
            .current(current_model.as_deref())
            .placeholder(if loading {
                "Loading models…"
            } else {
                "Pi default"
            })
            .open(app.menu.as_ref() == Some(&model_menu))
            .disabled(disabled || models.is_empty())
            .on_toggle(move |app: &mut App| app.send(Message::ToggleMenu(toggle.clone())))
            .on_close(|app: &mut App| app.send(Message::CloseMenu))
            .on_choose(move |app: &mut App, value: &str, tx: &mut Tx| {
                let found = app
                    .session_picker(&choose)
                    .and_then(|picker| picker.options.as_ref())
                    .and_then(|options| {
                        options
                            .models
                            .iter()
                            .find(|model| model.to_string() == value)
                            .cloned()
                    });
                if let Some(model) = found {
                    app.dispatch(Message::SessionModel(choose.clone(), model), tx);
                }
            });
        with_layer(|layer| select.build(&KIT, layer)).w_full()
    };
    let levels: Vec<String> = options.map(|options| options.levels.clone()).unwrap_or_default();
    let effort = {
        let (toggle, choose) = (effort_menu.clone(), target.clone());
        let select = Select::new(format!("effort-{suffix}"), &levels)
            .appearance(SelectAppearance::Field)
            .width(120.0)
            .current(settings.and_then(|settings| settings.effort.as_deref()))
            .placeholder("Pi default")
            .open(app.menu.as_ref() == Some(&effort_menu))
            .disabled(disabled || levels.is_empty())
            .on_toggle(move |app: &mut App| app.send(Message::ToggleMenu(toggle.clone())))
            .on_close(|app: &mut App| app.send(Message::CloseMenu))
            .on_choose(move |app: &mut App, value: &str, tx: &mut Tx| {
                app.dispatch(Message::SessionEffort(choose.clone(), value.to_string()), tx);
            });
        with_layer(|layer| select.build(&KIT, layer))
    };
    let refresh_label = if loading {
        "Refreshing…"
    } else if options.is_some() {
        "Refresh models"
    } else {
        "Load model options"
    };
    let mut refresh = row()
        .key("refresh")
        .px(12.0)
        .h(28.0)
        .center()
        .radius(6.0)
        .border(1.0, P.border)
        .label(refresh_label)
        .role("button")
        .child(text(refresh_label).font(crate::theme::sans(size::CAPTION)).color(P.text));
    if disabled {
        refresh = refresh.opacity(0.5);
    } else {
        refresh = refresh
            .hover(P.hover)
            .press(P.press)
            .on_press_tx(super::send(Message::RefreshSession(target.clone())));
    }

    let mut content = col()
        .key(format!("session-{suffix}"))
        .w_full()
        .gap(6.0)
        .child(
            row()
                .key("pickers")
                .w_full()
                .gap(10.0)
                // Narrow panes put the effort and refresh controls on a second line.
                .flex_wrap()
                .items_end()
                .child(field("model", "Model", None, model))
                .child(field("effort", "Effort", Some(120.0), effort))
                .child(refresh),
        );
    if busy {
        content = content.child(faint("Applying settings to the next model request…").key("applying"));
    }
    if let Some(error) = picker.and_then(|picker| picker.error.as_ref()) {
        content = content.child(label(error, size::CAPTION, P.red).key("session-error").wrap());
    }
    content
}
