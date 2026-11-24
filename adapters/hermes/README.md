# toolscode for Hermes Agent

The same shrink the dsh plugin and the pi extension run, mounted on Hermes —
which needs a different lever, and already does half the job itself.

Hermes gives a plugin exactly one public way to change what the model is about to
be shown:

```python
ctx.register_middleware("llm_request", callback)   # the only one that can replace
```

The callback runs on the kwargs the transport just built — `model`, `messages`,
`tools`, everything — before the provider call, and returns `{"request": {...}}`
to replace them. That is a strictly better lever than the observer hooks Hermes
also has: `pre_api_request` fires inside a `try/except: pass` whose return value
is discarded, `pre_llm_call` can only append to the user message, and
`register_system_prompt_section` is capped at 4000 characters a section and can
only add. So `__init__.py` is thin, and the shrink lives in
[`toolscode_core.py`](./toolscode/toolscode_core.py): a port of
[`lib/wire.js`](../../lib/wire.js) that the JavaScript harnesses use, tested
against the same fixture.

## Install

`hermes plugins install supakiat-debug/dsh-plugin-toolscode` expects the plugin
at the *repo root*, and this repository is a dsh bundle whose Python adapter lives
in a subdirectory. Until the layout is settled, point Hermes at the directory:

```sh
# from a clone of this repo
mkdir -p ~/.hermes/plugins
cp -r adapters/hermes/toolscode ~/.hermes/plugins/toolscode
hermes plugins enable toolscode
hermes plugins list                       # toolscode should be listed and enabled
```

On Windows the config home is `%USERPROFILE%\.hermes\plugins\toolscode`. A
project-local `.hermes/plugins/toolscode` also works with
`HERMES_ENABLE_PROJECT_PLUGINS=1`. `HERMES_PLUGINS_DEBUG=1` prints what was
discovered and, more usefully, why something was not.

The directory has to be named `toolscode` and contain `plugin.yaml` next to
`__init__.py`: Hermes derives the plugin key from the directory name, imports the
package with `spec_from_file_location(..., submodule_search_locations=[dir])`, and
sets `__path__`, which is what lets `__init__.py` say
`from .toolscode_core import ...`.

## Configure

Hermes hands a plugin no config accessor — `plugin.yaml` declares `requires_env`
and the plugin reads what it needs — so this adapter reads JSON:

```json
{
  "enabled": true,
  "include": ["*"],
  "exclude": [],
  "drop": [],
  "minChars": 0,
  "descriptionCap": 200,
  "nestedDescriptionCap": 100,
  "systemSections": {},
  "systemCap": 0
}
```

at `~/.hermes/toolscode.json`, then applies environment overrides on top of it:
`TOOLSCODE_ENABLED=0`, `TOOLSCODE_DROP=web_search,browser_*` (comma-separated),
`TOOLSCODE_DESCRIPTION_CAP=120`. Environment wins because the person debugging a
surprising prompt should be able to override a file without editing it. JSON
rather than the `config.yaml` you already have is a deliberate limitation: PyYAML
is a dependency of Hermes, not of the standard library, and a plugin that imports
it cannot be tested on an interpreter Hermes refuses to install onto.

Keys mean the same thing they do in dsh and pi: `descriptionCap` is what a tool's
own description is cut to, `nestedDescriptionCap` what every property description
is cut to, `minChars` spares tools already small enough to not be worth the
round-trip risk, `include`/`exclude` steer by name, `drop` takes a tool off the
wire entirely, `systemSections` replaces or (`""`) removes a system-prompt heading
block, `systemCap` bluntly cuts the tail with a visible marker.

## What it deliberately does not touch

Hermes already collapses what it can, and a second collapse on top is how you get
a prompt that lost information twice:

- `tools.tool_search.{enabled, threshold_pct, listing_max_tokens, defer}` defers
  tools and hands back a curated catalog with `tool_search` / `tool_describe` /
  `tool_call` bridges. That is the same job this plugin does with `drop`, done by
  the harness, with a real fetch-back path.
- `skills.index_desc_limit` caps skill descriptions; compression prunes old turns;
  Anthropic prompt caching is applied automatically.
- The bridge tools and `execute_code` carry a **generated tool list inside their
  own description**. Cutting one at a character budget would not save prose, it
  would leave the model holding half a list of the tools it was told to reach for.
  They are in `BRIDGE_TOOLS` and excluded by default; your own `exclude` extends
  that list, and setting it is how you opt back in.

So the honest pitch on Hermes is narrower than on dsh: shrink what Hermes does not
— MCP tool descriptions (`mcp_<server>_<tool>`), third-party plugin tools, your own
`register_tool` definitions — and leave its catalog alone.

## Two properties the middleware depends on

**Nothing is mutated.** `model_tools.get_tool_definitions` memoizes and hands the
same dicts to every request, so the core copies every container it changes and
`test_wire.py` asserts the input comes back byte-identical. Hermes also hands the
middleware a deep copy already; that is a courtesy the code does not rely on.

**The cache still works.** The middleware runs after Hermes decorates the prompt
with Anthropic `cache_control` breakpoints. The rewrite keeps every sibling key of
the block it replaces — including `cache_control`, asserted in `test_wire.py` —
and because the shrink is deterministic, the prefix is identical from the second
request on, so a breakpoint still bounds a stable prefix. The first request after
a config change pays a cache write; that is the cost of the shrink, and it is paid
once.

## Verify

```sh
python adapters/hermes/test_wire.py    # 26 tests, standard library only
npm run test:parity                    # the JS and Python shrinkers, same payloads
```

`test_wire.py` reads the same fixture `test/wire.test.mjs` reads and asserts the
same pinned truncated strings, so the two implementations cannot drift silently.
`test:parity` goes further: it shrinks every fixture payload through both
implementations and compares the entire output — payload and report — as text
(218 lines, currently identical). Python 3.11+ is what Hermes wants; the tests are
also run here on 3.14, which is a version `hermes-agent` itself refuses to install
on, and they pass.

## Not verified

- Whether every transport routes through the same payload build. The middleware
  sees what `build_request_payload` produced; the codex Responses preflight runs
  before middleware, and a MoA/relay fan-out is several requests, each shrunk
  once. If you run one of those paths, check the middleware trace — a rewrite
  records `source: "toolscode"` and a `reason` with the character counts.
- `hermes plugins install` against this repository (see Install).
- Real token savings on a live Hermes session: this work was done against the
  source and the wheel, with no API key and no model call, so every number in
  this repository is a character count, never a token count.
