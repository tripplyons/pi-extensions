use super::*;

/// Runs `keys` on `text`, where `|` marks the cursor. `\x1b` is Escape.
/// Returns the text with `|` at the cursor, the mode, and the register.
fn run(text: &str, keys: &str) -> (String, Mode, String) {
    let cursor = text.chars().position(|c| c == '|').expect("cursor mark");
    let mut buffer = Buffer::new(&text.replace('|', ""), cursor);
    let mut vim = Vim {
        mode: Mode::Normal,
        ..Vim::default()
    };
    let mut register = String::new();
    let now = Instant::now();
    for key in keys.chars() {
        let outcome = match (key, vim.mode) {
            ('\x1b', _) => vim.handle(&mut buffer, Input::Escape),
            (c, Mode::Insert) => vim.insert_char("jk", &mut buffer, c, now),
            (c, _) => vim.handle(&mut buffer, Input::Char(c)),
        };
        if let Some(c) = outcome.insert {
            buffer.insert(buffer.cursor, &c.to_string());
            buffer.cursor += 1;
        }
        if let Some(yank) = outcome.yank {
            register = yank;
        }
        if let Some((after, count)) = outcome.put {
            vim.put(&mut buffer, &register.clone(), after, count);
        }
    }
    let mut shown = buffer.chars.clone();
    shown.insert(buffer.cursor, '|');
    (shown.into_iter().collect(), vim.mode, register)
}

fn text(text: &str, keys: &str) -> String {
    run(text, keys).0
}

#[test]
fn motions() {
    assert_eq!(text("|one two.three", "w"), "one |two.three");
    assert_eq!(text("|one two.three", "3w"), "one two.|three");
    assert_eq!(text("|one two.three", "W"), "one |two.three");
    assert_eq!(text("one two|", "b"), "one |two");
    assert_eq!(text("|one two", "e"), "on|e two");
    assert_eq!(text("|one two", "$"), "one tw|o");
    assert_eq!(text("  one tw|o", "^"), "  |one two");
    assert_eq!(text("  one tw|o", "0"), "|  one two");
    assert_eq!(text("|abc", "ll"), "ab|c");
    assert_eq!(text("|abc", "5l"), "ab|c");
    assert_eq!(text("ab|c", "h"), "a|bc");
}

#[test]
fn lines_keep_their_column() {
    assert_eq!(text("ab|cd\nx\nefgh", "j"), "abcd\n|x\nefgh");
    assert_eq!(text("ab|cd\nx\nefgh", "jj"), "abcd\nx\nef|gh");
    assert_eq!(text("abcd\nx\nef|gh", "2k"), "ab|cd\nx\nefgh");
    assert_eq!(text("a|\nb\nc", "G"), "a\nb\n|c");
    assert_eq!(text("a\nb\n|c", "gg"), "|a\nb\nc");
    assert_eq!(text("a\nb\n|c", "2G"), "a\n|b\nc");
}

#[test]
fn insert_entries_and_escape() {
    assert_eq!(
        run("a|bc", "iX\x1b"),
        ("a|Xbc".into(), Mode::Normal, String::new())
    );
    assert_eq!(text("a|bc", "aX\x1b"), "ab|Xc");
    assert_eq!(text("  a|bc", "IX\x1b"), "  |Xabc");
    assert_eq!(text("a|bc", "AX\x1b"), "abc|X");
    assert_eq!(text("a|bc\nd", "oX\x1b"), "abc\n|X\nd");
    assert_eq!(text("a|bc", "OX\x1b"), "|X\nabc");
}

#[test]
fn escape_sequence_removes_its_keys() {
    let (shown, mode, _) = run("|", "ijumpjk");
    assert_eq!((shown.as_str(), mode), ("jum|p", Mode::Normal));
    let (shown, mode, _) = run("|", "ijjk");
    assert_eq!((shown.as_str(), mode), ("|j", Mode::Normal));
    let (shown, mode, _) = run("|", "ikj");
    assert_eq!((shown.as_str(), mode), ("kj|", Mode::Insert));
}

#[test]
fn escape_sequence_times_out() {
    let mut buffer = Buffer::new("", 0);
    let mut vim = Vim::default();
    let start = Instant::now();
    let outcome = vim.insert_char("jk", &mut buffer, 'j', start);
    assert_eq!(outcome.insert, Some('j'));
    buffer.insert(0, "j");
    buffer.cursor = 1;
    let late = start + SEQUENCE_TIMEOUT + Duration::from_millis(1);
    let outcome = vim.insert_char("jk", &mut buffer, 'k', late);
    assert_eq!(outcome.insert, Some('k'));
    assert_eq!(vim.mode, Mode::Insert);
}

#[test]
fn delete_change_and_yank() {
    assert_eq!(
        run("|one two", "dw"),
        ("|two".into(), Mode::Normal, "one ".into())
    );
    assert_eq!(text("one |two\nnext", "dw"), "one| \nnext");
    assert_eq!(text("|one two three", "d2w"), "|three");
    assert_eq!(text("|one two three", "2dw"), "|three");
    assert_eq!(text("|one two", "cwX\x1b"), "|X two");
    assert_eq!(text("one t|wo three", "ciwX\x1b"), "one |X three");
    assert_eq!(text("one t|wo three", "daw"), "one |three");
    assert_eq!(text("one t|wo", "d$"), "one |t");
    assert_eq!(text("one t|wo", "D"), "one |t");
    assert_eq!(text("one t|wo", "CX\x1b"), "one t|X");
    assert_eq!(text("a|bc", "x"), "a|c");
    assert_eq!(text("a|bc", "2x"), "|a");
    assert_eq!(text("ab|c", "X"), "a|c");
    assert_eq!(text("|one two", "de"), "| two");
    assert_eq!(
        run("one t|wo", "yiw"),
        ("one |two".into(), Mode::Normal, "two".into())
    );
}

#[test]
fn linewise_operators() {
    assert_eq!(
        run("a\nb|b\nc", "dd"),
        ("a\n|c".into(), Mode::Normal, "bb\n".into())
    );
    assert_eq!(text("a\nb\n|c", "dd"), "a\n|b");
    assert_eq!(text("|a\nb\nc", "2dd"), "|c");
    assert_eq!(text("|a\nb\nc", "dj"), "|c");
    assert_eq!(text("a\n  b|b\nc", "ccX\x1b"), "a\n  |X\nc");
    assert_eq!(
        run("a\nb|b\nc", "yy"),
        ("a\nb|b\nc".into(), Mode::Normal, "bb\n".into())
    );
}

#[test]
fn put_charwise_and_linewise() {
    assert_eq!(text("|ab", "ylp"), "a|ab");
    assert_eq!(text("|ab", "ylP"), "|aab");
    assert_eq!(text("|ab", "yl3p"), "aaa|ab");
    assert_eq!(text("|a\nb", "yyp"), "a\n|a\nb");
    assert_eq!(text("a\n|b", "yyP"), "a\n|b\nb");
}

#[test]
fn visual_modes() {
    assert_eq!(
        run("|one two", "vey"),
        ("|one two".into(), Mode::Normal, "one".into())
    );
    assert_eq!(text("|one two", "vld"), "|e two");
    assert_eq!(text("one tw|o", "vbd"), "one| ");
    assert_eq!(text("a\nb|b\nc\nd", "Vjd"), "a\n|d");
    assert_eq!(text("one t|wo", "viwcX\x1b"), "one |X");
    assert_eq!(
        run("a|bc", "vl\x1b"),
        ("ab|c".into(), Mode::Normal, String::new())
    );
}

#[test]
fn visual_selection_includes_the_cursor_character() {
    let buffer = Buffer::new("abc\ndef", 1);
    let mut vim = Vim {
        mode: Mode::Visual,
        anchor: 1,
        head: 2,
        ..Vim::default()
    };
    assert_eq!(vim.selection(&buffer), Some((1, 3)));
    vim.head = 0;
    assert_eq!(vim.selection(&buffer), Some((2, 0)));
    vim.mode = Mode::VisualLine;
    vim.head = 5;
    assert_eq!(vim.selection(&buffer), Some((0, 7)));
}

#[test]
fn escape_cancels_pending_keys() {
    let mut buffer = Buffer::new("abc", 0);
    let mut vim = Vim {
        mode: Mode::Normal,
        ..Vim::default()
    };
    vim.handle(&mut buffer, Input::Char('2'));
    vim.handle(&mut buffer, Input::Char('d'));
    assert!(!vim.idle());
    assert_eq!(vim.pending(), "2d");
    vim.handle(&mut buffer, Input::Escape);
    assert!(vim.idle());
    vim.handle(&mut buffer, Input::Char('x'));
    assert_eq!(buffer.text(), "bc");
}

fn edit(text: &str) -> TextEdit {
    let mut edit = TextEdit::new(text);
    edit.set_caret(0);
    edit
}

#[test]
fn positions_use_byte_offsets() {
    let mut field = edit("é🙂 x\nnext");
    let buffer = Buffer::new("é🙂 x\nnext", 3);
    write(&mut field, &buffer, None);
    assert_eq!((field.anchor, field.focus), (7, 7));
    assert_eq!(Buffer::read(&field).cursor, 3);
    let buffer = Buffer::new("é🙂 x\nnext", 6);
    write(&mut field, &buffer, Some((1, 6)));
    assert_eq!(field.selected(), "🙂 x\nn");
}

#[test]
fn writes_are_single_undo_steps_that_keep_the_rest_of_the_text() {
    let mut field = edit("one two three");
    let mut buffer = Buffer::read(&field);
    buffer.cursor = 4;
    write(&mut field, &Buffer::new("one three", 4), None);
    assert_eq!(field.text, "one three");
    field.undo();
    assert_eq!(field.text, "one two three");
    buffer.cursor = 0;
    write(&mut field, &buffer, None);
    assert_eq!(field.focus, 0);
}

#[test]
fn routes_keys_by_mode() {
    use rune::{Key, KeyEvent, Mods};
    let key = |key: Key| KeyEvent {
        key,
        mods: Mods::default(),
    };
    let a = || key(Key::Text("a".into()));
    let mut vim = Vim::default();
    // Insert mode: typed text goes through the escape-sequence check.
    assert_eq!(
        route(&a(), Target::Reply, &vim, "jk"),
        Route::Vim(Input::Char('a'))
    );
    assert_eq!(route(&a(), Target::Reply, &vim, ""), Route::Usual);
    assert_eq!(
        route(&key(Key::Escape), Target::Reply, &vim, "jk"),
        Route::Vim(Input::Escape)
    );
    // Normal mode: keys become commands, and idle Escape uses the box's own action.
    vim.mode = Mode::Normal;
    assert_eq!(
        route(&a(), Target::Reply, &vim, "jk"),
        Route::Vim(Input::Char('a'))
    );
    assert_eq!(
        route(&key(Key::Down), Target::Reply, &vim, "jk"),
        Route::Vim(Input::Char('j'))
    );
    assert_eq!(
        route(&key(Key::Escape), Target::Reply, &vim, "jk"),
        Route::Usual
    );
    assert_eq!(
        route(&key(Key::Enter), Target::Reply, &vim, "jk"),
        Route::Usual
    );
    assert_eq!(
        route(&key(Key::Enter), Target::Composer, &vim, "jk"),
        Route::Vim(Input::Char('\n'))
    );
    assert_eq!(
        route(&key(Key::Tab), Target::Composer, &vim, "jk"),
        Route::Ignore
    );
    let ctrl_r = KeyEvent {
        key: Key::Text("r".into()),
        mods: Mods {
            ctrl: true,
            ..Mods::default()
        },
    };
    assert_eq!(
        route(&ctrl_r, Target::Composer, &vim, "jk"),
        Route::Vim(Input::Redo)
    );
}

#[test]
fn normal_mode_draws_the_cursor_as_a_block() {
    let vim = Vim {
        mode: Mode::Normal,
        ..Vim::default()
    };
    let buffer = Buffer::new("é🙂\n\nx", 1);
    assert_eq!(vim.selection(&buffer), Some((2, 1)));
    // An empty line and the end of the text have no character to cover.
    assert_eq!(vim.selection(&Buffer::new("é🙂\n\nx", 3)), None);
    assert_eq!(vim.selection(&Buffer::new("é🙂\n\nx", 5)), None);
    assert_eq!(vim.selection(&Buffer::new("", 0)), None);

    let mut field = edit("é🙂\n\nx");
    write(&mut field, &buffer, vim.selection(&buffer));
    assert_eq!(field.selected(), "🙂");
    assert_eq!(Buffer::read(&field).cursor, 1);
}

#[test]
fn clearing_the_block_keeps_other_selections() {
    let vim = Vim {
        mode: Mode::Normal,
        ..Vim::default()
    };
    let mut field = edit("abc");
    vim.show_block(&mut field);
    assert_eq!(field.selected(), "a");
    vim.clear_block(&mut field);
    assert_eq!(field.selected(), "");
    assert_eq!(Buffer::read(&field).cursor, 0);

    // A selection the user made, such as select-all, stays.
    field.set_selection(0, 3);
    vim.clear_block(&mut field);
    assert_eq!(field.selected(), "abc");
    vim.show_block(&mut field);
    assert_eq!(field.selected(), "abc");
}

#[test]
fn insert_mode_has_no_block() {
    let vim = Vim::default();
    let mut field = edit("abc");
    vim.show_block(&mut field);
    assert_eq!(field.selected(), "");
}
