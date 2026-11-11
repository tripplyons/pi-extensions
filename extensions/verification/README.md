# Verification

Adds finishing rules to every run's system prompt. Before the agent reports a
task as done, it rereads the request, lists each requirement, runs the checks a
reviewer would run, and fixes and reruns failed checks. It must name any check
it skipped.

The rules go into `appendSystemPrompt`, after any `--append-system-prompt`
text. Pi-native providers and the Claude Agent SDK bridge both send that field.
The bridge drops custom prompt sections and tool guidelines. The text is
constant, so it does not break prompt caching between turns.
