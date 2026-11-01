use super::*;
use crate::views::stable_column::StableColumn;
use iced::advanced::renderer::{Headless, Renderer as _};
use iced::{Color, Font, Pixels};

fn lines(text: &str) -> Lines {
    vec![text.into()]
}

#[test]
fn unchanged_previews_and_initial_content_do_not_animate() {
    let now = Instant::now();
    let mut motion = Motion::new(lines("Working"));
    motion.retarget(&lines("Working"), now);
    motion.advance(now + DURATION);
    assert!(motion.started.is_none());
    assert_eq!(motion.eased(), 1.0);
}

#[test]
fn rapid_updates_coalesce_without_restarting_or_changing_the_visible_target() {
    let now = Instant::now();
    let mut motion = Motion::new(lines("Old"));
    motion.retarget(&lines("First"), now);
    motion.advance(now + DURATION / 2);
    assert_eq!(motion.eased(), 0.5);
    for i in 0..100 {
        motion.retarget(&lines(&format!("Update {i}")), now + DURATION / 2);
    }
    assert_eq!(motion.started, Some(now));
    assert_eq!(motion.incoming, lines("First"));
    assert_eq!(motion.outgoing, lines("Old"));
    assert_eq!(motion.eased(), 0.5);

    motion.advance(now + DURATION);
    assert_eq!(motion.outgoing, lines("First"));
    assert_eq!(motion.incoming, lines("Update 99"));
    assert_eq!(motion.eased(), 0.0);
    motion.advance(now + DURATION * 2);
    assert!(motion.started.is_none());
    assert_eq!(motion.eased(), 1.0);
}

#[test]
fn reverting_a_pending_update_does_not_leave_an_extra_animation() {
    let now = Instant::now();
    let mut motion = Motion::new(lines("Old"));
    motion.retarget(&lines("New"), now);
    motion.retarget(&lines("Intermediate"), now + DURATION / 3);
    motion.retarget(&lines("New"), now + DURATION / 2);
    // A delayed frame also finishes instead of replaying missed frames.
    motion.advance(now + Duration::from_secs(5));
    assert!(motion.started.is_none());
    assert_eq!(motion.incoming, lines("New"));
}

fn frame(
    preview: &mut Preview,
    tree: &mut widget::Tree,
    renderer: &Renderer,
    node: &layout::Node,
    now: Instant,
) -> (bool, window::RedrawRequest) {
    let mut messages = Vec::new();
    let mut shell = Shell::new(&mut messages);
    preview.update(
        tree,
        &Event::Window(window::Event::RedrawRequested(now)),
        Layout::new(node),
        mouse::Cursor::Unavailable,
        renderer,
        &mut iced::advanced::clipboard::Null,
        &mut shell,
        &Rectangle::with_size(Size::new(400.0, 300.0)),
    );
    let result = (shell.is_layout_invalid(), shell.redraw_request());
    assert!(messages.is_empty());
    result
}

async fn renderer() -> Renderer {
    <Renderer as Headless>::new(Font::DEFAULT, Pixels(16.0), Some("tiny-skia"))
        .await
        .expect("headless renderer")
}

#[tokio::test]
async fn widget_slides_clips_and_interpolates_real_wrapped_heights_then_stops_redrawing() {
    let mut renderer = renderer().await;
    let limits = layout::Limits::new(Size::ZERO, Size::new(160.0, 300.0));
    let mut preview = Preview::new(lines("Old preview"));
    let mut tree = widget::Tree::new(&preview as &dyn Widget<Message, Theme, Renderer>);
    let initial = preview.layout(&mut tree, &renderer, &limits);
    let old_height = initial.size().height;
    let (_, redraw) = frame(&mut preview, &mut tree, &renderer, &initial, Instant::now());
    assert_ne!(redraw, window::RedrawRequest::NextFrame);

    preview = Preview::new(vec![
        "A longer replacement preview that wraps across several lines at this width".into(),
        "Needs: Review and merge".into(),
    ]);
    preview.diff(&mut tree);
    let start = tree.state.downcast_ref::<Motion>().started.unwrap();
    let first = preview.layout(&mut tree, &renderer, &limits);
    assert_eq!(first.size().height, old_height);
    let (invalid, redraw) = frame(
        &mut preview,
        &mut tree,
        &renderer,
        &first,
        start + DURATION / 2,
    );
    assert!(invalid);
    assert_eq!(redraw, window::RedrawRequest::NextFrame);
    let middle = preview.layout(&mut tree, &renderer, &limits);
    let new_height = middle.children()[1].size().height;
    assert!(middle.size().height > old_height);
    assert!(middle.size().height < new_height);
    assert!(middle.children()[0].bounds().y < 0.0);
    assert!(middle.children()[1].bounds().y > 0.0);
    assert!(middle.children()[1].bounds().y < old_height);
    assert!(
        (middle.children()[0].bounds().y + old_height - middle.children()[1].bounds().y).abs()
            < 0.01
    );

    // Draw a moving preview surrounded by empty space. Neither the outgoing
    // text above it nor the incoming text below it may leak into adjacent rows.
    let middle = middle.move_to(Point::new(20.0, 30.0));
    renderer.reset(Rectangle::with_size(Size::new(400.0, 300.0)));
    preview.draw(
        &tree,
        &mut renderer,
        &Theme::Dark,
        &renderer::Style::default(),
        Layout::new(&middle),
        mouse::Cursor::Unavailable,
        &Rectangle::with_size(Size::new(400.0, 300.0)),
    );
    let pixels = renderer.screenshot(Size::new(400, 300), 1.0, Color::BLACK);
    let clip = middle.bounds();
    let mut visible_pixels = 0;
    for (i, pixel) in pixels.chunks_exact(4).enumerate() {
        if pixel[..3] != [0, 0, 0] {
            visible_pixels += 1;
            let x = (i % 400) as f32;
            let y = (i / 400) as f32;
            assert!(x >= clip.x.floor() && x < (clip.x + clip.width).ceil());
            assert!(y >= clip.y.floor() && y < (clip.y + clip.height).ceil());
        }
    }
    assert!(
        visible_pixels > 0,
        "the clipped preview must still render text"
    );

    let (_, redraw) = frame(
        &mut preview,
        &mut tree,
        &renderer,
        &middle,
        start + DURATION * 2,
    );
    assert_ne!(redraw, window::RedrawRequest::NextFrame);
    let finished = preview.layout(&mut tree, &renderer, &limits);
    assert_eq!(finished.size().height, new_height);
    assert_eq!(finished.children().len(), 1);
    assert_eq!(finished.children()[0].bounds().y, 0.0);

    // Removing the review's Needs line also shrinks continuously, not in a jump.
    preview = Preview::new(lines("Short again"));
    preview.diff(&mut tree);
    let start = tree.state.downcast_ref::<Motion>().started.unwrap();
    let first = preview.layout(&mut tree, &renderer, &limits);
    assert_eq!(first.size().height, new_height);
    frame(
        &mut preview,
        &mut tree,
        &renderer,
        &first,
        start + DURATION / 2,
    );
    let middle = preview.layout(&mut tree, &renderer, &limits);
    assert!(middle.size().height < new_height);
    assert!(middle.size().height > old_height);
    frame(
        &mut preview,
        &mut tree,
        &renderer,
        &middle,
        start + DURATION * 2,
    );
    assert_eq!(
        preview.layout(&mut tree, &renderer, &limits).size().height,
        old_height
    );
}

fn task(id: &str, text: &str) -> (String, Element<'static, Message>) {
    (id.into(), Preview::new(lines(text)).into())
}

fn tasks(entries: Vec<(String, Element<'static, Message>)>) -> StableColumn<'static> {
    entries
        .into_iter()
        .fold(StableColumn::new(2.0), |column, (key, content)| {
            column.push(key, content)
        })
}

#[tokio::test]
async fn reordering_inserting_and_removing_tasks_keeps_preview_state_with_its_id() {
    let renderer = renderer().await;
    let limits = layout::Limits::new(Size::ZERO, Size::new(300.0, 300.0));
    let mut column = tasks(vec![task("a", "A old"), task("b", "B old")]);
    let mut tree = widget::Tree::new(&column as &dyn Widget<Message, Theme, Renderer>);
    column.layout(&mut tree, &renderer, &limits);

    column = tasks(vec![task("b", "B new"), task("c", "C"), task("a", "A new")]);
    column.diff(&mut tree);
    column.layout(&mut tree, &renderer, &limits);
    for (child, old, new) in [
        (&tree.children[0], "B old", "B new"),
        (&tree.children[2], "A old", "A new"),
    ] {
        let motion = child.state.downcast_ref::<Motion>();
        assert_eq!(motion.outgoing, lines(old));
        assert_eq!(motion.incoming, lines(new));
        assert!(motion.started.is_some());
    }
    assert!(
        tree.children[1]
            .state
            .downcast_ref::<Motion>()
            .started
            .is_none()
    );

    column = tasks(vec![task("a", "A latest")]);
    column.diff(&mut tree);
    column.layout(&mut tree, &renderer, &limits);
    assert_eq!(tree.children.len(), 1);
    let motion = tree.children[0].state.downcast_ref::<Motion>();
    assert_eq!(motion.outgoing, lines("A old"));
    assert_eq!(motion.incoming, lines("A new"));
    assert_eq!(motion.latest, lines("A latest"));
}
