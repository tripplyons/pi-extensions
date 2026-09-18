# Goals

Tools: `create_goal`, `get_goal`, `update_goal`. Creation requires explicit user
intent. `/goal new <objective>`, `status`, `pause`, `resume`, and `clear` give the
user control. Active goals queue continuation turns until complete or blocked.
A blocked report requires at least three continuation turns; the model must also
verify the same impasse repeated without progress. Only the user can pause/resume.

Objectives, active elapsed time, and token usage persist on the session branch.
Resume/fork/tree navigation loads goals paused; use `/goal resume` to restart.
Errors and aborts pause continuation to avoid runaway paid requests.

`/goal edit <objective>` changes the objective without changing its status.
Stack-style `/goal:status`, `/goal:edit`, `/goal:pause`, `/goal:resume`, and
`/goal:clear` are also supported. A user can resume blocked or completed goals;
every resume resets the minimum continuation count for a new blocked audit.

Tool results display as plain-text previews instead of JSON. Expand a result to
see all fields and output; structured result data is unchanged.
