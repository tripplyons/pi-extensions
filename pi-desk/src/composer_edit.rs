//! Undo history for vim mode, where a whole insert undoes as one step.
//!
//! Without vim mode, boxes use the text field's own undo.

use rune::TextEdit;

#[derive(Debug, Clone, PartialEq)]
struct Snapshot {
    text: String,
    anchor: usize,
    focus: usize,
}

impl Snapshot {
    fn capture(edit: &TextEdit) -> Self {
        Self {
            text: edit.text.clone(),
            anchor: edit.anchor,
            focus: edit.focus,
        }
    }

    fn restore(self, edit: &mut TextEdit) {
        edit.replace_text(self.text);
        edit.set_selection(self.anchor, self.focus);
    }
}

#[derive(Debug, Default)]
pub struct History {
    undo: Vec<Snapshot>,
    redo: Vec<Snapshot>,
    /// The box as this history last saw it, so a change made by the field
    /// itself (typing in insert mode) can be recorded afterwards.
    seen: Option<Snapshot>,
}

impl History {
    fn record(&mut self, snapshot: Snapshot) {
        if self.undo.len() == 100 {
            self.undo.remove(0);
        }
        self.undo.push(snapshot);
        self.redo.clear();
    }

    pub fn depth(&self) -> usize {
        self.undo.len()
    }

    /// Records `edit` as one undo step before an outside change.
    pub fn checkpoint(&mut self, edit: &TextEdit) {
        self.record(Snapshot::capture(edit));
    }

    /// Notes the box's current state without recording a step.
    pub fn sync(&mut self, edit: &TextEdit) {
        self.seen = Some(Snapshot::capture(edit));
    }

    /// Records the state before a change the field made itself.
    pub fn observe(&mut self, edit: &TextEdit) {
        if let Some(seen) = self.seen.take()
            && seen.text != edit.text
        {
            self.record(seen);
        }
        self.sync(edit);
    }

    /// Merges the steps after `mark` into one, so a whole insert undoes at once.
    /// Drops the merged step if it no longer changes the text.
    pub fn collapse(&mut self, mark: usize, edit: &TextEdit) {
        if self.undo.len() > mark + 1 {
            self.undo.truncate(mark + 1);
        }
        if self.undo.len() > mark && self.undo.last().is_some_and(|last| last.text == edit.text) {
            self.undo.pop();
        }
    }

    /// Inserts `text` at the cursor as one step.
    pub fn insert(&mut self, edit: &mut TextEdit, text: &str) {
        let before = Snapshot::capture(edit);
        edit.insert(text);
        if before.text != edit.text {
            self.record(before);
        }
        self.sync(edit);
    }

    pub fn undo(&mut self, edit: &mut TextEdit) {
        if let Some(snapshot) = self.undo.pop() {
            self.redo.push(Snapshot::capture(edit));
            snapshot.restore(edit);
        }
        self.sync(edit);
    }

    pub fn redo(&mut self, edit: &mut TextEdit) {
        if let Some(snapshot) = self.redo.pop() {
            self.undo.push(Snapshot::capture(edit));
            snapshot.restore(edit);
        }
        self.sync(edit);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn insert_undo_redo_and_new_edit() {
        let mut edit = TextEdit::new("hello");
        let mut history = History::default();
        history.insert(&mut edit, " world");
        assert_eq!(edit.text, "hello world");
        history.undo(&mut edit);
        assert_eq!(edit.text, "hello");
        assert_eq!(edit.focus, 5);
        history.redo(&mut edit);
        assert_eq!(edit.text, "hello world");
        history.undo(&mut edit);
        history.insert(&mut edit, "!");
        history.redo(&mut edit);
        assert_eq!(edit.text, "hello!", "a new edit clears redo");
    }

    #[test]
    fn field_changes_are_observed_and_collapse_into_one_step() {
        let mut edit = TextEdit::new("");
        let mut history = History::default();
        history.sync(&edit);
        let mark = history.depth();
        for c in ["a", "b", "c"] {
            edit.insert(c);
            history.observe(&edit);
        }
        assert_eq!(history.depth(), 3);
        history.collapse(mark, &edit);
        assert_eq!(history.depth(), 1);
        history.undo(&mut edit);
        assert_eq!(edit.text, "");
    }

    #[test]
    fn unicode_selection_survives_undo() {
        let mut edit = TextEdit::new("é🙂 hello");
        edit.set_selection(2, 6);
        let mut history = History::default();
        history.checkpoint(&edit);
        edit.insert("");
        history.undo(&mut edit);
        assert_eq!(edit.text, "é🙂 hello");
        assert_eq!(edit.selected(), "🙂");
    }
}
