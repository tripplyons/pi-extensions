# LM Studio

Adds `lm-studio` as a Pi provider using LM Studio's local OpenAI-compatible
Chat Completions endpoint. Requires an LM Studio server with `/api/v1/models`.

## Use

1. Start the local server in LM Studio's Developer tab. The default address is
   `http://localhost:1234`.
2. Run `/reload` in Pi, then `/model` and search for `lm-studio`.
3. Run `/lm-studio` to refresh the catalog after downloading, loading, or unloading
   models. This does not change your selected model.

You can also select an exact ID with `/models lm-studio/<model-id>` or start Pi
with `--provider lm-studio --model <model-id>`.

The extension discovers chat models before startup model selection. Embedding
models are excluded. Loaded instances use their instance IDs and configured
context lengths. Unloaded models use their model keys and advertised maximum
context lengths; LM Studio controls just-in-time loading. After a model loads,
refresh the catalog so Pi sees its actual context limit. Models without context
metadata default to 32,768 tokens. Output is capped at 8,192 tokens or the context
limit, whichever is smaller.

Vision and reasoning support come from LM Studio's
[model catalog](https://lmstudio.ai/docs/developer/rest/list). The thinking picker
shows only choices supported by each model:

- Toggle-only models expose `off` and `high`. Here `high` means reasoning on,
  not a distinct effort setting. Always-on models expose only `high`.
- Effort-based models expose the advertised subset of `low`, `medium`, and
  `high`, plus `off` if the model allows it.
- Models without recognized reasoning options expose only `off` and send no
  `reasoning_effort` field.

Requests map `off` to `reasoning_effort: "none"`; enabled levels use their names.
`minimal`, `xhigh`, and `max` are not advertised by the catalog, so the picker
omits them. Pi clamps unsupported explicit requests to a supported level.
When no level is requested and `off` is unavailable, the request omits the field
and leaves LM Studio's default intact. The model and runtime control the resulting
reasoning behavior. Models not trained for tool use can appear in the list but
may not work well as coding agents.

No login is needed for an unauthenticated local server. Requests use a dummy
`lm-studio` key. Token usage comes from the server; API cost is zero. Discovery
has a three-second timeout. If the server is unavailable at startup, Pi still
starts; run `/lm-studio` after starting the server. A failed refresh preserves
the last catalog. Catalogs are not persisted by this extension.

## Optional settings

Set environment variables before starting Pi:

```sh
export LM_STUDIO_BASE_URL=http://localhost:1234/v1
# Only if you enabled API token authentication in LM Studio:
export LM_STUDIO_API_KEY=<your-token>
```

The base URL accepts the server root or its `/v1` endpoint. Keep credentials
outside this repository. Pi's `models.json` can override individual model
metadata, such as context limits or sampling parameters, under provider
`lm-studio`.
