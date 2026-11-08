//! Bundled Lucide icons (ISC license, `licenses/lucide.txt`) and the key-hint
//! parts that use them. Each icon's body matches its file in `assets/icons`.

/// Lucide's shared stroke attributes, applied to each icon's elements.
macro_rules! lucide {
    ($name:literal, $body:literal) => {
        rune::Icon {
            name: concat!("pi-desk-", $name),
            view: 24.0,
            body: concat!(
                r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">"#,
                $body,
                "</g>"
            ),
        }
    };
}

static CHEVRON_RIGHT: rune::Icon = lucide!("chevron-right", r#"<path d="m9 18 6-6-6-6" />"#);
static CHEVRON_DOWN: rune::Icon = lucide!("chevron-down", r#"<path d="m6 9 6 6 6-6" />"#);
static COMMAND_ICON: rune::Icon = lucide!(
    "command",
    r#"<path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3" />"#
);
static OPTION_ICON: rune::Icon = lucide!(
    "option",
    r#"<path d="M14 3h7" /><path d="M3 3h5.28a1 1 0 0 1 .948.684l5.544 16.632a1 1 0 0 0 .949.684H21" />"#
);
static ARROW_UP: rune::Icon = lucide!(
    "arrow-up",
    r#"<path d="m5 12 7-7 7 7" /><path d="M12 19V5" />"#
);
static ARROW_DOWN: rune::Icon = lucide!(
    "arrow-down",
    r#"<path d="M12 5v14" /><path d="m19 12-7 7-7-7" />"#
);
static RETURN_ICON: rune::Icon = lucide!(
    "corner-down-left",
    r#"<path d="M20 4v7a4 4 0 0 1-4 4H4" /><path d="m9 10-5 5 5 5" />"#
);
static GRIP: rune::Icon = lucide!(
    "grip-vertical",
    r#"<circle cx="9" cy="12" r="1" /><circle cx="9" cy="5" r="1" /><circle cx="9" cy="19" r="1" /><circle cx="15" cy="12" r="1" /><circle cx="15" cy="5" r="1" /><circle cx="15" cy="19" r="1" />"#
);
static TARGET: rune::Icon = lucide!(
    "target",
    r#"<circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="6" /><circle cx="12" cy="12" r="2" />"#
);
static USERS: rune::Icon = lucide!(
    "users",
    r#"<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />"#
);
static PLUS: rune::Icon = lucide!("plus", r#"<path d="M5 12h14" /><path d="M12 5v14" />"#);

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
    Target,
    Users,
    Plus,
}

impl Icon {
    pub const ALL: [Icon; 11] = [
        Icon::ChevronRight,
        Icon::ChevronDown,
        Icon::Command,
        Icon::Option,
        Icon::ArrowUp,
        Icon::ArrowDown,
        Icon::Return,
        Icon::Grip,
        Icon::Target,
        Icon::Users,
        Icon::Plus,
    ];

    pub fn glyph(self) -> &'static rune::Icon {
        match self {
            Icon::ChevronRight => &CHEVRON_RIGHT,
            Icon::ChevronDown => &CHEVRON_DOWN,
            Icon::Command => &COMMAND_ICON,
            Icon::Option => &OPTION_ICON,
            Icon::ArrowUp => &ARROW_UP,
            Icon::ArrowDown => &ARROW_DOWN,
            Icon::Return => &RETURN_ICON,
            Icon::Grip => &GRIP,
            Icon::Target => &TARGET,
            Icon::Users => &USERS,
            Icon::Plus => &PLUS,
        }
    }

    /// The asset file this icon's body comes from.
    pub fn file(self) -> &'static str {
        match self {
            Icon::ChevronRight => "chevron-right",
            Icon::ChevronDown => "chevron-down",
            Icon::Command => "command",
            Icon::Option => "option",
            Icon::ArrowUp => "arrow-up",
            Icon::ArrowDown => "arrow-down",
            Icon::Return => "corner-down-left",
            Icon::Grip => "grip-vertical",
            Icon::Target => "target",
            Icon::Users => "users",
            Icon::Plus => "plus",
        }
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

/// The primary shortcut modifier: Command on macOS, Ctrl elsewhere.
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

    /// The elements inside an asset's `<svg>`, with whitespace between tags removed.
    fn asset_body(name: &str) -> String {
        let path = format!("{}/assets/icons/{name}.svg", env!("CARGO_MANIFEST_DIR"));
        let source = std::fs::read_to_string(&path).expect("icon asset");
        let start = source.find('>').expect("svg open tag") + 1;
        let start = start + source[start..].find('<').expect("svg body");
        let end = source.rfind("</svg>").expect("svg close tag");
        source[start..end]
            .lines()
            .map(str::trim)
            .collect::<Vec<_>>()
            .join("")
    }

    #[test]
    fn every_icon_matches_its_bundled_lucide_asset() {
        for icon in Icon::ALL {
            let body = icon.glyph().body;
            let inner = body
                .strip_prefix(r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">"#)
                .and_then(|body| body.strip_suffix("</g>"))
                .expect("lucide stroke group");
            assert_eq!(inner, asset_body(icon.file()), "{icon:?}");
            assert_eq!(icon.glyph().view, 24.0);
        }
    }
}
