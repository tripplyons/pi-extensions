# Auto-rename

Names unnamed sessions in the background as soon as the first prompt reaches the
agent, using a separate request to
`gpt-6-luna` with low reasoning and fast mode (OpenAI priority service).
Title generation uses an authenticated `openai` provider, or `openai-codex` as a
fallback, regardless of the session's selected model or fast-mode setting.
Naming does not block the agent or turn completion. Existing names, including
manual names set while generation is running, are preserved. Results from a
previous session are ignored. Pi-desk refreshes the title when naming finishes. The request includes only text from the first user
message on the active branch, capped at 60,000 characters. Assistant replies,
later user messages, images, and tool results are excluded.
The request disables cache retention to keep it separate from the live agent
session. Missing Luna authentication and provider failures produce a warning and
leave the session unnamed. Use `/login` to configure OpenAI authentication.
