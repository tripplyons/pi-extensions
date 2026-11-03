use super::*;
use iced::advanced::renderer::Headless;
use iced::{Color, Pixels};
use std::time::{Duration, Instant};

fn renderer() -> Renderer {
    iced::futures::executor::block_on(<Renderer as Headless>::new(
        theme::SANS,
        Pixels(theme::size::CONTROL),
        Some("tiny-skia"),
    ))
    .expect("headless renderer")
}

fn layout(
    value: &mut LiveText,
    tree: &mut widget::Tree,
    renderer: &Renderer,
    width: f32,
) -> layout::Node {
    value.layout(
        tree,
        renderer,
        &layout::Limits::new(Size::ZERO, Size::new(width, 2000.0)),
    )
}

fn frame(
    value: &mut LiveText,
    tree: &mut widget::Tree,
    renderer: &Renderer,
    node: &layout::Node,
    now: Instant,
) -> iced::window::RedrawRequest {
    let mut messages = Vec::new();
    let mut shell = Shell::new(&mut messages);
    value.update(
        tree,
        &Event::Window(iced::window::Event::RedrawRequested(now)),
        Layout::new(node),
        mouse::Cursor::Unavailable,
        renderer,
        &mut iced::advanced::clipboard::Null,
        &mut shell,
        &Rectangle::with_size(Size::new(400.0, 2000.0)),
    );
    shell.redraw_request()
}

fn active(tree: &widget::Tree) -> Vec<(usize, Instant)> {
    super::super::line_reveal::active_lines(tree)
}

#[test]
fn plain_and_markdown_tokens_update_immediately_without_replaying_visible_lines() {
    let renderer = renderer();
    for markdown in [false, true] {
        let mut value = LiveText::new("a:1".into(), "Visible".into(), markdown);
        let mut tree = widget::Tree::new(&value as &dyn Widget<Message, Theme, Renderer>);
        layout(&mut value, &mut tree, &renderer, 200.0);
        assert!(
            active(&tree).is_empty(),
            "history is static on first layout"
        );
        for suffix in [" text", " text that", " text that grows"] {
            value.value = format!("Visible{suffix}");
            value.diff(&mut tree);
            layout(&mut value, &mut tree, &renderer, 200.0);
            assert!(
                active(&tree).is_empty(),
                "tokens on a visible line must stay still"
            );
            assert_eq!(tree.state.downcast_ref::<State>().value, value.value);
        }
        value.value.push_str(" and wraps onto another visible line");
        value.diff(&mut tree);
        let node = layout(&mut value, &mut tree, &renderer, 200.0);
        let started = active(&tree);
        assert!(!started.is_empty(), "wrapped rows must enter");
        assert_eq!(
            frame(&mut value, &mut tree, &renderer, &node, Instant::now()),
            iced::window::RedrawRequest::NextFrame
        );
        value.value.push('.');
        value.diff(&mut tree);
        layout(&mut value, &mut tree, &renderer, 200.0);
        assert_eq!(
            active(&tree),
            started,
            "tokens must not restart entrance clocks"
        );
        let redraw = frame(
            &mut value,
            &mut tree,
            &renderer,
            &node,
            Instant::now() + Duration::from_secs(1),
        );
        assert_ne!(redraw, iced::window::RedrawRequest::NextFrame);
        layout(&mut value, &mut tree, &renderer, 200.0);
        assert!(
            active(&tree).is_empty(),
            "no pending snapshot should replay"
        );
        layout(&mut value, &mut tree, &renderer, 100.0);
        assert!(
            active(&tree).is_empty(),
            "resize must not replay wrapped rows"
        );
        value.key = "b:1".into();
        value.diff(&mut tree);
        layout(&mut value, &mut tree, &renderer, 200.0);
        assert!(
            active(&tree).is_empty(),
            "switching tasks shows static history"
        );
    }
}

#[test]
fn explicit_lines_and_new_markdown_blocks_enter_once() {
    let renderer = renderer();
    for (initial, addition, markdown) in [
        ("First line", "\nSecond line", false),
        ("First paragraph", "\n\nSecond **paragraph**", true),
        ("- First item", "\n- Second item", true),
        ("```rs\nlet a = 1;\n", "let b = 2;\n", true),
    ] {
        let mut value = LiveText::new("a:1".into(), initial.into(), markdown);
        let mut tree = widget::Tree::new(&value as &dyn Widget<Message, Theme, Renderer>);
        layout(&mut value, &mut tree, &renderer, 300.0);
        value.value.push_str(addition);
        value.diff(&mut tree);
        let node = layout(&mut value, &mut tree, &renderer, 300.0);
        assert!(
            !active(&tree).is_empty(),
            "new block did not enter: {addition:?}"
        );
        let started = active(&tree);
        value.diff(&mut tree);
        layout(&mut value, &mut tree, &renderer, 300.0);
        assert_eq!(active(&tree), started);
        frame(
            &mut value,
            &mut tree,
            &renderer,
            &node,
            Instant::now() + Duration::from_secs(1),
        );
        assert!(active(&tree).is_empty());
    }
}

#[test]
fn settled_rows_keep_identical_pixels_while_the_new_row_enters() {
    let mut renderer = renderer();
    let mut value = LiveText::new("a:1".into(), "First visible row".into(), false);
    let mut tree = widget::Tree::new(&value as &dyn Widget<Message, Theme, Renderer>);
    let initial = layout(&mut value, &mut tree, &renderer, 300.0);
    let size = Size::new(400, 200);
    let viewport = Rectangle::with_size(Size::new(400.0, 200.0));
    let style = renderer::Style {
        text_color: theme::TEXT,
    };
    value.draw(
        &tree,
        &mut renderer,
        &theme::theme(),
        &style,
        Layout::new(&initial),
        mouse::Cursor::Unavailable,
        &viewport,
    );
    let before = renderer.screenshot(size, 1.0, Color::BLACK);
    iced::advanced::Renderer::reset(&mut renderer, viewport);
    value.value.push_str("\nA new row");
    value.diff(&mut tree);
    let node = layout(&mut value, &mut tree, &renderer, 300.0);
    value.draw(
        &tree,
        &mut renderer,
        &theme::theme(),
        &style,
        Layout::new(&node),
        mouse::Cursor::Unavailable,
        &viewport,
    );
    let entering = renderer.screenshot(size, 1.0, Color::BLACK);
    let first_row = 400 * (theme::size::CONTROL * theme::LINE_HEIGHT).floor() as usize * 4;
    let changed_pixel = before[..first_row]
        .chunks(4)
        .zip(entering[..first_row].chunks(4))
        .enumerate()
        .find(|(_, (a, b))| a != b);
    assert!(
        changed_pixel.is_none(),
        "settled row changed: {changed_pixel:?}"
    );
    assert!(before.chunks_exact(4).any(|pixel| pixel[..3] != [0, 0, 0]));
    frame(
        &mut value,
        &mut tree,
        &renderer,
        &node,
        Instant::now() + Duration::from_secs(1),
    );
    iced::advanced::Renderer::reset(&mut renderer, viewport);
    value.draw(
        &tree,
        &mut renderer,
        &theme::theme(),
        &style,
        Layout::new(&node),
        mouse::Cursor::Unavailable,
        &viewport,
    );
    let settled = renderer.screenshot(size, 1.0, Color::BLACK);
    assert!(entering != settled, "the entering row must visibly slide");
    assert!(before[..first_row] == settled[..first_row]);
}

#[test]
fn prose_emphasis_and_links_preserve_the_shared_font_roles() {
    let content =
        markdown::Content::parse("Plain **strong** *italic* `code` [guide](https://example.com)");
    let markdown::Item::Paragraph(value) = &content.items()[0] else {
        panic!("expected paragraph")
    };
    let spans = prose_spans(value, super::super::detail::markdown_settings().style);
    for span in spans {
        let font = span.font.unwrap();
        if span.text.as_ref() == "code" {
            assert_eq!(font.family, theme::MONO.family);
        } else {
            assert_eq!(font.family, theme::SANS.family);
            assert_ne!(font.weight, iced::font::Weight::Bold);
        }
        if span.link.is_some() {
            assert!(span.underline);
        }
    }
}

#[test]
fn code_blocks_have_finite_intrinsic_width_in_the_horizontal_scroller() {
    let renderer = renderer();
    let mut value = LiveText::new("a:1".into(), "```rust\nlet value = 1;\n```".into(), true);
    let mut tree = widget::Tree::new(&value as &dyn Widget<Message, Theme, Renderer>);
    let node = layout(&mut value, &mut tree, &renderer, 300.0);
    fn finite(node: &layout::Node) {
        assert!(node.size().width.is_finite());
        assert!(node.size().height.is_finite());
        for child in node.children() {
            finite(child);
        }
    }
    finite(&node);
}

#[tokio::test]
async fn markdown_links_remain_interactive() {
    use iced_test::simulator::Simulator;
    let content = LiveText::new(
        "a:1".into(),
        "[guide](https://example.com/guide)".into(),
        true,
    );
    let mut simulator =
        Simulator::with_size(theme::settings(), (400.0, 200.0), Element::from(content));
    simulator.point_at((10.0, 10.0));
    simulator.simulate(iced_test::simulator::click());
    let messages: Vec<_> = simulator.into_messages().collect();
    assert!(
        matches!(&messages[..], [Message::Link(url)] if url.as_str() == "https://example.com/guide")
    );
}
