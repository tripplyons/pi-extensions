//! Discover Pi's authenticated models and model-specific effort levels without
//! starting a model request or creating a session. When Pi has scoped models
//! (`enabledModels` or `--models`), only those models are offered.
use crate::model::{ModelChoice, SessionSettings};
use crate::rpc::{self, Incoming};
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader, Lines};
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
        .envs(rpc::ENV)
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
        // Read levels and state before cycling, because cycling changes the model.
        while models.is_none() || levels.is_none() || selected.is_none() {
            let Some((id, data)) = next_response(&mut lines).await? else {
                return Err("Pi exited before returning model options".into());
            };
            match id.as_str() {
                "models" => models = Some(serde_json::from_value::<Vec<ModelChoice>>(data["models"].clone()).map_err(|error| error.to_string())?),
                "levels" => levels = Some(serde_json::from_value::<Vec<String>>(data["levels"].clone()).map_err(|error| error.to_string())?),
                "state" => selected = Some(SessionSettings::from_state(&data)),
                _ => {}
            }
        }
        let (models, levels, settings) = (models.unwrap(), levels.unwrap(), selected.unwrap());
        if settings.model.is_none() || models.is_empty() || levels.is_empty() {
            return Err("Pi has no available model or effort levels. Check Pi's authentication and model configuration.".into());
        }
        let mut models = scoped(&mut stdin, &mut lines, models.len()).await?.unwrap_or(models);
        models.sort_by_key(ToString::to_string);
        models.dedup();
        Ok(Options { models, levels, settings })
    }).await.unwrap_or_else(|_| Err("Timed out loading Pi model options".into()));
    // Always reap our helper, including on malformed output and timeout.
    let _ = child.kill().await;
    let _ = child.wait().await;
    result
}

/// Next successful response as (id, data). Ignores events and unparsable lines.
async fn next_response<R: AsyncBufRead + Unpin>(
    lines: &mut Lines<R>,
) -> Result<Option<(String, serde_json::Value)>, String> {
    while let Some(line) = lines.next_line().await.map_err(|error| error.to_string())? {
        let Ok(Incoming::Response { id: Some(id), success, data, error, .. }) = rpc::parse(&line) else {
            continue;
        };
        if !success {
            return Err(error.unwrap_or_else(|| "Pi rejected the model query".into()));
        }
        return Ok(Some((id, data)));
    }
    Ok(None)
}

/// RPC has no scoped-model query, so walk Pi's model cycle. `cycle_model`
/// steps through the available scoped models when a scope exists and reports
/// `isScoped`; in RPC it does not save settings, and discovery has no session.
/// Returns None when there is no scope or it cannot be listed (Pi returns null
/// when at most one model can be cycled), so the caller offers every model.
async fn scoped<W: AsyncWrite + Unpin, R: AsyncBufRead + Unpin>(
    stdin: &mut W,
    lines: &mut Lines<R>,
    available: usize,
) -> Result<Option<Vec<ModelChoice>>, String> {
    let mut seen: Vec<ModelChoice> = Vec::new();
    for step in 0..=available {
        let id = format!("cycle-{step}");
        stdin.write_all(rpc::command(&id, "cycle_model").as_bytes())
            .await.map_err(|error| error.to_string())?;
        let data = loop {
            match next_response(lines).await? {
                Some((got, data)) if got == id => break data,
                Some(_) => continue,
                None => return Err("Pi exited before returning model options".into()),
            }
        };
        if data.is_null() || data["isScoped"] != serde_json::Value::Bool(true) {
            return Ok(None);
        }
        let model = serde_json::from_value::<ModelChoice>(data["model"].clone())
            .map_err(|error| error.to_string())?;
        if seen.contains(&model) {
            return Ok(Some(seen));
        }
        seen.push(model);
    }
    Ok(Some(seen))
}
