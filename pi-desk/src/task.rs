//! Work an update asks for: futures whose result is another message, and
//! window requests that need Rune's `Tx` (scrolling, the clipboard, dialogs).

use crate::app::Message;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock, mpsc};

pub type Boxed = Pin<Box<dyn Future<Output = Message> + Send>>;

/// A window request, applied in a handler or in `poll`.
pub enum Ui {
    /// Scroll the element with this key into view.
    Reveal(String),
    Copy(String),
    /// Read the clipboard's text and send the message it makes.
    Paste(Box<dyn FnOnce(Option<String>) -> Message + Send>),
    /// Ask for a folder and send [`Message::ProjectPicked`].
    PickFolder,
}

#[derive(Default)]
pub struct Task {
    pub futures: Vec<Boxed>,
    pub ui: Vec<Ui>,
}

impl Task {
    pub fn none() -> Task {
        Task::default()
    }

    pub fn perform<T: Send + 'static>(
        future: impl Future<Output = T> + Send + 'static,
        map: impl FnOnce(T) -> Message + Send + 'static,
    ) -> Task {
        Task {
            futures: vec![Box::pin(async move { map(future.await) })],
            ui: Vec::new(),
        }
    }

    pub fn ui(request: Ui) -> Task {
        Task {
            futures: Vec::new(),
            ui: vec![request],
        }
    }

    pub fn batch(tasks: impl IntoIterator<Item = Task>) -> Task {
        let mut all = Task::none();
        for task in tasks {
            all.futures.extend(task.futures);
            all.ui.extend(task.ui);
        }
        all
    }

    pub fn is_empty(&self) -> bool {
        self.futures.is_empty() && self.ui.is_empty()
    }
}

/// The tokio runtime that runs futures: the caller's, else a shared one.
pub fn handle() -> tokio::runtime::Handle {
    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        return handle;
    }
    static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RUNTIME
        .get_or_init(|| {
            tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .thread_name("pi-desk")
                .build()
                .expect("tokio runtime")
        })
        .handle()
        .clone()
}

/// Messages from futures and background threads, delivered in `poll`.
pub struct Inbox {
    sender: mpsc::Sender<Message>,
    receiver: mpsc::Receiver<Message>,
    waker: Arc<Mutex<Option<rune::Waker>>>,
    /// Futures started and not yet delivered.
    running: Arc<AtomicUsize>,
}

impl Default for Inbox {
    fn default() -> Self {
        let (sender, receiver) = mpsc::channel();
        Inbox {
            sender,
            receiver,
            waker: Arc::default(),
            running: Arc::default(),
        }
    }
}

/// Sends messages to the window from any thread.
#[derive(Clone)]
pub struct Outbox {
    sender: mpsc::Sender<Message>,
    waker: Arc<Mutex<Option<rune::Waker>>>,
}

impl Outbox {
    pub fn send(&self, message: Message) {
        if self.sender.send(message).is_ok()
            && let Some(wake) = self.waker.lock().ok().and_then(|waker| waker.clone())
        {
            wake();
        }
    }
}

impl Inbox {
    pub fn set_waker(&self, waker: rune::Waker) {
        if let Ok(mut slot) = self.waker.lock() {
            *slot = Some(waker);
        }
    }

    pub fn outbox(&self) -> Outbox {
        Outbox {
            sender: self.sender.clone(),
            waker: self.waker.clone(),
        }
    }

    pub fn try_recv(&self) -> Option<Message> {
        self.receiver.try_recv().ok()
    }

    /// Runs `future` and delivers its message.
    pub fn spawn(&self, future: Boxed) {
        let outbox = self.outbox();
        let running = self.running.clone();
        running.fetch_add(1, Ordering::SeqCst);
        handle().spawn(async move {
            let message = future.await;
            outbox.send(message);
            running.fetch_sub(1, Ordering::SeqCst);
        });
    }

    /// Whether a started future hasn't delivered its message yet.
    pub fn busy(&self) -> bool {
        self.running.load(Ordering::SeqCst) > 0
    }
}
