//! Pi RPC records (`pi --mode rpc`): one JSON object per LF-terminated line.
//! See Pi's docs/rpc.md, docs/json.md, and docs/rpc-extension-ui.md.

use serde_json::{Value, json};

/// Environment for every Pi process pi-desk starts. Questions have no
/// deadline because the user answers them later.
pub const ENV: [(&str, &str); 2] = [("PI_ASK_USER_TIMEOUT", "0"), ("PI_DESK", "1")];

#[derive(Debug, Clone, PartialEq)]
pub struct UiRequest {
    pub id: String,
    pub method: String,
    pub title: String,
    pub message: String,
    pub options: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Incoming {
    Response {
        id: Option<String>,
        success: bool,
        data: Value,
        error: Option<String>,
    },
    NamingFinished,
    /// An extension's footer status: `text` is `None` when it clears.
    Status {
        key: String,
        text: Option<String>,
    },
    AgentStart,
    AgentSettled {
        aborted: bool,
    },
    CompactionStart,
    CompactionEnd {
        aborted: bool,
        error: Option<String>,
    },
    MessageStart {
        message: Value,
    },
    MessageEnd {
        message: Value,
    },
    TextDelta {
        index: usize,
        delta: String,
    },
    ThinkingDelta {
        index: usize,
        delta: String,
    },
    TextEnd {
        index: usize,
        content: String,
    },
    ThinkingEnd {
        index: usize,
        content: String,
    },
    ToolStart {
        id: String,
        name: String,
        args: Value,
    },
    ToolEnd {
        id: String,
        name: String,
        result: Value,
        is_error: bool,
    },
    Ui(UiRequest),
    ExtensionError {
        error: String,
    },
    RetryFailed {
        error: String,
    },
    Other,
}

fn string(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

pub fn parse(line: &str) -> Result<Incoming, String> {
    let line = line.strip_suffix('\r').unwrap_or(line);
    let record: Value =
        serde_json::from_str(line).map_err(|error| format!("bad RPC record: {error}"))?;
    let kind = record
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    Ok(match kind {
        "response" => Incoming::Response {
            id: record.get("id").and_then(Value::as_str).map(str::to_string),
            success: record
                .get("success")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            data: record.get("data").cloned().unwrap_or(Value::Null),
            error: record
                .get("error")
                .and_then(Value::as_str)
                .map(str::to_string),
        },
        "agent_start" => Incoming::AgentStart,
        "agent_settled" => Incoming::AgentSettled {
            aborted: record
                .get("aborted")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        },
        "compaction_start" => Incoming::CompactionStart,
        "compaction_end" => Incoming::CompactionEnd {
            aborted: record
                .get("aborted")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            error: record
                .get("errorMessage")
                .and_then(Value::as_str)
                .map(str::to_string),
        },
        "message_start" => Incoming::MessageStart {
            message: record.get("message").cloned().unwrap_or(Value::Null),
        },
        "message_end" => Incoming::MessageEnd {
            message: record.get("message").cloned().unwrap_or(Value::Null),
        },
        "message_update" => {
            let event = record
                .get("assistantMessageEvent")
                .cloned()
                .unwrap_or(Value::Null);
            let index = event
                .get("contentIndex")
                .and_then(Value::as_u64)
                .unwrap_or(0) as usize;
            match event.get("type").and_then(Value::as_str) {
                // Starts create empty blocks so the row appears before the first delta.
                Some("text_start" | "text_delta") => Incoming::TextDelta {
                    index,
                    delta: string(&event, "delta"),
                },
                Some("thinking_start" | "thinking_delta") => Incoming::ThinkingDelta {
                    index,
                    delta: string(&event, "delta"),
                },
                Some("text_end") => Incoming::TextEnd {
                    index,
                    content: string(&event, "content"),
                },
                Some("thinking_end") => Incoming::ThinkingEnd {
                    index,
                    content: string(&event, "content"),
                },
                _ => Incoming::Other,
            }
        }
        "tool_execution_start" => Incoming::ToolStart {
            id: string(&record, "toolCallId"),
            name: string(&record, "toolName"),
            args: record.get("args").cloned().unwrap_or(Value::Null),
        },
        "tool_execution_end" => Incoming::ToolEnd {
            id: string(&record, "toolCallId"),
            name: string(&record, "toolName"),
            result: record.get("result").cloned().unwrap_or(Value::Null),
            is_error: record
                .get("isError")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        },
        "extension_ui_request"
            if string(&record, "method") == "setStatus"
                && string(&record, "statusKey") == "auto-rename"
                && record.get("statusText").is_none_or(Value::is_null) =>
        {
            Incoming::NamingFinished
        }
        "extension_ui_request" if string(&record, "method") == "setStatus" => Incoming::Status {
            key: string(&record, "statusKey"),
            text: record
                .get("statusText")
                .and_then(Value::as_str)
                .map(str::to_string),
        },
        "extension_ui_request" => Incoming::Ui(UiRequest {
            id: string(&record, "id"),
            method: string(&record, "method"),
            title: string(&record, "title"),
            message: string(&record, "message"),
            options: record
                .get("options")
                .and_then(Value::as_array)
                .map(|options| {
                    options
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default(),
        }),
        "extension_error" => Incoming::ExtensionError {
            error: string(&record, "error"),
        },
        "auto_retry_end" if record.get("success") == Some(&Value::Bool(false)) => {
            Incoming::RetryFailed {
                error: string(&record, "finalError"),
            }
        }
        _ => Incoming::Other,
    })
}

fn line(value: Value) -> String {
    let mut text = value.to_string();
    text.push('\n');
    text
}

/// `streaming` is `None` when idle, or `steer`/`followUp` during a run.
pub fn prompt(id: &str, message: &str, streaming: Option<&str>) -> String {
    let mut command = json!({ "id": id, "type": "prompt", "message": message });
    if let Some(behavior) = streaming {
        command["streamingBehavior"] = json!(behavior);
    }
    line(command)
}

pub fn command(id: &str, kind: &str) -> String {
    line(json!({ "id": id, "type": kind }))
}

pub fn set_model(id: &str, provider: &str, model: &str) -> String {
    line(json!({"id":id, "type":"set_model", "provider":provider, "modelId":model}))
}

pub fn set_effort(id: &str, level: &str) -> String {
    line(json!({"id":id, "type":"set_thinking_level", "level":level}))
}

pub fn ui_value(id: &str, value: &str) -> String {
    line(json!({ "type": "extension_ui_response", "id": id, "value": value }))
}

pub fn ui_confirm(id: &str, confirmed: bool) -> String {
    line(json!({ "type": "extension_ui_response", "id": id, "confirmed": confirmed }))
}

pub fn ui_cancel(id: &str) -> String {
    line(json!({ "type": "extension_ui_response", "id": id, "cancelled": true }))
}

/// Joins the text blocks of a message's `content`, which is a string for
/// user messages or a block array.
pub fn text_of(message: &Value) -> String {
    match message.get("content") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

pub fn role(message: &Value) -> &str {
    message
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_stream_tool_and_ui_records() {
        assert_eq!(
            parse(r#"{"type":"message_update","usage":{},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Hi\u2028there"}}"#).unwrap(),
            Incoming::TextDelta { index: 0, delta: "Hi\u{2028}there".into() }
        );
        assert_eq!(
            parse(r#"{"type":"tool_execution_start","toolCallId":"c1","toolName":"ask_user","args":{"question":"Q?","choices":["A"],"recommended":1}}"#).unwrap(),
            Incoming::ToolStart { id: "c1".into(), name: "ask_user".into(), args: json!({"question":"Q?","choices":["A"],"recommended":1}) }
        );
        let Incoming::Ui(request) = parse(r#"{"type":"extension_ui_request","id":"u1","method":"select","title":"Q?","options":["A","Other (type an answer)"]}"#).unwrap() else {
            panic!("expected a UI request");
        };
        assert_eq!(request.options, ["A", "Other (type an answer)"]);
        assert_eq!(
            parse("{\"type\":\"agent_settled\",\"aborted\":false}\r").unwrap(),
            Incoming::AgentSettled { aborted: false }
        );
        assert!(parse("not json").is_err());
    }

    #[test]
    fn parses_extension_statuses() {
        assert_eq!(
            parse(r#"{"type":"extension_ui_request","id":"s1","method":"setStatus","statusKey":"goal","statusText":"goal"}"#).unwrap(),
            Incoming::Status { key: "goal".into(), text: Some("goal".into()) }
        );
        assert_eq!(
            parse(r#"{"type":"extension_ui_request","id":"s2","method":"setStatus","statusKey":"goal"}"#).unwrap(),
            Incoming::Status { key: "goal".into(), text: None }
        );
        assert_eq!(
            parse(r#"{"type":"extension_ui_request","id":"s3","method":"setStatus","statusKey":"auto-rename"}"#).unwrap(),
            Incoming::NamingFinished
        );
    }

    #[test]
    fn parses_native_compaction_events() {
        for reason in ["manual", "threshold", "overflow"] {
            assert_eq!(
                parse(&json!({"type":"compaction_start","reason":reason}).to_string()).unwrap(),
                Incoming::CompactionStart
            );
            assert_eq!(
                parse(&json!({"type":"compaction_end","reason":reason,"result":{},"aborted":false,"willRetry":true}).to_string()).unwrap(),
                Incoming::CompactionEnd { aborted: false, error: None }
            );
        }
        assert_eq!(
            parse(r#"{"type":"compaction_end","aborted":true,"willRetry":false}"#).unwrap(),
            Incoming::CompactionEnd {
                aborted: true,
                error: None
            }
        );
        assert_eq!(
            parse(r#"{"type":"compaction_end","aborted":false,"errorMessage":"Compaction failed: unavailable","willRetry":false}"#).unwrap(),
            Incoming::CompactionEnd { aborted: false, error: Some("Compaction failed: unavailable".into()) }
        );
    }

    #[test]
    fn builds_commands_and_dialog_responses() {
        let record = |text: String| {
            assert!(text.ends_with('\n') && !text.trim_end().contains('\n'));
            serde_json::from_str::<Value>(&text).unwrap()
        };
        assert_eq!(
            record(prompt("p1", "Go", None)),
            json!({"id":"p1","type":"prompt","message":"Go"})
        );
        assert_eq!(
            record(prompt("p2", "Also", Some("steer")))["streamingBehavior"],
            "steer"
        );
        assert_eq!(
            record(set_model("m1", "provider", "model")),
            json!({"id":"m1","type":"set_model","provider":"provider","modelId":"model"})
        );
        assert_eq!(
            record(set_effort("e1", "max")),
            json!({"id":"e1","type":"set_thinking_level","level":"max"})
        );
        assert_eq!(
            record(ui_cancel("u1")),
            json!({"type":"extension_ui_response","id":"u1","cancelled":true})
        );
        assert_eq!(
            record(ui_value("u2", "line one\nline two"))["value"],
            "line one\nline two"
        );
    }

    #[test]
    fn text_of_reads_strings_and_text_blocks() {
        assert_eq!(text_of(&json!({"role":"user","content":"plain"})), "plain");
        assert_eq!(
            text_of(
                &json!({"role":"assistant","content":[{"type":"thinking","thinking":"x"},{"type":"text","text":"a"},{"type":"text","text":"b"}]})
            ),
            "a\nb"
        );
    }
}
