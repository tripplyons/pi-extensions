//! Bundled Lucide icons (ISC license, `licenses/lucide.txt`) and the key-hint
//! parts that use them.

use iced::widget::svg;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Icon {
    ChevronRight,
    ChevronDown,
    Command,
    Option,
    ArrowUp,
    ArrowDown,
    Return,
    Grip,
}

impl Icon {
    pub const ALL: [Icon; 8] = [
        Icon::ChevronRight,
        Icon::ChevronDown,
        Icon::Command,
        Icon::Option,
        Icon::ArrowUp,
        Icon::ArrowDown,
        Icon::Return,
        Icon::Grip,
    ];

    fn source(self) -> &'static [u8] {
        match self {
            Icon::ChevronRight => include_bytes!("../assets/icons/chevron-right.svg"),
            Icon::ChevronDown => include_bytes!("../assets/icons/chevron-down.svg"),
            Icon::Command => include_bytes!("../assets/icons/command.svg"),
            Icon::Option => include_bytes!("../assets/icons/option.svg"),
            Icon::ArrowUp => include_bytes!("../assets/icons/arrow-up.svg"),
            Icon::ArrowDown => include_bytes!("../assets/icons/arrow-down.svg"),
            Icon::Return => include_bytes!("../assets/icons/corner-down-left.svg"),
            Icon::Grip => include_bytes!("../assets/icons/grip-vertical.svg"),
        }
    }

    pub fn handle(self) -> svg::Handle {
        svg::Handle::from_memory(self.source())
    }

    /// The disclosure chevron for an expandable row.
    pub fn disclosure(open: bool) -> Icon {
        if open {
            Icon::ChevronDown
        } else {
            Icon::ChevronRight
        }
    }
}

/// One piece of a key hint: a key name or a modifier/arrow icon.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyPart<'a> {
    Text(&'a str),
    Icon(Icon),
}

/// The primary shortcut modifier, matching iced's `Modifiers::command`.
pub const COMMAND: KeyPart<'static> = if cfg!(target_os = "macos") {
    KeyPart::Icon(Icon::Command)
} else {
    KeyPart::Text("Ctrl+")
};

pub const RETURN: KeyPart<'static> = if cfg!(target_os = "macos") {
    KeyPart::Icon(Icon::Return)
} else {
    KeyPart::Text("Enter")
};

pub const ALT: KeyPart<'static> = if cfg!(target_os = "macos") {
    KeyPart::Icon(Icon::Option)
} else {
    KeyPart::Text("Alt+")
};

#[cfg(test)]
mod tests {
    use super::*;
    use iced::advanced::Renderer as _;
    use iced::advanced::renderer::Headless;
    use iced::advanced::svg::{Renderer as _, Svg};
    use iced::{Color, Font, Pixels, Rectangle, Size};

    #[tokio::test]
    async fn every_bundled_icon_parses_and_draws_in_the_requested_color() {
        let mut renderer =
            <iced::Renderer as Headless>::new(Font::DEFAULT, Pixels(16.0), Some("tiny-skia"))
                .await
                .expect("headless renderer");
        let tint = Color::from_rgb8(0xff, 0x00, 0x00);
        for icon in Icon::ALL {
            let bounds = Rectangle::with_size(Size::new(48.0, 48.0));
            renderer.reset(bounds);
            assert_eq!(renderer.measure_svg(&icon.handle()), Size::new(24, 24));
            renderer.draw_svg(Svg::new(icon.handle()).color(tint), bounds, bounds);
            let pixels = renderer.screenshot(Size::new(48, 48), 1.0, Color::BLACK);
            let painted = pixels
                .chunks_exact(4)
                .filter(|pixel| pixel[0] > 0x80 && pixel[1] < 0x40 && pixel[2] < 0x40)
                .count();
            assert!(painted > 20, "{icon:?} painted {painted} tinted pixels");
        }
    }
}
