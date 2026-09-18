# Models and reasoning

`/models` lists authenticated models; `/models provider/id` selects an exact ID.
Pi's native `/model` picker is unchanged. `/reasoning`, `/thinking`, and `/effort`
show the current level and supported levels, or set one supplied as an argument.
Unsupported levels fail rather than silently choosing a different effort.

Selection uses Pi's registry and session APIs. Pi owns persistence and restores
model/thinking entries when resuming a session; this extension does not maintain
a competing model preference. The available set follows Pi's installed provider
catalog and your model overrides, not a duplicated static model list.
