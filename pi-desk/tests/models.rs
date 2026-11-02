//! Exercise model discovery through the real process/RPC boundary, never a
//! provider API or the user's Pi configuration.
mod common;

use pi_desk::model::{ModelChoice, SessionSettings};
use pi_desk::models::discover;
use std::os::unix::fs::PermissionsExt;

fn settings(model: &str, effort: &str) -> SessionSettings {
    SessionSettings {
        model: Some(ModelChoice {
            provider: "fake".into(),
            id: model.into(),
        }),
        effort: Some(effort.into()),
    }
}

#[tokio::test]
async fn discovery_uses_pi_defaults_and_model_specific_levels_without_creating_a_session() {
    let dir = tempfile::tempdir().unwrap();
    let defaults = discover(
        common::fake_pi(),
        dir.path().into(),
        SessionSettings::default(),
    )
    .await
    .unwrap();
    assert_eq!(defaults.settings, settings("reasoning", "medium"));
    assert_eq!(defaults.models.len(), 2);
    assert!(defaults.levels.contains(&"max".to_string()));

    let plain = discover(
        common::fake_pi(),
        dir.path().into(),
        settings("plain", "max"),
    )
    .await
    .unwrap();
    assert_eq!(plain.settings, settings("plain", "off"));
    assert_eq!(plain.levels, ["off"]);
    let max = discover(
        common::fake_pi(),
        dir.path().into(),
        settings("reasoning", "max"),
    )
    .await
    .unwrap();
    assert_eq!(max.settings, settings("reasoning", "max"));
    assert!(std::fs::read_dir(dir.path()).unwrap().next().is_none());
}

#[tokio::test]
async fn discovery_reports_actual_settings_instead_of_echoing_a_missing_model() {
    let dir = tempfile::tempdir().unwrap();
    // The fake falls back to its default provider, just as an unavailable
    // CLI model can be replaced by Pi's default. Never save that as a choice.
    let options = discover(
        common::fake_pi(),
        dir.path().into(),
        SessionSettings {
            model: Some(ModelChoice {
                provider: "missing".into(),
                id: "plain".into(),
            }),
            effort: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(options.settings, settings("plain", "off"));
}

#[tokio::test]
async fn discovery_reports_startup_rpc_and_early_exit_errors() {
    let dir = tempfile::tempdir().unwrap();
    let error = discover(
        dir.path().join("missing").to_string_lossy().into(),
        dir.path().into(),
        SessionSettings::default(),
    )
    .await
    .unwrap_err();
    assert!(error.contains("Could not load Pi models"));
    for (name, body, expected) in [
        (
            "reject",
            "while IFS= read -r line; do printf '%s\\n' '{\"id\":\"models\",\"type\":\"response\",\"command\":\"get_available_models\",\"success\":false,\"error\":\"Authentication unavailable\"}'; done",
            "Authentication unavailable",
        ),
        (
            "early-exit",
            "read -r line; printf '%s\\n' 'not json' '{\"type\":\"agent_start\"}'",
            "Pi exited before returning",
        ),
    ] {
        let program = dir.path().join(name);
        std::fs::write(&program, format!("#!/usr/bin/env bash\n{body}\n")).unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        let error = discover(
            program.to_string_lossy().into(),
            dir.path().into(),
            SessionSettings::default(),
        )
        .await
        .unwrap_err();
        assert!(error.contains(expected), "{error}");
    }
}
