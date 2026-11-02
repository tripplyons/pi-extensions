//! Discover Pi's authenticated models and model-specific effort levels without
//! starting a model request or creating a session.
use crate::model::{ModelChoice, SessionSettings};
use crate::rpc::{self, Incoming};
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

#[derive(Debug, Clone)]
pub struct Options {
    pub models: Vec<ModelChoice>,
    pub levels: Vec<String>,
    pub settings: SessionSettings,
}

/// CLI overrides select the model before querying its levels. Unlike RPC
/// selection commands, discovery never changes an existing session.
pub async fn discover(
    program: String,
    cwd: PathBuf,
    settings: SessionSettings,
) -> Result<Options, String> {
    let mut child = Command::new(program)
        .args(["--mode", "rpc", "--no-session"])
        .args(settings.args())
        .current_dir(cwd)
        .env("PI_DESK", "1")
        .env("PI_ASK_USER_TIMEOUT", "0")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| format!("Could not load Pi models: {error}"))?;
    let result = tokio::time::timeout(Duration::from_secs(20), async {
        let mut stdin = child.stdin.take().ok_or("Pi stdin is unavailable")?;
        let mut lines = BufReader::new(child.stdout.take().ok_or("Pi stdout is unavailable")?).lines();
        for (id, command) in [
            ("models", "get_available_models"),
            ("levels", "get_available_thinking_levels"),
            ("state", "get_state"),
        ] {
            stdin.write_all(rpc::command(id, command).as_bytes())
                .await.map_err(|error| error.to_string())?;
        }
        let mut models = None;
        let mut levels = None;
        let mut selected = None;
        while let Some(line) = lines.next_line().await.map_err(|error| error.to_string())? {
            let Ok(Incoming::Response { id: Some(id), success, data, error, .. }) = rpc::parse(&line) else {
                continue;
            };
            if !success {
                return Err(error.unwrap_or_else(|| "Pi rejected the model query".into()));
            }
            match id.as_str() {
                "models" => models = Some(serde_json::from_value::<Vec<ModelChoice>>(data["models"].clone()).map_err(|error| error.to_string())?),
                "levels" => levels = Some(serde_json::from_value::<Vec<String>>(data["levels"].clone()).map_err(|error| error.to_string())?),
                "state" => selected = Some(SessionSettings::from_state(&data)),
                _ => {}
            }
            if let (Some(models), Some(levels), Some(settings)) = (&models, &levels, &selected) {
                if settings.model.is_none() || models.is_empty() || levels.is_empty() {
                    return Err("Pi has no available model or effort levels. Check Pi's authentication and model configuration.".into());
                }
                let mut models = models.clone();
                models.sort_by_key(ToString::to_string);
                models.dedup();
                return Ok(Options { models, levels: levels.clone(), settings: settings.clone() });
            }
        }
        Err("Pi exited before returning model options".into())
    }).await.unwrap_or_else(|_| Err("Timed out loading Pi model options".into()));
    // Always reap our helper, including on malformed output and timeout.
    let _ = child.kill().await;
    let _ = child.wait().await;
    result
}
