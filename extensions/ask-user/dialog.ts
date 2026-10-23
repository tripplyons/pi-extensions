import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Input, ScrollView, Text, truncateToWidth, type Component, type Focusable, type KeybindingsManager, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";

class QuestionDialog implements Component, Focusable {
  private readonly input = new Input();
  private readonly question: ScrollView;
  private selected = 0;
  private answerTop = 0;
  private questionHeight = 0;

  constructor(
    question: string,
    private readonly choices: string[],
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keys: KeybindingsManager,
    private readonly done: (answer: string | undefined) => void,
    readonly dispose: () => void,
  ) {
    this.question = new ScrollView(new Text(theme.fg("accent", question), 0, 0), { scrollbar: "hidden", overscroll: "contain" });
  }

  get focused() { return this.input.focused; }
  set focused(value: boolean) { this.input.focused = value; }

  invalidate() {
    this.question.invalidate();
    this.input.invalidate();
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    const height = Math.max(1, this.tui.terminal.rows);
    const framed = height >= 6;
    const showHelp = height >= 3;
    const bodyHeight = height - (framed ? 2 : 0) - (showHelp ? 1 : 0);
    const questionLines = this.question.render(width);
    const answers: string[] = [];
    let selectedStart = 0, selectedEnd = 0;
    if (this.choices.length) {
      this.choices.forEach((choice, index) => {
        const selected = index === this.selected;
        if (selected) selectedStart = answers.length;
        answers.push(...new Text(this.theme.fg(selected ? "accent" : "text", `${selected ? "→ " : "  "}${choice}`), 0, 0).render(width));
        if (selected) selectedEnd = answers.length;
      });
    } else {
      answers.push(...this.input.render(width));
    }
    let answerHeight = Math.min(answers.length, Math.max(1, Math.floor(bodyHeight * 0.4)));
    this.questionHeight = Math.min(questionLines.length, bodyHeight - answerHeight);
    answerHeight = Math.min(answers.length, bodyHeight - this.questionHeight);
    // The regular renderer does not lay out ScrollView nodes. Use its scroll
    // state and explicitly clip the viewport in both terminal modes.
    this.question.updateLayout(questionLines.length, this.questionHeight, () => this.tui.requestRender());
    this.answerTop = Math.max(0, Math.min(this.answerTop, answers.length - answerHeight));
    if (selectedStart < this.answerTop) this.answerTop = selectedStart;
    if (selectedEnd > this.answerTop + answerHeight) this.answerTop = Math.min(selectedStart, selectedEnd - answerHeight);
    const lines = questionLines.slice(this.question.scrollTop, this.question.scrollTop + this.questionHeight);
    lines.push(...answers.slice(this.answerTop, this.answerTop + answerHeight));
    if (showHelp) {
      const first = this.questionHeight ? this.question.scrollTop + 1 : 0;
      const last = this.question.scrollTop + this.questionHeight;
      const help = `PgUp/PgDn ${first}-${last}/${questionLines.length} · ${this.choices.length ? "↑↓ choose · " : ""}Enter answer · Esc cancel`;
      lines.push(this.theme.fg("dim", truncateToWidth(help, width, this.theme.fg("dim", "..."))));
    }
    if (framed) {
      const border = this.theme.fg("border", "─".repeat(width));
      lines.unshift(border);
      lines.push(border);
    }
    return lines.map(line => truncateToWidth(line, width, ""));
  }

  handleInput(data: string) {
    if (this.keys.matches(data, "tui.select.cancel")) this.done(undefined);
    else if (this.keys.matches(data, "tui.select.pageUp")) this.question.scrollBy(-Math.max(1, this.questionHeight - 1));
    else if (this.keys.matches(data, "tui.select.pageDown")) this.question.scrollBy(Math.max(1, this.questionHeight - 1));
    else if (this.choices.length) {
      if (this.keys.matches(data, "tui.select.up") || data === "k") this.selected = Math.max(0, this.selected - 1);
      else if (this.keys.matches(data, "tui.select.down") || data === "j") this.selected = Math.min(this.choices.length - 1, this.selected + 1);
      else if (this.keys.matches(data, "tui.select.confirm") || data === "\n") this.done(this.choices[this.selected]);
    } else if (this.keys.matches(data, "tui.select.confirm") || data === "\n") this.done(this.input.getValue());
    else this.input.handleInput(data);
    this.tui.requestRender();
  }

  handleMouse(event: TuiMouseEvent) {
    if (event.type !== "wheel") return undefined;
    this.question.scrollBy(event.wheelDelta ?? 0);
    return { handled: true };
  }
}

// RPC clients retain the native request/response dialogs; custom UI is TUI-only.
export async function askQuestion(ctx: ExtensionContext, question: string, choices: string[], signal: AbortSignal): Promise<string | undefined> {
  if (ctx.mode !== "tui") return choices.length
    ? ctx.ui.select(question, choices, { signal })
    : ctx.ui.input(question, "Free-text answer", { signal });
  let cleanup = () => {};
  try {
    return await ctx.ui.custom<string | undefined>((tui, theme, keys, done) => {
      let finished = false;
      const finish = (answer: string | undefined) => {
        if (finished) return;
        finished = true;
        cleanup();
        done(answer);
      };
      const abort = () => finish(undefined);
      cleanup = () => signal.removeEventListener("abort", abort);
      const dialog = new QuestionDialog(question, choices, tui, theme, keys, finish, cleanup);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      return dialog;
    }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "bottom-center", margin: 0 } });
  } finally {
    cleanup();
  }
}
