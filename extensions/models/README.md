# Models

`/models` lists authenticated models; `/models provider/id` selects an exact ID.
Pi's native `/model` picker is unchanged. Use
[thinking-selector](../thinking-selector) for the Ctrl+T reasoning effort picker.

Selection uses Pi's registry and session APIs. Pi owns persistence and restores
model/thinking entries when resuming a session; this extension does not maintain
a competing model preference. The available set follows Pi's installed provider
catalog and your model overrides, not a duplicated static model list.
