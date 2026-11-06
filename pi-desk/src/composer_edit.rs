//! Composer-only editing rules and bounded undo history.

#[cfg(test)]
mod tests {
    use super::*;
    use iced::keyboard::{Modifiers, key};

    fn press(key: Key, modifiers: Modifiers) -> text_editor::KeyPress {
        text_editor::KeyPress {
            modified_key: key.clone(),
            key,
            physical_key: key::Physical::Code(key::Code::Backspace),
            modifiers,
            text: None,
            status: text_editor::Status::Focused { is_hovered: false },
        }
    }
    #[test]
    fn shortcuts_are_composer_commands() {
        for (modifiers, motion) in [
            (Modifiers::ALT, Motion::WordLeft),
            (Modifiers::LOGO, Motion::Home),
        ] {
            assert!(
                matches!(binding(press(Key::Named(Named::Backspace), modifiers)),
                Some(Binding::Custom(Message::ComposerCommand(Command::Delete(actual, true)))) if actual == motion)
            );
        }
        assert!(matches!(
            binding(press(Key::Character("z".into()), Modifiers::LOGO)),
            Some(Binding::Custom(Message::ComposerCommand(Command::Undo)))
        ));
        assert!(matches!(
            binding(press(
                Key::Character("z".into()),
                Modifiers::LOGO | Modifiers::SHIFT
            )),
            Some(Binding::Custom(Message::ComposerCommand(Command::Redo)))
        ));
        assert!(matches!(
            binding(press(
                Key::Named(Named::ArrowUp),
                Modifiers::LOGO | Modifiers::SHIFT
            )),
            Some(Binding::Select(Motion::DocumentStart))
        ));
    }
    #[test]
    fn word_delete_undo_redo_and_new_edit() {
        let mut content = text_editor::Content::with_text("hello world");
        content.perform(Action::Move(Motion::DocumentEnd));
        let mut history = History::default();
        history.command(&mut content, Command::Delete(Motion::WordLeft, true));
        assert_eq!(content.text(), "hello ");
        history.command(&mut content, Command::Undo);
        assert_eq!(content.text(), "hello world");
        assert_eq!(content.cursor().position.column, 11);
        history.command(&mut content, Command::Redo);
        assert_eq!(content.text(), "hello ");
        history.command(&mut content, Command::Undo);
        history.edit(&mut content, Action::Edit(Edit::Insert('!')));
        history.command(&mut content, Command::Redo);
        assert_eq!(content.text(), "hello world!");
    }
    #[test]
    fn unicode_cursor_and_forward_delete_survive_undo() {
        let mut content = text_editor::Content::with_text("é🙂 hello\nnext");
        content.perform(Action::Move(Motion::Right));
        content.perform(Action::Move(Motion::Right));
        let position = content.cursor().position;
        let mut history = History::default();
        history.command(&mut content, Command::Delete(Motion::End, false));
        assert_eq!(content.text(), "é🙂\nnext");
        history.command(&mut content, Command::Undo);
        assert_eq!(content.text(), "é🙂 hello\nnext");
        assert_eq!(content.cursor().position, position);
    }

    #[test]
    fn deletion_respects_selection_and_line_boundary() {
        let mut content = text_editor::Content::with_text("one\ntwo");
        let mut history = History::default();
        content.perform(Action::Move(Motion::DocumentEnd));
        content.perform(Action::Move(Motion::Home));
        history.command(&mut content, Command::Delete(Motion::Home, true));
        assert_eq!(content.text(), "one\ntwo");
        content.perform(Action::Select(Motion::Right));
        history.command(&mut content, Command::Delete(Motion::WordLeft, true));
        assert_eq!(content.text(), "one\nwo");
        history.command(&mut content, Command::Undo);
        assert_eq!(content.selection().as_deref(), Some("t"));
    }
}
use crate::app::Message;
use iced::keyboard::{Key, key::Named};
use iced::widget::text_editor::{self, Action, Binding, Edit, Motion};

#[derive(Debug, Clone)]
pub enum Command {
    Delete(Motion, bool),
    Undo,
    Redo,
}

pub fn binding(press: text_editor::KeyPress) -> Option<Binding<Message>> {
    if !matches!(press.status, text_editor::Status::Focused { .. }) {
        return None;
    }
    if press.modifiers.macos_command() {
        match press.key.as_ref() {
            Key::Character("z") => {
                return Some(Binding::Custom(Message::ComposerCommand(
                    if press.modifiers.shift() {
                        Command::Redo
                    } else {
                        Command::Undo
                    },
                )));
            }
            Key::Named(Named::ArrowUp | Named::ArrowDown) => {
                let motion = if press.key == Key::Named(Named::ArrowUp) {
                    Motion::DocumentStart
                } else {
                    Motion::DocumentEnd
                };
                return Some(if press.modifiers.shift() {
                    Binding::Select(motion)
                } else {
                    Binding::Move(motion)
                });
            }
            _ => {}
        }
    }
    let backward = match press.key.as_ref() {
        Key::Named(Named::Backspace) => Some(true),
        Key::Named(Named::Delete) => Some(false),
        _ => None,
    };
    if let Some(backward) = backward {
        let motion = if press.modifiers.macos_command() {
            Some(if backward { Motion::Home } else { Motion::End })
        } else if press.modifiers.alt() {
            Some(if backward {
                Motion::WordLeft
            } else {
                Motion::WordRight
            })
        } else {
            None
        };
        if let Some(motion) = motion {
            return Some(Binding::Custom(Message::ComposerCommand(Command::Delete(
                motion, backward,
            ))));
        }
    }
    Binding::from_key_press(press)
}

struct Snapshot {
    text: String,
    cursor: text_editor::Cursor,
}
impl Snapshot {
    fn capture(content: &text_editor::Content) -> Self {
        Self {
            text: content.text(),
            cursor: content.cursor(),
        }
    }
    fn restore(self, content: &mut text_editor::Content) {
        *content = text_editor::Content::with_text(&self.text);
        // Positions are byte offsets, as the editor stores them.
        content.move_to(self.cursor);
    }
}

#[derive(Default)]
pub struct History {
    undo: Vec<Snapshot>,
    redo: Vec<Snapshot>,
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
    /// Records `content` as one undo step before an outside change.
    pub fn checkpoint(&mut self, content: &text_editor::Content) {
        self.record(Snapshot::capture(content));
    }
    /// Merges the steps after `mark` into one, so a whole insert undoes at once.
    /// Drops the merged step if it no longer changes the text.
    pub fn collapse(&mut self, mark: usize, content: &text_editor::Content) {
        if self.undo.len() > mark + 1 {
            self.undo.truncate(mark + 1);
        }
        if self.undo.len() > mark
            && self
                .undo
                .last()
                .is_some_and(|last| last.text == content.text())
        {
            self.undo.pop();
        }
    }
    pub fn edit(&mut self, content: &mut text_editor::Content, action: Action) {
        let before = action.is_edit().then(|| Snapshot::capture(content));
        content.perform(action);
        if let Some(before) = before
            && before.text != content.text()
        {
            self.record(before);
        }
    }
    pub fn command(&mut self, content: &mut text_editor::Content, command: Command) {
        match command {
            Command::Delete(motion, backward) => {
                let before = Snapshot::capture(content);
                if content.selection().is_none() {
                    content.perform(Action::Select(motion));
                }
                if content.selection().is_none() {
                    return;
                }
                content.perform(Action::Edit(if backward {
                    Edit::Backspace
                } else {
                    Edit::Delete
                }));
                if before.text != content.text() {
                    self.record(before);
                }
            }
            Command::Undo | Command::Redo => {
                let (from, to) = if matches!(command, Command::Undo) {
                    (&mut self.undo, &mut self.redo)
                } else {
                    (&mut self.redo, &mut self.undo)
                };
                if let Some(snapshot) = from.pop() {
                    to.push(Snapshot::capture(content));
                    snapshot.restore(content);
                }
            }
        }
    }
}
