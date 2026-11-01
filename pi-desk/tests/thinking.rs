//! Transcript behavior through the RPC parser and saved-message interface.
use pi_desk::rpc;
use pi_desk::transcript::{AssistantBlock, Entry, Transcript};
use serde_json::{Value, json};

fn apply(transcript: &mut Transcript, record: Value) {
    assert!(transcript.apply(&rpc::parse(&record.to_string()).unwrap()));
}

fn update(transcript: &mut Transcript, kind: &str, index: usize, value: &str) {
    apply(
        transcript,
        json!({"type":"message_update", "assistantMessageEvent":{
            "type":kind, "contentIndex":index, "delta":value, "content":value
        }}),
    );
}

fn blocks(transcript: &Transcript, entry: usize) -> Vec<(usize, bool, &str)> {
    let Entry::Assistant { blocks, .. } = &transcript.entries[entry] else {
        panic!("expected an assistant message");
    };
    blocks
        .iter()
        .map(|(index, block)| match block {
            AssistantBlock::Thinking { text } => (*index, true, text.as_str()),
            AssistantBlock::Text { text, .. } => (*index, false, text.as_str()),
        })
        .collect()
}

#[test]
fn thinking_streams_in_content_order_and_final_content_is_authoritative() {
    let mut transcript = Transcript::default();
    apply(
        &mut transcript,
        json!({"type":"message_start","message":{"role":"assistant","content":[]}}),
    );
    update(&mut transcript, "thinking_start", 0, "");
    assert_eq!(blocks(&transcript, 0), [(0, true, "")]);
    update(&mut transcript, "thinking_delta", 0, "Check ");
    update(&mut transcript, "thinking_delta", 0, "the caller");
    update(&mut transcript, "text_start", 1, "");
    update(&mut transcript, "text_delta", 1, "A reply");
    update(&mut transcript, "thinking_delta", 2, "Another thought");
    assert_eq!(
        blocks(&transcript, 0),
        [
            (0, true, "Check the caller"),
            (1, false, "A reply"),
            (2, true, "Another thought"),
        ]
    );
    update(&mut transcript, "thinking_end", 0, "Checked the caller");
    update(&mut transcript, "text_end", 1, "A complete reply");
    assert_eq!(blocks(&transcript, 0)[0], (0, true, "Checked the caller"));
    assert_eq!(blocks(&transcript, 0)[1], (1, false, "A complete reply"));

    let message = json!({"role":"assistant", "content":[
        {"type":"thinking","thinking":"Final thought"},
        {"type":"text","text":"Final reply"},
        {"type":"thinking","thinking":"Second final thought"}
    ],"stopReason":"stop"});
    apply(
        &mut transcript,
        json!({"type":"message_end","message":message}),
    );
    let saved = Transcript::from_messages([&message]);
    assert_eq!(blocks(&transcript, 0), blocks(&saved, 0));
    assert_eq!(
        blocks(&transcript, 0),
        [
            (0, true, "Final thought"),
            (1, false, "Final reply"),
            (2, true, "Second final thought"),
        ]
    );
    assert_eq!(transcript.last_text, "Final reply");
    assert_eq!(transcript.last_text, saved.last_text);
    // Late deltas must not append to a completed message.
    let event = rpc::parse(r#"{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","contentIndex":0,"delta":"late"}}"#).unwrap();
    assert!(!transcript.apply(&event));
}

#[test]
fn thinking_only_messages_and_failures_do_not_become_answer_summaries() {
    let messages = [
        json!({"role":"assistant","content":[{"type":"thinking","thinking":"First thought"}],"stopReason":"stop"}),
        json!({"role":"assistant","content":[{"type":"thinking","thinking":"Second thought"}],"stopReason":"error","errorMessage":"Interrupted"}),
    ];
    let transcript = Transcript::from_messages(messages.iter());
    assert_eq!(blocks(&transcript, 0), [(0, true, "First thought")]);
    assert_eq!(blocks(&transcript, 1), [(0, true, "Second thought")]);
    assert_eq!(transcript.last_text, "");
    assert_eq!(transcript.last_error.as_deref(), Some("Interrupted"));
}

#[test]
fn final_messages_replace_partial_blocks_and_keep_tool_results() {
    let mut transcript = Transcript::default();
    apply(
        &mut transcript,
        json!({"type":"message_start","message":{"role":"assistant","content":[]}}),
    );
    update(
        &mut transcript,
        "thinking_delta",
        0,
        "Discard this partial thought",
    );
    let message = json!({"role":"assistant","content":[
        {"type":"thinking","thinking":"Plan a read"},
        {"type":"toolCall","id":"read-1","name":"read","arguments":{"path":"README.md"}}
    ],"stopReason":"toolUse"});
    apply(
        &mut transcript,
        json!({"type":"message_end","message":message}),
    );
    apply(
        &mut transcript,
        json!({"type":"tool_execution_start","toolCallId":"read-1","toolName":"read","args":{"path":"README.md"}}),
    );
    apply(
        &mut transcript,
        json!({"type":"tool_execution_end","toolCallId":"read-1","toolName":"read","result":{"content":[{"type":"text","text":"File contents"}]},"isError":false}),
    );
    assert_eq!(blocks(&transcript, 0), [(0, true, "Plan a read")]);
    assert!(
        matches!(&transcript.entries[1], Entry::Tool { output, running: false, .. } if output == "File contents")
    );

    apply(
        &mut transcript,
        json!({"type":"message_start","message":{"role":"assistant","content":[]}}),
    );
    update(&mut transcript, "thinking_delta", 0, "Temporary");
    apply(
        &mut transcript,
        json!({"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Only the reply remains"}]}}),
    );
    assert_eq!(
        blocks(&transcript, 2),
        [(0, false, "Only the reply remains")]
    );
    assert_eq!(blocks(&transcript, 0), [(0, true, "Plan a read")]);
}

#[test]
fn thinking_identity_survives_reloading_after_tool_only_messages() {
    let messages = [
        json!({"role":"assistant","content":[{"type":"toolCall","id":"a","name":"read","arguments":{}}]}),
        json!({"role":"assistant","content":[{"type":"thinking","thinking":"After the tool"}]}),
    ];
    let mut live = Transcript::default();
    for message in &messages {
        apply(
            &mut live,
            json!({"type":"message_start","message":{"role":"assistant","content":[]}}),
        );
        apply(&mut live, json!({"type":"message_end","message":message}));
    }
    let saved = Transcript::from_messages(messages.iter());
    let identity = |transcript: &Transcript| {
        transcript
            .entries
            .iter()
            .find_map(|entry| match entry {
                Entry::Assistant { id, blocks, .. } if !blocks.is_empty() => Some(*id),
                _ => None,
            })
            .unwrap()
    };
    assert_eq!(identity(&live), 1);
    assert_eq!(identity(&live), identity(&saved));
}

#[test]
fn saved_thinking_keeps_unicode_but_not_signatures_or_empty_blocks() {
    let messages = [json!({"role":"assistant","content":[
        {"type":"thinking","thinking":"検討する\n\nCheck 🦀","thinkingSignature":"private-signature"},
        {"type":"thinking","thinking":"","thinkingSignature":"signature-only"},
        {"type":"text","text":"Done"}
    ]})];
    let transcript = Transcript::from_messages(messages.iter());
    assert_eq!(
        blocks(&transcript, 0),
        [(0, true, "検討する\n\nCheck 🦀"), (2, false, "Done")]
    );
}
