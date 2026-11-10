use super::{card, empty, faint, hrule, icon, keys, label, mono, primary, send, vrule};
use crate::app::{App, Message, Tab};
use crate::git::LineKind;
use crate::highlight::SHOWN_LINES;
use crate::icon::{Icon, KeyPart};
use crate::model::Status;
use crate::theme::{self, P, size};
use crate::transcript::{AssistantBlock, Entry, ToolImage};
use rune::{Color, El, GrowthSpec, ScrollSpec, Span, SurfaceFit, col, el, rich, row, text};
use rune_kit::Markdown;

/// The right pane in list layout: the card above its tabs.
pub fn pane(app: &App) -> El {
    let content = if app.desk.state.projects.is_empty() {
        col()
            .key("welcome")
            .w_full()
            .grow(1.0)
            .center()
            .gap(10.0)
            .child(label("Add a project to start", size::HEADING, P.muted))
            .child(faint(
                "pi-desk runs each task as a Pi agent in your checkout or in its own git worktree.",
            ))
            .child(primary(
                "welcome-add-project",
                "Add project",
                &[],
                Some(Message::AddProject),
                false,
            ))
    } else if app.current().is_some() {
        col()
            .key("detail-stack")
            .w_full()
            .grow(1.0)
            .min_h(0.0)
            .gap(16.0)
            .child(card::view(app))
            .child(view(app))
    } else {
        empty(
            "nothing-selected",
            "Nothing selected",
            "Choose a row, or press N to file work.",
        )
    };
    col()
        .key("detail")
        .grow(1.0)
        .shrink()
        .h_full()
        .min_w(0.0)
        .padding(20.0)
        .child(content)
}

fn tab(key: &str, name: String, hint: &'static str, active: bool, message: Message) -> El {
    col()
        .key(key)
        .gap(6.0)
        .label(name.clone())
        .role("tab")
        .on_press_tx(send(message))
        .child(
            row()
                .gap(6.0)
                .center_y()
                .px(4.0)
                .pt(6.0)
                .child(
                    text(name)
                        .font(theme::medium(size::CONTROL))
                        .color(if active { P.text } else { P.muted }),
                )
                .child(keys(&[KeyPart::Text(hint)])),
        )
        .child(el().h(2.0).w_full().radius(1.0).fill(if active {
            P.accent
        } else {
            Color::TRANSPARENT
        }))
}

/// Tabs and their content below the card.
pub fn view(app: &App) -> El {
    let Some(agent) = app.current() else {
        return el();
    };
    let diff = app.diffs.get(&agent.id);
    let counts = diff
        .and_then(|diff| diff.files.as_ref().ok())
        .filter(|files| !files.is_empty())
        .map(|files| {
            let added: usize = files.iter().map(|file| file.added).sum();
            let removed: usize = files.iter().map(|file| file.removed).sum();
            format!("Diff  +{added} -{removed}")
        })
        .unwrap_or_else(|| "Diff".into());
    let transcript_active = app.tab == Tab::Transcript;
    let tabs = row()
        .key("tabs")
        .gap(16.0)
        .child(tab(
            "tab-transcript",
            "Transcript".into(),
            "T",
            transcript_active,
            Message::SetTab(Tab::Transcript),
        ))
        .child(tab(
            "tab-diff",
            counts,
            "D",
            !transcript_active,
            Message::SetTab(Tab::Diff),
        ));

    let content = match app.tab {
        Tab::Transcript => transcript(app, &agent.id),
        Tab::Diff => diff_view(app, &agent.id),
    };
    col()
        .key("tabbed")
        .w_full()
        .grow(1.0)
        // Keep room for the tabs and some content; the card scrolls instead.
        .min_h(180.0)
        .child(tabs)
        .child(hrule("tabs-rule"))
        .child(content)
}

fn panel(content: El) -> El {
    content
        .w_full()
        .padding(12.0)
        .radius(8.0)
        .fill(P.surface)
        .border(1.0, P.border_soft)
}

fn disclosure(key: String, open: bool, parts: Vec<El>, message: Message) -> El {
    super::selectable(
        row()
            .key(key)
            .w_full()
            .h(26.0)
            .px(6.0)
            .gap(8.0)
            .center_y()
            .role("button")
            .on_press_tx(send(message))
            .child(icon(Icon::disclosure(open), size::CAPTION, P.faint))
            .children(parts),
        false,
    )
    .radius(6.0)
}

fn transcript(app: &App, id: &str) -> El {
    let Some(transcript) = app
        .desk
        .transcripts
        .get(id)
        .filter(|transcript| !transcript.entries.is_empty())
    else {
        if app.reading_transcript(id) {
            return empty("reading-transcript", "Loading…", "");
        }
        return empty(
            "no-transcript",
            "No transcript yet",
            "It appears once the agent starts.",
        );
    };
    // Long sessions have thousands of entries. Only the rows near the
    // viewport are built and laid out, so rebuilding for each streamed
    // update stays cheap.
    let task = id.to_string();
    let entries = col()
        .key("entries")
        .w_full()
        .px(4.0)
        .py(14.0)
        .growth(GrowthSpec::default())
        .virtual_rows(
            transcript.entries.len() + transcript.waiting.len(),
            48.0,
            |_: &App, index| format!("entry-{index}").into(),
            move |app: &App, index| entry_row(app, &task, index),
        );
    col()
        .key(format!("transcript-{id}"))
        .w_full()
        .grow(1.0)
        .min_h(0.0)
        .scroll(ScrollSpec { stick_bottom: true })
        .scroll_edge_fade(12.0)
        .child(entries)
}

/// One transcript entry, with the gap above it.
fn entry_row(app: &App, id: &str, index: usize) -> El {
    let Some(transcript) = app.desk.transcripts.get(id) else {
        return el();
    };
    let Some(entry) = transcript.entries.get(index) else {
        // Replies the agent has not read yet follow the transcript.
        let Some(reply) = transcript.waiting.get(index - transcript.entries.len()) else {
            return el();
        };
        return col().w_full().pt(12.0).child(panel(
            col()
                .gap(4.0)
                .child(faint(
                    "You · waiting for the agent to finish its current step",
                ))
                .child(
                    label(reply.as_str(), size::BODY, P.muted)
                        .wrap()
                        .selectable(true),
                ),
        ));
    };
    let working = app
        .current()
        .is_some_and(|agent| agent.status == Status::Working);
    let style = theme::markdown();
    let last = transcript.entries.len() - 1;
    let element = match entry {
        Entry::User { text: message } => panel(
            col().gap(4.0).child(faint("You")).child(
                label(message.as_str(), size::BODY, P.text)
                    .wrap()
                    .selectable(true),
            ),
        ),
        Entry::Assistant {
            id: message_id,
            blocks,
            error,
            ..
        } => {
            let mut content = col().w_full().gap(6.0);
            for (block_index, block) in blocks {
                let block_key = format!("b{block_index}");
                match block {
                    AssistantBlock::Text { text } => {
                        let live = working && index == last;
                        content = content.child(
                            Markdown::new(text.as_str())
                                .streaming(live)
                                .selectable(true)
                                .render(&style)
                                .key(block_key)
                                .w_full(),
                        );
                    }
                    AssistantBlock::Thinking { text: thinking } => {
                        let open = app.expanded_thinking.contains(&(
                            id.to_string(),
                            *message_id,
                            *block_index,
                        ));
                        content = content.child(disclosure(
                            block_key.clone(),
                            open,
                            vec![
                                label("Thinking", size::CAPTION, P.muted),
                                label(crate::text::one_line(thinking, 110), size::CAPTION, P.faint)
                                    .grow(1.0)
                                    .shrink()
                                    .truncate(),
                            ],
                            Message::ToggleThinking(id.to_string(), *message_id, *block_index),
                        ));
                        if open && !thinking.is_empty() {
                            content = content.child(
                                panel(
                                    label(thinking.as_str(), size::CONTROL, P.muted)
                                        .wrap()
                                        .selectable(true),
                                )
                                .key(format!("{block_key}-open")),
                            );
                        }
                    }
                }
            }
            if let Some(error) = error {
                content = content.child(
                    label(error.as_str(), size::CONTROL, P.red)
                        .wrap()
                        .key("error"),
                );
            }
            content
        }
        Entry::Tool {
            id: tool,
            name,
            preview,
            output,
            images,
            is_error,
            running,
        } => {
            let open = app.expanded.contains(tool);
            let state = if *running {
                "…"
            } else if *is_error {
                "failed"
            } else {
                ""
            };
            let head = disclosure(
                "head".into(),
                open,
                vec![
                    mono(name.as_str(), size::CAPTION, P.accent),
                    mono(crate::text::one_line(preview, 110), size::CAPTION, P.muted)
                        .grow(1.0)
                        .shrink()
                        .truncate(),
                    label(
                        state,
                        size::CAPTION,
                        if *is_error { P.red } else { P.faint },
                    ),
                ],
                Message::ToggleTool(tool.clone()),
            );
            let mut column = col().w_full().gap(4.0).child(head);
            if open && !output.is_empty() {
                column = column.child(
                    panel(
                        mono(
                            output.as_str(),
                            size::CAPTION,
                            if *is_error { P.red } else { P.text },
                        )
                        .wrap_anywhere()
                        .selectable(true),
                    )
                    .key("output"),
                );
            }
            if open {
                for (image_index, image) in images.iter().enumerate() {
                    column = column.child(
                        panel(col().child(tool_image(app, image)))
                            .key(format!("image-{image_index}")),
                    );
                }
            }
            column
        }
        Entry::Note { text: note } => faint(note.as_str()).wrap(),
    };
    col()
        .w_full()
        .pt(if index == 0 { 0.0 } else { 12.0 })
        .child(element)
}

/// The largest box a tool-result image draws in, in points.
const TOOL_IMAGE_BOX: (f32, f32) = (480.0, 360.0);

/// A tool-result image at one point per pixel, scaled down to fit
/// `TOOL_IMAGE_BOX` and narrow panes. The element holds the image's pixels
/// from the first frame, which keeps the decode in the cache.
///
/// The size is explicit because a transcript row measured with an aspect
/// ratio scrolls the transcript when it expands.
fn tool_image(app: &App, image: &ToolImage) -> El {
    let note = |text: String| faint(text).wrap();
    let Some(cache) = app.images.as_ref() else {
        return note(format!("Image ({})", image.mime));
    };
    let picture = cache.load_mime(image.bytes.clone(), &image.mime, 512.0, 2.0);
    if let Some(error) = picture.error() {
        return note(format!("Could not show the image: {error}"));
    }
    let element = el()
        .role("image")
        .pixels_fit(picture.pixels(), SurfaceFit::Fit);
    let Some([width, height]) = picture.size() else {
        return element.size(0.0, 0.0);
    };
    let (width, height) = (width.max(1) as f32, height.max(1) as f32);
    let scale = (TOOL_IMAGE_BOX.0 / width)
        .min(TOOL_IMAGE_BOX.1 / height)
        .min(1.0);
    // In a row, the image narrows with the pane and letterboxes.
    row().w_full().child(
        element
            .label("Image the tool returned")
            .size(width * scale, height * scale)
            .shrink()
            .min_w(0.0)
            .radius(4.0),
    )
}

fn diff_view(app: &App, id: &str) -> El {
    let Some(diff) = app.diffs.get(id) else {
        return empty("no-diff", "No diff", "The worktree has not been created yet.");
    };
    let files = match &diff.files {
        Err(error) => return empty("diff-error", "Could not read the diff", error),
        Ok(files) if files.is_empty() => {
            return empty(
                "no-changes",
                if diff.loading {
                    "Loading…"
                } else {
                    "No changes yet"
                },
                "",
            );
        }
        Ok(files) => files,
    };
    let mut list = col().key("files").w_full().gap(1.0).py(8.0).pr(8.0);
    for (index, file) in files.iter().enumerate() {
        list = list.child(super::selectable(
            row()
                .key(format!("file-{index}"))
                .w_full()
                .h(26.0)
                .px(8.0)
                .gap(6.0)
                .center_y()
                .role("button")
                .label(file.path.as_str())
                .on_press_tx(send(Message::SelectFile(index)))
                .child(
                    mono(file.path.as_str(), size::CAPTION, P.text)
                        .grow(1.0)
                        .shrink()
                        .truncate_head(),
                )
                .child(label(format!("+{}", file.added), size::CAPTION, P.green))
                .child(label(format!("-{}", file.removed), size::CAPTION, P.red)),
            index == diff.selected,
        )
        .radius(6.0));
    }
    let selected = diff.selected.min(files.len() - 1);
    let file = &files[selected];
    let colors = diff.colors.get(&selected);
    let mut lines = Vec::new();
    for (index, line) in file.lines.iter().enumerate().take(SHOWN_LINES) {
        let (background, prefix, base) = match line.kind {
            LineKind::Added => (P.added_bg, "+", P.green),
            LineKind::Removed => (P.removed_bg, "-", P.red),
            LineKind::Context => (Color::TRANSPARENT, " ", P.text),
            LineKind::Hunk => (P.hunk_bg, "", P.accent),
            LineKind::Meta => (Color::TRANSPARENT, "", P.faint),
        };
        let content = format!("{prefix}{}", line.text);
        let offset = prefix.len();
        let mut spans = vec![Span::new(0, offset).color(base)];
        match colors
            .and_then(|colors| colors.get(index))
            .filter(|spans| !spans.is_empty())
        {
            Some(colored) => spans.extend(colored.iter().map(|(range, color)| {
                Span::new(range.start + offset, range.end + offset).color(color.unwrap_or(P.text))
            })),
            None => spans.push(Span::new(offset, content.len()).color(
                if line.kind == LineKind::Context {
                    P.text
                } else {
                    base
                },
            )),
        }
        lines.push(
            row()
                .key(format!("diff-line-{index}"))
                .w_full()
                .px(12.0)
                .fill(background)
                .child(
                    rich(content, spans)
                        .font(theme::mono(size::CAPTION))
                        .color(P.text)
                        .wrap_anywhere()
                        .shrink(),
                ),
        );
    }
    if file.lines.len() > SHOWN_LINES {
        lines.push(
            faint(format!(
                "{} more lines. Open the editor to see the rest.",
                file.lines.len() - SHOWN_LINES
            ))
            .key("more-lines")
            .padding(10.0),
        );
    }
    row()
        .key(format!("diff-{id}"))
        .w_full()
        .grow(1.0)
        .min_h(0.0)
        .child(
            col()
                .key("files-scroll")
                .w(240.0)
                .h_full()
                .scroll(ScrollSpec { stick_bottom: false })
                .child(list),
        )
        .child(vrule("files-rule"))
        .child(
            col()
                .key(format!("lines-{selected}"))
                .grow(1.0)
                .shrink()
                .min_w(0.0)
                .h_full()
                .scroll(ScrollSpec { stick_bottom: false })
                .scroll_edge_fade(12.0)
                .child(
                    col()
                        .key("lines")
                        .w_full()
                        .py(8.0)
                        .growth(GrowthSpec::default())
                        .virtualize(17.0)
                        .children(lines),
                ),
        )
}
