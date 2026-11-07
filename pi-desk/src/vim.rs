//! Vim-style modal editing for the reply and task composer boxes.
//!
//! The engine works on a plain character buffer so it can be tested without
//! a window. `App` reads the editor into a [`Buffer`], runs one key, and writes
//! the result back. Yank and put use the system clipboard; text that ends in a
//! newline pastes as whole lines.

use crate::app::Message;
use iced::keyboard::{Key, key::Named};
use iced::widget::text_editor::{self, Binding, Content, Cursor, Position};
use std::time::{Duration, Instant};

/// How long the escape sequence may pause between keys.
pub const SEQUENCE_TIMEOUT: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Target {
    Reply,
    Composer,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Mode {
    #[default]
    Insert,
    Normal,
    Visual,
    VisualLine,
}

impl Mode {
    pub fn label(self) -> &'static str {
        match self {
            Mode::Insert => "-- INSERT --",
            Mode::Normal => "-- NORMAL --",
            Mode::Visual => "-- VISUAL --",
            Mode::VisualLine => "-- VISUAL LINE --",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Input {
    Char(char),
    Escape,
    /// Ctrl+R.
    Redo,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Op {
    Delete,
    Change,
    Yank,
}

impl Op {
    fn key(self) -> char {
        match self {
            Op::Delete => 'd',
            Op::Change => 'c',
            Op::Yank => 'y',
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Exclusive,
    Inclusive,
    Lines,
}

/// Editor text as characters, with the cursor as a character index.
#[derive(Debug, Clone, PartialEq)]
pub struct Buffer {
    pub chars: Vec<char>,
    pub cursor: usize,
}

impl Buffer {
    pub fn new(text: &str, cursor: usize) -> Self {
        Self {
            chars: text.chars().collect(),
            cursor,
        }
    }

    pub fn text(&self) -> String {
        self.chars.iter().collect()
    }

    pub fn read(content: &Content) -> Self {
        let text = content.text();
        let cursor = index(&text, content.cursor().position);
        Self::new(&text, cursor)
    }

    fn len(&self) -> usize {
        self.chars.len()
    }

    fn line_start(&self, pos: usize) -> usize {
        let mut i = pos.min(self.len());
        while i > 0 && self.chars[i - 1] != '\n' {
            i -= 1;
        }
        i
    }

    fn line_end(&self, pos: usize) -> usize {
        let mut i = pos.min(self.len());
        while i < self.len() && self.chars[i] != '\n' {
            i += 1;
        }
        i
    }

    fn first_nonblank(&self, pos: usize) -> usize {
        let mut i = self.line_start(pos);
        let end = self.line_end(pos);
        while i < end && matches!(self.chars[i], ' ' | '\t') {
            i += 1;
        }
        i
    }

    fn line_of(&self, pos: usize) -> usize {
        self.chars[..pos.min(self.len())]
            .iter()
            .filter(|c| **c == '\n')
            .count()
    }

    fn line_count(&self) -> usize {
        self.chars.iter().filter(|c| **c == '\n').count() + 1
    }

    fn nth_line(&self, line: usize) -> usize {
        if line == 0 {
            return 0;
        }
        let mut seen = 0;
        for (i, c) in self.chars.iter().enumerate() {
            if *c == '\n' {
                seen += 1;
                if seen == line {
                    return i + 1;
                }
            }
        }
        self.line_start(self.len())
    }

    /// Normal mode keeps the cursor on a character, not after the last one.
    fn clamp(&mut self) {
        self.cursor = self.cursor.min(self.len());
        let start = self.line_start(self.cursor);
        let end = self.line_end(self.cursor);
        if self.cursor >= end && end > start {
            self.cursor = end - 1;
        }
    }

    /// 0 is whitespace, including newlines. `big` treats all other text as one class.
    fn class(&self, pos: usize, big: bool) -> u8 {
        match self.chars[pos] {
            c if c.is_whitespace() => 0,
            _ if big => 1,
            c if c.is_alphanumeric() || c == '_' => 1,
            _ => 2,
        }
    }

    fn word_forward(&self, pos: usize, big: bool) -> usize {
        let mut i = pos;
        if i >= self.len() {
            return self.len();
        }
        let class = self.class(i, big);
        if class != 0 {
            while i < self.len() && self.class(i, big) == class {
                i += 1;
            }
        }
        while i < self.len() && self.class(i, big) == 0 {
            i += 1;
        }
        i
    }

    fn word_end(&self, pos: usize, big: bool) -> usize {
        let mut i = pos + 1;
        while i < self.len() && self.class(i, big) == 0 {
            i += 1;
        }
        if i >= self.len() {
            return self.len().saturating_sub(1).max(pos);
        }
        let class = self.class(i, big);
        while i + 1 < self.len() && self.class(i + 1, big) == class {
            i += 1;
        }
        i
    }

    fn word_back(&self, pos: usize, big: bool) -> usize {
        let mut i = pos;
        if i == 0 {
            return 0;
        }
        i -= 1;
        while i > 0 && self.class(i, big) == 0 {
            i -= 1;
        }
        let class = self.class(i, big);
        while i > 0 && self.class(i - 1, big) == class {
            i -= 1;
        }
        i
    }

    /// `iw` or `aw` around `pos`, as a half-open range.
    fn word_object(&self, pos: usize, big: bool, around: bool) -> Option<(usize, usize)> {
        if pos >= self.len() || self.chars[pos] == '\n' {
            return None;
        }
        let same = |i: usize, class: u8| self.chars[i] != '\n' && self.class(i, big) == class;
        let class = self.class(pos, big);
        let (mut start, mut end) = (pos, pos + 1);
        while start > 0 && same(start - 1, class) {
            start -= 1;
        }
        while end < self.len() && same(end, class) {
            end += 1;
        }
        if around && class != 0 {
            let trailing = end;
            while end < self.len() && same(end, 0) {
                end += 1;
            }
            if end == trailing {
                while start > 0 && same(start - 1, 0) {
                    start -= 1;
                }
            }
        }
        Some((start, end))
    }

    fn remove(&mut self, start: usize, end: usize) -> String {
        self.chars.drain(start..end).collect()
    }

    fn insert(&mut self, at: usize, text: &str) {
        let at = at.min(self.len());
        self.chars.splice(at..at, text.chars());
    }
}

/// Converts an editor position, whose column is a byte offset, to a character index.
fn index(text: &str, position: Position) -> usize {
    let mut chars = 0;
    for (line, content) in text.split('\n').enumerate() {
        if line == position.line {
            let column = position.column.min(content.len());
            let column = (0..=column)
                .rev()
                .find(|i| content.is_char_boundary(*i))
                .unwrap_or(0);
            return chars + content[..column].chars().count();
        }
        chars += content.chars().count() + 1;
    }
    text.chars().count()
}

fn position(buffer: &Buffer, pos: usize) -> Position {
    let pos = pos.min(buffer.len());
    let start = buffer.line_start(pos);
    Position {
        line: buffer.line_of(pos),
        column: buffer.chars[start..pos].iter().map(|c| c.len_utf8()).sum(),
    }
}

/// Writes `buffer` into `content`. `selection` is an (anchor, cursor) pair.
pub fn write(content: &mut Content, buffer: &Buffer, selection: Option<(usize, usize)>) {
    let text = buffer.text();
    if content.text() != text {
        *content = Content::with_text(&text);
    } else if content.selection().is_some() {
        content.perform(text_editor::Action::Move(text_editor::Motion::Left));
    }
    let cursor = match selection {
        Some((anchor, cursor)) => Cursor {
            position: position(buffer, cursor),
            selection: Some(position(buffer, anchor)),
        },
        None => Cursor {
            position: position(buffer, buffer.cursor),
            selection: None,
        },
    };
    content.move_to(cursor);
}

/// What the app must do after a key, besides writing the buffer back.
#[derive(Debug, Default, PartialEq)]
pub struct Outcome {
    /// Insert this character as an ordinary edit.
    pub insert: Option<char>,
    pub yank: Option<String>,
    /// Put the clipboard after (true) or before the cursor, this many times.
    pub put: Option<(bool, usize)>,
    pub undo: usize,
    pub redo: usize,
    pub entered_insert: bool,
    pub left_insert: bool,
    /// The text change belongs to the escape sequence and must not enter undo history.
    pub silent: bool,
}

#[derive(Debug, Default)]
pub struct Vim {
    pub mode: Mode,
    count: Option<usize>,
    op: Option<(Op, usize)>,
    prefix: Option<char>,
    anchor: usize,
    head: usize,
    want: Option<usize>,
    /// Whether the user typed a count, which `G` and `gg` treat as a line number.
    count_given: bool,
    typed: usize,
    typed_at: Option<Instant>,
    /// Undo depth when insert mode began, so one insert undoes as a unit.
    pub insert_mark: Option<usize>,
}

impl Vim {
    /// A box that starts in insert mode with `depth` undo steps already recorded.
    pub fn new(depth: usize) -> Self {
        Self {
            insert_mark: Some(depth),
            ..Self::default()
        }
    }

    /// True when Escape has nothing left to cancel in this box.
    pub fn idle(&self) -> bool {
        self.mode == Mode::Normal
            && self.count.is_none()
            && self.op.is_none()
            && self.prefix.is_none()
    }

    /// Pending keys, as Vim's `showcmd` would show them.
    pub fn pending(&self) -> String {
        let mut keys = String::new();
        if let Some((op, count)) = self.op {
            if count > 1 {
                keys.push_str(&count.to_string());
            }
            keys.push(op.key());
        }
        if let Some(count) = self.count {
            keys.push_str(&count.to_string());
        }
        if let Some(prefix) = self.prefix {
            keys.push(prefix);
        }
        keys
    }

    /// Forgets a partly typed escape sequence after another kind of edit.
    pub fn interrupt(&mut self) {
        self.typed = 0;
    }

    /// The selection to draw, as (anchor, cursor). In normal mode it covers the
    /// character under the cursor, so the cursor shows as a block. The editor's
    /// caret stays on that character, which keeps [`Buffer::read`] correct.
    /// Empty lines and the end of the text have no character and get `None`.
    pub fn selection(&self, buffer: &Buffer) -> Option<(usize, usize)> {
        let (low, high) = (self.anchor.min(self.head), self.anchor.max(self.head));
        let (start, end) = match self.mode {
            Mode::Visual => (low, (high + 1).min(buffer.len())),
            Mode::VisualLine => (buffer.line_start(low), buffer.line_end(high)),
            Mode::Normal => {
                return buffer
                    .chars
                    .get(buffer.cursor)
                    .filter(|c| **c != '\n')
                    .map(|_| (buffer.cursor + 1, buffer.cursor));
            }
            Mode::Insert => return None,
        };
        Some(if self.head < self.anchor {
            (end, start)
        } else {
            (start, end)
        })
    }

    /// Removes the normal-mode block from `content`, so an ordinary edit lands
    /// at the cursor instead of replacing the character. Keeps other selections.
    pub fn clear_block(&self, content: &mut Content) {
        if self.mode != Mode::Normal || content.selection().is_none() {
            return;
        }
        let buffer = Buffer::read(content);
        let Some((anchor, _)) = self.selection(&buffer) else {
            return;
        };
        let cursor = content.cursor();
        if cursor.selection == Some(position(&buffer, anchor)) {
            write(content, &buffer, None);
        }
    }

    /// Draws the normal-mode block unless `content` holds another selection.
    pub fn show_block(&self, content: &mut Content) {
        if self.mode == Mode::Normal && content.selection().is_none() {
            let buffer = Buffer::read(content);
            write(content, &buffer, self.selection(&buffer));
        }
    }

    /// Clears pending keys and settles the cursor after undo, redo, or a click.
    pub fn settle(&mut self, buffer: &mut Buffer) {
        self.count = None;
        self.op = None;
        self.prefix = None;
        if self.mode != Mode::Insert {
            self.mode = Mode::Normal;
            buffer.clamp();
        }
    }

    /// A character typed in insert mode. Detects the escape sequence.
    pub fn insert_char(
        &mut self,
        sequence: &str,
        buffer: &mut Buffer,
        c: char,
        now: Instant,
    ) -> Outcome {
        let sequence: Vec<char> = sequence.chars().collect();
        let fresh = self
            .typed_at
            .is_some_and(|at| now.duration_since(at) <= SEQUENCE_TIMEOUT);
        let before = &buffer.chars[..buffer.cursor.min(buffer.len())];
        let next = if self.typed > 0
            && fresh
            && sequence.get(self.typed) == Some(&c)
            && before.ends_with(&sequence[..self.typed])
        {
            self.typed + 1
        } else if sequence.first() == Some(&c) {
            1
        } else {
            0
        };
        if next > 0 && next == sequence.len() {
            let typed = next - 1;
            buffer.cursor -= typed;
            buffer.remove(buffer.cursor, buffer.cursor + typed);
            let mut outcome = self.leave_insert(buffer);
            outcome.silent = true;
            return outcome;
        }
        self.typed = next;
        self.typed_at = Some(now);
        Outcome {
            insert: Some(c),
            ..Outcome::default()
        }
    }

    pub fn handle(&mut self, buffer: &mut Buffer, input: Input) -> Outcome {
        match (self.mode, input) {
            (Mode::Insert, Input::Escape) => self.leave_insert(buffer),
            (Mode::Insert, Input::Char(c)) => Outcome {
                insert: Some(c),
                ..Outcome::default()
            },
            (Mode::Insert, Input::Redo) => Outcome::default(),
            (_, Input::Escape) => {
                if matches!(self.mode, Mode::Visual | Mode::VisualLine) {
                    buffer.cursor = self.head;
                }
                self.settle(buffer);
                Outcome::default()
            }
            (_, Input::Redo) => {
                let count = self.count.take().unwrap_or(1);
                self.settle(buffer);
                Outcome {
                    redo: count,
                    ..Outcome::default()
                }
            }
            (Mode::Normal, Input::Char(c)) => {
                buffer.clamp();
                self.normal(buffer, c)
            }
            (_, Input::Char(c)) => {
                buffer.cursor = self.head;
                self.visual(buffer, c)
            }
        }
    }

    /// Puts clipboard text at the cursor.
    pub fn put(&mut self, buffer: &mut Buffer, text: &str, after: bool, count: usize) {
        let count = count.max(1);
        if let Some(lines) = text.strip_suffix('\n') {
            let block = std::iter::repeat_n(lines, count)
                .collect::<Vec<_>>()
                .join("\n");
            if after {
                let end = buffer.line_end(buffer.cursor);
                buffer.insert(end, &format!("\n{block}"));
                buffer.cursor = buffer.first_nonblank(end + 1);
            } else {
                let start = buffer.line_start(buffer.cursor);
                buffer.insert(start, &format!("{block}\n"));
                buffer.cursor = buffer.first_nonblank(start);
            }
        } else {
            let block = text.repeat(count);
            let mut at = buffer.cursor;
            if after && at < buffer.line_end(at) {
                at += 1;
            }
            buffer.insert(at, &block);
            buffer.cursor = at + block.chars().count().saturating_sub(1);
        }
        self.mode = Mode::Normal;
        buffer.clamp();
    }

    fn leave_insert(&mut self, buffer: &mut Buffer) -> Outcome {
        self.mode = Mode::Normal;
        self.typed = 0;
        self.want = None;
        if buffer.cursor > buffer.line_start(buffer.cursor) {
            buffer.cursor -= 1;
        }
        buffer.clamp();
        Outcome {
            left_insert: true,
            ..Outcome::default()
        }
    }

    fn enter_insert(&mut self, buffer: &mut Buffer, at: usize) -> Outcome {
        self.mode = Mode::Insert;
        self.typed = 0;
        self.want = None;
        self.count = None;
        self.op = None;
        self.prefix = None;
        buffer.cursor = at.min(buffer.len());
        Outcome {
            entered_insert: true,
            ..Outcome::default()
        }
    }

    /// Returns false when `c` was a count digit or prefix and the key needs more input.
    fn take_digit(&mut self, c: char) -> bool {
        match c.to_digit(10) {
            Some(digit) if digit > 0 || self.count.is_some() => {
                let count = self.count.unwrap_or(0).saturating_mul(10);
                self.count = Some(count.saturating_add(digit as usize).min(9999));
                true
            }
            _ => false,
        }
    }

    /// A motion from `pos`, as its target and kind.
    fn motion(
        &mut self,
        buffer: &Buffer,
        pos: usize,
        c: char,
        count: usize,
    ) -> Option<(usize, Kind)> {
        let mut target = pos;
        let kind = match c {
            'h' => {
                target = pos.saturating_sub(count).max(buffer.line_start(pos));
                Kind::Exclusive
            }
            'l' | ' ' => {
                target = (pos + count).min(buffer.line_end(pos));
                Kind::Exclusive
            }
            'j' | 'k' | '\n' | '+' | '-' => {
                let line = buffer.line_of(pos);
                let line = if matches!(c, 'k' | '-') {
                    line.saturating_sub(count)
                } else {
                    (line + count).min(buffer.line_count() - 1)
                };
                let start = buffer.nth_line(line);
                target = if matches!(c, 'j' | 'k') {
                    let column = *self.want.get_or_insert(pos - buffer.line_start(pos));
                    (start + column).min(buffer.line_end(start))
                } else {
                    buffer.first_nonblank(start)
                };
                Kind::Lines
            }
            'w' | 'W' => {
                for _ in 0..count {
                    target = buffer.word_forward(target, c == 'W');
                }
                Kind::Exclusive
            }
            'b' | 'B' => {
                for _ in 0..count {
                    target = buffer.word_back(target, c == 'B');
                }
                Kind::Exclusive
            }
            'e' | 'E' => {
                for _ in 0..count {
                    target = buffer.word_end(target, c == 'E');
                }
                Kind::Inclusive
            }
            '0' => {
                target = buffer.line_start(pos);
                Kind::Exclusive
            }
            '^' => {
                target = buffer.first_nonblank(pos);
                Kind::Exclusive
            }
            '$' => {
                let line = (buffer.line_of(pos) + count - 1).min(buffer.line_count() - 1);
                target = buffer.line_end(buffer.nth_line(line));
                Kind::Inclusive
            }
            'G' | 'g' => {
                let line = match (c, self.count_given) {
                    (_, true) => count - 1,
                    ('G', false) => buffer.line_count() - 1,
                    _ => 0,
                };
                target = buffer.first_nonblank(buffer.nth_line(line.min(buffer.line_count() - 1)));
                Kind::Lines
            }
            _ => return None,
        };
        if !matches!(c, 'j' | 'k') {
            self.want = None;
        }
        Some((target, kind))
    }

    fn normal(&mut self, buffer: &mut Buffer, c: char) -> Outcome {
        let pos = buffer.cursor;
        if let Some(prefix) = self.prefix.take() {
            return match (prefix, c) {
                ('g', 'g') => self.motion_key(buffer, 'g'),
                ('i' | 'a', 'w' | 'W') if self.op.is_some() => {
                    let (op, _) = self.op.take().unwrap();
                    match buffer.word_object(pos, c == 'W', prefix == 'a') {
                        Some((start, end)) => self.apply(buffer, op, start, end, false, pos),
                        None => Outcome::default(),
                    }
                }
                _ => {
                    self.settle(buffer);
                    Outcome::default()
                }
            };
        }
        if self.take_digit(c) {
            return Outcome::default();
        }
        if let Some((op, _)) = self.op {
            if c == op.key() {
                let (_, op_count) = self.op.take().unwrap();
                let count = op_count * self.count.take().unwrap_or(1);
                let last = buffer.line_of(pos) + count - 1;
                let end = buffer.nth_line(last.min(buffer.line_count() - 1));
                return self.apply(buffer, op, pos, end, true, pos);
            }
            if matches!(c, 'i' | 'a' | 'g') {
                self.prefix = Some(c);
                return Outcome::default();
            }
            return self.motion_key(buffer, c);
        }
        let count = self.count.unwrap_or(1);
        match c {
            'g' => {
                self.prefix = Some('g');
                Outcome::default()
            }
            'd' | 'c' | 'y' => {
                let op = match c {
                    'd' => Op::Delete,
                    'c' => Op::Change,
                    _ => Op::Yank,
                };
                self.op = Some((op, self.count.take().unwrap_or(1)));
                Outcome::default()
            }
            'D' | 'C' => {
                self.op = Some((if c == 'D' { Op::Delete } else { Op::Change }, 1));
                self.motion_key(buffer, '$')
            }
            's' => {
                self.op = Some((Op::Change, 1));
                self.motion_key(buffer, 'l')
            }
            'S' => {
                self.op = Some((Op::Change, 1));
                self.normal(buffer, 'c')
            }
            'x' | 'X' => {
                self.count = None;
                let (start, end) = if c == 'x' {
                    (pos, (pos + count).min(buffer.line_end(pos)))
                } else {
                    (pos.saturating_sub(count).max(buffer.line_start(pos)), pos)
                };
                if start == end {
                    return Outcome::default();
                }
                self.apply(buffer, Op::Delete, start, end, false, pos)
            }
            'i' => self.enter_insert(buffer, pos),
            'a' => {
                let at = if pos < buffer.line_end(pos) {
                    pos + 1
                } else {
                    pos
                };
                self.enter_insert(buffer, at)
            }
            'I' => {
                let at = buffer.first_nonblank(pos);
                self.enter_insert(buffer, at)
            }
            'A' => {
                let at = buffer.line_end(pos);
                self.enter_insert(buffer, at)
            }
            'o' => {
                let end = buffer.line_end(pos);
                buffer.insert(end, "\n");
                self.enter_insert(buffer, end + 1)
            }
            'O' => {
                let start = buffer.line_start(pos);
                buffer.insert(start, "\n");
                self.enter_insert(buffer, start)
            }
            'p' | 'P' => {
                self.count = None;
                Outcome {
                    put: Some((c == 'p', count)),
                    ..Outcome::default()
                }
            }
            'u' => {
                self.count = None;
                Outcome {
                    undo: count,
                    ..Outcome::default()
                }
            }
            'v' | 'V' => {
                self.count = None;
                self.mode = if c == 'v' {
                    Mode::Visual
                } else {
                    Mode::VisualLine
                };
                self.anchor = pos;
                self.head = pos;
                Outcome::default()
            }
            _ => self.motion_key(buffer, c),
        }
    }

    /// Runs a motion, with the pending operator if there is one.
    fn motion_key(&mut self, buffer: &mut Buffer, c: char) -> Outcome {
        let pos = buffer.cursor;
        let (op, op_count) = match self.op.take() {
            Some((op, count)) => (Some(op), count),
            None => (None, 1),
        };
        self.count_given = self.count.is_some() || op_count > 1;
        let count = op_count * self.count.take().unwrap_or(1);
        // `cw` on a word changes to its end, like `ce`.
        let c = match (op, c) {
            (Some(Op::Change), 'w' | 'W')
                if pos < buffer.len() && buffer.class(pos, false) != 0 =>
            {
                if c == 'w' {
                    'e'
                } else {
                    'E'
                }
            }
            _ => c,
        };
        let Some((mut target, kind)) = self.motion(buffer, pos, c, count) else {
            self.settle(buffer);
            return Outcome::default();
        };
        let Some(op) = op else {
            buffer.cursor = target;
            buffer.clamp();
            return Outcome::default();
        };
        // An operator with `w` stops at the end of the line.
        if matches!(c, 'w' | 'W') && buffer.line_of(target) > buffer.line_of(pos) {
            let end = buffer.line_end(pos);
            if end > pos {
                target = end;
            }
        }
        let (start, end) = (pos.min(target), pos.max(target));
        match kind {
            Kind::Lines => self.apply(buffer, op, start, end, true, pos),
            Kind::Exclusive => self.apply(buffer, op, start, end, false, pos),
            Kind::Inclusive => {
                let end = if end < buffer.len() && buffer.chars[end] != '\n' {
                    end + 1
                } else {
                    end
                };
                self.apply(buffer, op, start, end, false, pos)
            }
        }
    }

    /// Applies an operator. Charwise ranges are half-open. Linewise ranges
    /// name any position on the first and last line.
    fn apply(
        &mut self,
        buffer: &mut Buffer,
        op: Op,
        start: usize,
        end: usize,
        lines: bool,
        pos: usize,
    ) -> Outcome {
        self.mode = Mode::Normal;
        self.count = None;
        self.prefix = None;
        self.want = None;
        let mut outcome = Outcome::default();
        if lines {
            let first = buffer.line_start(start);
            let last = buffer.line_end(end);
            let mut yank: String = buffer.chars[first..last].iter().collect();
            yank.push('\n');
            outcome.yank = Some(yank);
            match op {
                Op::Yank => {
                    buffer.cursor = if buffer.line_of(pos) == buffer.line_of(first) {
                        pos
                    } else {
                        first
                    };
                }
                Op::Change => {
                    let indent = buffer.first_nonblank(first);
                    buffer.remove(indent, last);
                    let at = indent;
                    let mut entered = self.enter_insert(buffer, at);
                    entered.yank = outcome.yank;
                    return entered;
                }
                Op::Delete => {
                    if last < buffer.len() {
                        buffer.remove(first, last + 1);
                        buffer.cursor = buffer.first_nonblank(first);
                    } else if first > 0 {
                        buffer.remove(first - 1, last);
                        buffer.cursor = buffer.first_nonblank(first - 1);
                    } else {
                        buffer.remove(first, last);
                        buffer.cursor = 0;
                    }
                }
            }
        } else {
            if end > start {
                outcome.yank = Some(buffer.chars[start..end].iter().collect());
            }
            match op {
                Op::Yank => buffer.cursor = start,
                Op::Delete => {
                    buffer.remove(start, end);
                    buffer.cursor = start;
                }
                Op::Change => {
                    buffer.remove(start, end);
                    let mut entered = self.enter_insert(buffer, start);
                    entered.yank = outcome.yank;
                    return entered;
                }
            }
        }
        buffer.clamp();
        outcome
    }

    fn visual(&mut self, buffer: &mut Buffer, c: char) -> Outcome {
        let pos = buffer.cursor;
        if let Some(prefix) = self.prefix.take() {
            match (prefix, c) {
                ('g', 'g') => {
                    self.motion_key(buffer, 'g');
                }
                ('i' | 'a', 'w' | 'W') => {
                    if let Some((start, end)) = buffer.word_object(pos, c == 'W', prefix == 'a') {
                        if self.anchor == self.head {
                            self.anchor = start;
                        }
                        buffer.cursor = end - 1;
                    }
                    self.count = None;
                }
                _ => self.count = None,
            }
            self.head = buffer.cursor;
            return Outcome::default();
        }
        if self.take_digit(c) {
            return Outcome::default();
        }
        let line = self.mode == Mode::VisualLine;
        let (low, high) = (self.anchor.min(pos), self.anchor.max(pos));
        let op = match c {
            'd' | 'x' | 'D' | 'X' => Some(Op::Delete),
            'c' | 's' | 'C' | 'S' => Some(Op::Change),
            'y' | 'Y' => Some(Op::Yank),
            _ => None,
        };
        if let Some(op) = op {
            let whole = line || c.is_uppercase();
            let end = if whole {
                high
            } else {
                (high + 1).min(buffer.len())
            };
            return self.apply(buffer, op, low, end, whole, low);
        }
        match c {
            'g' | 'i' | 'a' => self.prefix = Some(c),
            'o' => {
                std::mem::swap(&mut self.anchor, &mut self.head);
                buffer.cursor = self.head;
                self.count = None;
            }
            'v' | 'V' => {
                let mode = if c == 'v' {
                    Mode::Visual
                } else {
                    Mode::VisualLine
                };
                self.count = None;
                if self.mode == mode {
                    self.mode = Mode::Normal;
                    buffer.clamp();
                } else {
                    self.mode = mode;
                }
            }
            _ => {
                self.motion_key(buffer, c);
                self.head = buffer.cursor;
            }
        }
        Outcome::default()
    }
}

/// Key bindings for a focused box in vim mode. `fallback` gives the box's usual bindings.
pub fn binding(
    press: text_editor::KeyPress,
    target: Target,
    vim: &Vim,
    sequence: &str,
    fallback: impl FnOnce(text_editor::KeyPress) -> Option<Binding<Message>>,
) -> Option<Binding<Message>> {
    if !matches!(press.status, text_editor::Status::Focused { .. }) {
        return None;
    }
    let send = |input| Some(Binding::Custom(Message::Vim(target, input)));
    let plain = !press.modifiers.command() && !press.modifiers.control() && !press.modifiers.logo();
    if press.key == Key::Named(Named::Escape) {
        return if vim.idle() {
            fallback(press)
        } else {
            send(Input::Escape)
        };
    }
    let text = press
        .text
        .as_deref()
        .and_then(|text| text.chars().find(|c| !c.is_control()));
    if vim.mode == Mode::Insert {
        return match text {
            Some(c) if plain && !sequence.is_empty() => send(Input::Char(c)),
            _ => fallback(press),
        };
    }
    if press.modifiers.control() && press.key.as_ref() == Key::Character("r") {
        return send(Input::Redo);
    }
    if !plain {
        return fallback(press);
    }
    let named = match press.key.as_ref() {
        Key::Named(Named::ArrowLeft) | Key::Named(Named::Backspace) => Some('h'),
        Key::Named(Named::ArrowRight) => Some('l'),
        Key::Named(Named::ArrowUp) => Some('k'),
        Key::Named(Named::ArrowDown) => Some('j'),
        Key::Named(Named::Delete) => Some('x'),
        Key::Named(Named::Home) => Some('0'),
        Key::Named(Named::End) => Some('$'),
        // The reply box sends on Enter in every mode.
        Key::Named(Named::Enter) if target == Target::Reply => return fallback(press),
        Key::Named(Named::Enter) => Some('\n'),
        _ => None,
    };
    match named.or(text) {
        Some(c) => send(Input::Char(c)),
        None => None,
    }
}

#[cfg(test)]
#[path = "vim_tests.rs"]
mod tests;
