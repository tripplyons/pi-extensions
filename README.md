# Pi extensions

Clean-room rework of Tripp's Stack Agent configuration for Pi. Work is on `rework`;
`main` is unchanged. No legacy extensions, conversion provider, patches, Mixture,
subagent framework, or compatibility shims are loaded.

## Extensions (0)

The old implementation has been removed. Replacement entry points are added in
subsequent commits. The target is all seven configured plugins plus Stack's shell,
file tools, swarm, compaction, fast mode, model/reasoning controls, usage, sessions,
skills, and retry/approval policy. Pi's public runtime owns native equivalents;
new extensions own only missing behavior.

Historical third-party license notices are retained under `licenses/`.
