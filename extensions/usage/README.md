# Codex usage

`/codex-usage` displays five-hour and weekly quota and reset times for the current
Codex account. Uses Pi's credential resolver (including its refresh handling),
then requests the same HTTPS endpoint as Stack. No token is written to disk,
passed to a shell, included in notifications, or sent through redirects.

Requests time out after 15 seconds, cap responses at 1 MiB, and are cancelled on
session/model changes or shutdown. An unlabelled primary window is treated as
weekly for Prime compatibility. Tests use synthetic credentials and HTTP responses;
no live account request has been made as part of verification.

API cost is separately displayed by presentation using Pi's recorded usage cost.
Priority-tier pricing and compaction-cost completeness still need auditing.

`/api-cost` totals assistant token usage and estimated API costs on the active
session branch, including failed responses with reported usage. It is not a
billing statement; subscription responses may report zero cost.
