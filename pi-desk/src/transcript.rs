//! A displayable conversation, built from live RPC events or from saved
//! messages (`get_messages` or the session file).

use crate::rpc::{self, Incoming};
use crate::text::one_line;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::path::Path;

const OUTPUT_LIMIT: usize = 6000;

#[derive(Debug, Clone)]
pub enum AssistantBlock {
    Text {
        text: String,
    },
    Thinking {
        text: String,
    },
}

impl AssistantBlock {
    fn new(thinking: bool, text: String) -> Self {
        if thinking {
            Self::Thinking { text }
        } else {
            Self::Text { text }
        }
    }
}

#[derive(Debug, Clone)]
pub enum Entry {
    User {
        text: String,
    },
    Assistant {
        id: usize,
        text: String,
        blocks: BTreeMap<usize, AssistantBlock>,
        error: Option<String>,
    },
    Tool {
        id: String,
        name: String,
        preview: String,
        output: String,
        is_error: bool,
        running: bool,
    },
    Note {
        text: String,
    },
}

#[derive(Debug, Clone, Default)]
pub struct Transcript {
    pub entries: Vec<Entry>,
    tools: HashMap<String, usize>,
    active_assistant: Option<usize>,
    next_assistant_id: usize,
    /// Text of the most recent assistant message, with its error if it failed.
    pub last_text: String,
    pub last_error: Option<String>,
}

/// One line describing a tool call, from its most telling argument.
pub fn preview(name: &str, args: &Value) -> String {
    for key in [
        "command",
        "question",
        "path",
        "file_path",
        "pattern",
        "query",
        "url",
        "code",
        "objective",
        "task_id",
    ] {
        if let Some(value) = args.get(key).and_then(Value::as_str) {
            return one_line(value, 120);
        }
    }
    if name == "edit" || name == "write" {
        return String::new();
    }
    match args {
        Value::Object(map) if map.is_empty() => String::new(),
        Value::Null => String::new(),
        other => one_line(&other.to_string(), 120),
    }
}

fn output_of(result: &Value) -> String {
    let text = rpc::text_of(result);
    if text.chars().count() <= OUTPUT_LIMIT {
        text
    } else {
        format!(
            "{}\n… (output shortened)",
            text.chars().take(OUTPUT_LIMIT).collect::<String>()
        )
    }
}

impl Transcript {
    pub fn note(&mut self, text: impl Into<String>) {
        self.entries.push(Entry::Note { text: text.into() });
    }

    fn start_tool(&mut self, id: &str, name: &str, args: &Value) {
        if self.tools.contains_key(id) {
            return;
        }
        self.tools.insert(id.to_string(), self.entries.len());
        self.entries.push(Entry::Tool {
            id: id.to_string(),
            name: name.to_string(),
            preview: preview(name, args),
            output: String::new(),
            is_error: false,
            running: true,
        });
    }

    fn finish_tool(&mut self, id: &str, result: &Value, failed: bool) {
        if let Some(Entry::Tool {
            output,
            is_error,
            running,
            ..
        }) = self
            .tools
            .get(id)
            .and_then(|index| self.entries.get_mut(*index))
        {
            *output = output_of(result);
            *is_error = failed;
            *running = false;
        }
    }

    fn start_assistant(&mut self) {
        self.active_assistant = Some(self.entries.len());
        self.entries.push(Entry::Assistant {
            id: self.next_assistant_id,
            text: String::new(),
            blocks: BTreeMap::new(),
            error: None,
        });
        self.next_assistant_id += 1;
    }

    fn update_block(&mut self, index: usize, thinking: bool, value: &str, replace: bool) -> bool {
        let Some(Entry::Assistant { text, blocks, .. }) = self
            .active_assistant
            .and_then(|index| self.entries.get_mut(index))
        else {
            return false;
        };
        let block = blocks
            .entry(index)
            .or_insert_with(|| AssistantBlock::new(thinking, String::new()));
        if replace {
            *block = AssistantBlock::new(thinking, value.to_string());
        } else {
            match block {
                AssistantBlock::Text { text } => text.push_str(value),
                AssistantBlock::Thinking { text } => text.push_str(value),
            }
        }
        *text = blocks
            .values()
            .filter_map(|block| match block {
                AssistantBlock::Text { text, .. } => Some(text.as_str()),
                AssistantBlock::Thinking { .. } => None,
            })
            .collect::<Vec<_>>()
            .join("\n");
        true
    }

    fn finish_assistant(&mut self, message: &Value) {
        let text = rpc::text_of(message);
        let error =
            (message.get("stopReason").and_then(Value::as_str) == Some("error")).then(|| {
                message
                    .get("errorMessage")
                    .and_then(Value::as_str)
                    .unwrap_or("The model request failed")
                    .to_string()
            });
        if let Some(Entry::Assistant {
            text: current,
            blocks,
            error: current_error,
            ..
        }) = self
            .active_assistant
            .take()
            .and_then(|index| self.entries.get_mut(index))
        {
            blocks.clear();
            if let Some(content) = message.get("content").and_then(Value::as_array) {
                for (index, block) in content.iter().enumerate() {
                    let (thinking, value) = match block.get("type").and_then(Value::as_str) {
                        Some("text") => (false, block.get("text")),
                        Some("thinking") => (true, block.get("thinking")),
                        _ => continue,
                    };
                    if let Some(value) = value.and_then(Value::as_str).filter(|s| !s.is_empty()) {
                        blocks.insert(index, AssistantBlock::new(thinking, value.to_string()));
                    }
                }
            } else if !text.is_empty() {
                blocks.insert(0, AssistantBlock::new(false, text.clone()));
            }
            *current = text.clone();
            *current_error = error.clone();
        }
        self.last_text = text;
        self.last_error = error;
    }

    /// Applies one live event. Returns true when the transcript changed.
    pub fn apply(&mut self, event: &Incoming) -> bool {
        match event {
            Incoming::MessageStart { message } => match rpc::role(message) {
                "user" => self.entries.push(Entry::User {
                    text: rpc::text_of(message),
                }),
                "assistant" => self.start_assistant(),
                _ => return false,
            },
            Incoming::TextDelta { index, delta } => {
                return self.update_block(*index, false, delta, false);
            }
            Incoming::ThinkingDelta { index, delta } => {
                return self.update_block(*index, true, delta, false);
            }
            Incoming::TextEnd { index, content } => {
                return self.update_block(*index, false, content, true);
            }
            Incoming::ThinkingEnd { index, content } => {
                return self.update_block(*index, true, content, true);
            }
            Incoming::MessageEnd { message } if rpc::role(message) == "assistant" => {
                self.finish_assistant(message)
            }
            Incoming::ToolStart { id, name, args } => self.start_tool(id, name, args),
            Incoming::ToolEnd {
                id,
                result,
                is_error,
                ..
            } => self.finish_tool(id, result, *is_error),
            Incoming::CompactionStart => self.note("Compacting context"),
            Incoming::CompactionEnd { aborted, error } => {
                if let Some(error) = error {
                    self.note(error.clone());
                } else if *aborted {
                    self.note("Compaction cancelled");
                } else {
                    self.note("Context compacted");
                }
            }
            Incoming::ExtensionError { error } => self.note(format!("Extension error: {error}")),
            Incoming::RetryFailed { error } => self.note(format!("Retries failed: {error}")),
            _ => return false,
        }
        true
    }

    pub fn from_messages<'a>(messages: impl IntoIterator<Item = &'a Value>) -> Self {
        let mut transcript = Transcript::default();
        for message in messages {
            match rpc::role(message) {
                "user" => transcript.entries.push(Entry::User {
                    text: rpc::text_of(message),
                }),
                "assistant" => {
                    transcript.start_assistant();
                    transcript.finish_assistant(message);
                    // Tool-only messages do not need an empty assistant row.
                    if matches!(transcript.entries.last(), Some(Entry::Assistant { blocks, error: None, .. }) if blocks.is_empty())
                    {
                        transcript.entries.pop();
                    }
                    for block in message
                        .get("content")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                    {
                        if block.get("type").and_then(Value::as_str) == Some("toolCall") {
                            let id = block.get("id").and_then(Value::as_str).unwrap_or_default();
                            let name = block
                                .get("name")
                                .and_then(Value::as_str)
                                .unwrap_or_default();
                            transcript.start_tool(
                                id,
                                name,
                                block.get("arguments").unwrap_or(&Value::Null),
                            );
                        }
                    }
                }
                "toolResult" => {
                    let id = message
                        .get("toolCallId")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let failed = message
                        .get("isError")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    transcript.finish_tool(id, message, failed);
                }
                "compactionSummary" => transcript.note("Context compacted"),
                _ => {}
            }
        }
        // Calls without results were interrupted, not still running.
        for entry in &mut transcript.entries {
            if let Entry::Tool { running, .. } = entry {
                *running = false;
            }
        }
        transcript
    }

    /// Reads the active branch of a Pi session file: the chain of parents
    /// from the last entry back to the root.
    pub fn from_session_file(path: &Path) -> Result<Self, String> {
        let text = std::fs::read_to_string(path)
            .map_err(|error| format!("{}: {error}", path.display()))?;
        let mut entries: HashMap<String, (Option<String>, Option<Value>)> = HashMap::new();
        let mut last = None;
        for line in text.lines().filter(|line| !line.trim().is_empty()) {
            let Ok(record) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            let Some(id) = record.get("id").and_then(Value::as_str) else {
                continue;
            };
            if record.get("type").and_then(Value::as_str) == Some("session") {
                continue;
            }
            let parent = record
                .get("parentId")
                .and_then(Value::as_str)
                .map(str::to_string);
            let message = (record.get("type").and_then(Value::as_str) == Some("message"))
                .then(|| record["message"].clone());
            entries.insert(id.to_string(), (parent, message));
            last = Some(id.to_string());
        }
        let mut chain = Vec::new();
        let mut cursor = last;
        while let Some(id) = cursor {
            let Some((parent, message)) = entries.remove(&id) else {
                break;
            };
            if let Some(message) = message {
                chain.push(message);
            }
            cursor = parent;
        }
        chain.reverse();
        Ok(Transcript::from_messages(chain.iter()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn texts(transcript: &Transcript) -> Vec<String> {
        transcript
            .entries
            .iter()
            .map(|entry| match entry {
                Entry::User { text } => format!("user: {text}"),
                Entry::Assistant { text, error, .. } => format!(
                    "assistant: {text}{}",
                    error
                        .as_deref()
                        .map(|e| format!(" [{e}]"))
                        .unwrap_or_default()
                ),
                Entry::Tool {
                    name,
                    preview,
                    output,
                    running,
                    ..
                } => format!(
                    "tool {name}({preview}) -> {output}{}",
                    if *running { " …" } else { "" }
                ),
                Entry::Note { text } => format!("note: {text}"),
            })
            .collect()
    }

    #[test]
    fn live_events_stream_text_and_tools() {
        let mut transcript = Transcript::default();
        let events = [
            Incoming::MessageStart {
                message: json!({"role":"user","content":"Fix it"}),
            },
            Incoming::MessageStart {
                message: json!({"role":"assistant","content":[]}),
            },
            Incoming::TextDelta {
                index: 0,
                delta: "Look".into(),
            },
            Incoming::TextDelta {
                index: 0,
                delta: "ing".into(),
            },
            Incoming::ToolStart {
                id: "t1".into(),
                name: "bash".into(),
                args: json!({"command":"cargo test"}),
            },
        ];
        for event in &events {
            assert!(transcript.apply(event));
        }
        assert_eq!(
            texts(&transcript),
            [
                "user: Fix it",
                "assistant: Looking",
                "tool bash(cargo test) ->  …"
            ]
        );
        transcript.apply(&Incoming::ToolEnd {
            id: "t1".into(),
            name: "bash".into(),
            result: json!({"content":[{"type":"text","text":"ok"}]}),
            is_error: false,
        });
        transcript.apply(&Incoming::MessageEnd { message: json!({"role":"assistant","content":[{"type":"text","text":"Looking good"}],"stopReason":"stop"}) });
        assert_eq!(
            texts(&transcript),
            [
                "user: Fix it",
                "assistant: Looking good",
                "tool bash(cargo test) -> ok"
            ]
        );
        assert_eq!(transcript.last_text, "Looking good");
        assert!(!transcript.apply(&Incoming::AgentStart));
    }

    #[test]
    fn saved_messages_pair_tool_calls_with_results_and_keep_errors() {
        let messages = [
            json!({"role":"system","content":""}),
            json!({"role":"user","content":[{"type":"text","text":"Go"}]}),
            json!({"role":"assistant","content":[{"type":"toolCall","id":"a","name":"read","arguments":{"path":"src/main.rs"}},{"type":"toolCall","id":"b","name":"bash","arguments":{"command":"sleep 9"}}],"stopReason":"toolUse"}),
            json!({"role":"toolResult","toolCallId":"a","toolName":"read","content":[{"type":"text","text":"fn main"}],"isError":false}),
            json!({"role":"assistant","content":[{"type":"text","text":"Partial"}],"stopReason":"error","errorMessage":"overloaded"}),
        ];
        let transcript = Transcript::from_messages(messages.iter());
        assert_eq!(
            texts(&transcript),
            [
                "user: Go",
                "tool read(src/main.rs) -> fn main",
                "tool bash(sleep 9) -> ",
                "assistant: Partial [overloaded]"
            ]
        );
        assert_eq!(transcript.last_error.as_deref(), Some("overloaded"));
    }

    #[test]
    fn session_files_follow_the_active_branch() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.jsonl");
        let lines = [
            json!({"type":"session","id":"s","cwd":"/x"}),
            json!({"type":"message","id":"1","parentId":null,"message":{"role":"user","content":"first"}}),
            json!({"type":"message","id":"2","parentId":"1","message":{"role":"assistant","content":[{"type":"text","text":"abandoned"}]}}),
            json!({"type":"label","id":"3","parentId":"1"}),
            json!({"type":"message","id":"4","parentId":"3","message":{"role":"assistant","content":[{"type":"text","text":"kept"}]}}),
        ];
        std::fs::write(
            &path,
            lines
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n"),
        )
        .unwrap();
        let transcript = Transcript::from_session_file(&path).unwrap();
        assert_eq!(texts(&transcript), ["user: first", "assistant: kept"]);
    }
}
