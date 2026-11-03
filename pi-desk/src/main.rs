//! pi-desk entry point.

use pi_desk::app::App;

fn main() -> iced::Result {
    extend_path();
    iced::application(App::boot, App::update, App::view)
        .title(App::title)
        .scale_factor(App::scale_factor)
        .theme(|_: &App| pi_desk::theme::theme())
        .subscription(App::subscription)
        .settings(pi_desk::theme::settings())
        .window_size((1440.0, 900.0))
        .run()
}

/// Apps started from Finder get a minimal PATH. Add the usual places for
/// `pi` and `git` so agents start the same way they do from a shell.
fn extend_path() {
    let home = std::env::var("HOME").unwrap_or_default();
    let extra = [
        format!("{home}/.local/share/vite-plus/bin"),
        format!("{home}/.local/bin"),
        format!("{home}/.cargo/bin"),
        "/opt/homebrew/bin".to_string(),
        "/usr/local/bin".to_string(),
    ];
    let current = std::env::var_os("PATH").unwrap_or_default();
    let mut paths: Vec<std::path::PathBuf> = std::env::split_paths(&current).collect();
    for directory in extra.iter().rev() {
        let path = std::path::PathBuf::from(directory);
        if path.is_dir() && !paths.contains(&path) {
            paths.insert(0, path);
        }
    }
    if let Ok(joined) = std::env::join_paths(paths) {
        // SAFETY: called before any other thread starts.
        unsafe { std::env::set_var("PATH", joined) };
    }
}
