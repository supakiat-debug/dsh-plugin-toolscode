"""toolscode for Hermes — one middleware, applied to the request Hermes sends.

Hermes gives a plugin exactly one public way to change what the model is about
to be shown: ``ctx.register_middleware("llm_request", callback)``. The callback
runs in ``agent/conversation_loop.py`` on the kwargs the transport just built —
``model``, ``messages``, ``tools``, everything — before the provider call, and
returns ``{"request": {...}}`` to replace them. That is a strictly better lever
than the observer hooks it also has (``pre_api_request`` fires in a
``try/except: pass`` whose return value is discarded, and
``pre_llm_call`` can only append to the user message), and a strictly better one
than appending text with ``register_system_prompt_section``, which is capped at
4000 characters a section and can only add.

So this file is thin, on purpose. The shrink itself lives in
:mod:`toolscode_core`, which is a port of the JavaScript ``lib/wire.js`` that pi
and dsh also use, tested against the same fixture. What is Hermes-specific stays
here:

* **What not to touch.** Hermes already collapses what it can: ``tool_search``
  defers tools and hands back a curated catalog, ``skills.index_desc_limit``
  caps the skill index, compression prunes old turns. The bridge tools it
  injects (``tool_search``, ``tool_describe``, ``tool_call``) and ``execute_code``
  carry a *generated tool list* inside their own description — cutting that at a
  character budget would not save prose, it would break the list the model needs
  to reach the deferred tools. They are excluded by default; a config ``exclude``
  extends that list, and setting your own is how you opt back in.
* **Not mutating anything shared.** ``model_tools.get_tool_definitions`` memoizes
  and hands the same dicts to every request, so the core copies every container
  it changes. Hermes also hands this middleware a deep copy already; that is a
  courtesy we do not rely on.
* **Cache markers.** The middleware runs after Hermes decorates the prompt with
  Anthropic ``cache_control`` breakpoints. The rewrite keeps every sibling key of
  the block it replaces, and because the shrink is deterministic the prefix is
  identical from the second request on, so the breakpoints still bound a stable
  prefix. ``test_wire.py`` asserts the markers survive.

Install: ``hermes plugins install supakiat-debug/dsh-plugin-toolscode`` needs the
plugin at the repo root, so until that is arranged, copy or link this
``toolscode`` directory into ``~/.hermes/plugins/`` (or ``./.hermes/plugins/``
with ``HERMES_ENABLE_PROJECT_PLUGINS=1``) and enable it:
``hermes plugins enable toolscode``. ``HERMES_PLUGINS_DEBUG=1`` prints what was
discovered and why not.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, Optional

from .toolscode_core import load_config, shrink_wire_payload

logger = logging.getLogger(__name__)

#: Tools whose description is a generated catalog rather than prose about the
#: tool itself. Truncating one would leave the model with half a list of the
#: tools it was told to reach for, so the shrink stays off them.
BRIDGE_TOOLS = ["tool_search", "tool_describe", "tool_call", "execute_code"]

_STATE: Dict[str, Any] = {"config": None, "report": None, "requests": 0, "changed": 0}


def _config() -> Dict[str, Any]:
    config = load_config()
    config["exclude"] = list(BRIDGE_TOOLS) + list(config.get("exclude") or [])
    return config


def report() -> Optional[Dict[str, Any]]:
    """The last shrink Hermes ran through this plugin, for debugging."""
    return _STATE["report"]


def register(ctx) -> None:
    """Entry point Hermes calls when it loads the plugin."""
    config = _config()
    _STATE["config"] = config
    if not config.get("enabled", True):
        logger.info("toolscode: disabled (TOOLSCODE_ENABLED=0 or config), no middleware registered")
        return
    ctx.register_middleware("llm_request", shrink_request)
    logger.info(
        "toolscode: llm_request middleware active — descriptionCap=%s nestedDescriptionCap=%s "
        "minChars=%s drop=%s exclude=%s",
        config.get("descriptionCap"),
        config.get("nestedDescriptionCap"),
        config.get("minChars"),
        config.get("drop"),
        config.get("exclude"),
    )


def shrink_request(request: Any = None, original_request: Any = None, **context: Any) -> Optional[Dict[str, Any]]:
    """Rewrite the outgoing request, or return ``None`` to leave it alone.

    Hermes calls this with ``request`` (the working copy), ``original_request``,
    and its own context kwargs; the kwargs grow between releases, so
    ``**context`` is part of the contract rather than laziness. Returning a dict
    with ``request`` replaces the kwargs, and ``source``/``reason`` land in
    Hermes' middleware trace, which is the only place a rewritten prompt is
    visible from the outside.
    """
    if not isinstance(request, dict):
        return None
    config = _STATE["config"] or _config()
    if "tools" not in request and "messages" not in request and "system" not in request:
        return None  # not a chat payload we recognise; leave whatever this is alone
    result = shrink_wire_payload(request, config)
    summary = result["report"]
    _STATE["requests"] += 1
    _STATE["report"] = summary
    unchanged = (
        summary["toolsAfter"] == summary["toolsBefore"]
        and summary["systemAfter"] == summary["systemBefore"]
        and len(summary["dropped"]) == 0
    )
    if unchanged:
        # Handing back the same thing the middleware was given, without a trace
        # entry, keeps Hermes' `changed` flag honest: nothing here claims to have
        # rewritten a request it did not.
        return None
    _STATE["changed"] += 1
    logger.debug(
        "toolscode: tools %s -> %s chars, system %s -> %s chars, dropped %s",
        summary["toolsBefore"],
        summary["toolsAfter"],
        summary["systemBefore"],
        summary["systemAfter"],
        summary["dropped"],
    )
    return {
        "request": result["payload"],
        "source": "toolscode",
        "reason": (
            f"tools {summary['toolsBefore']}->{summary['toolsAfter']} chars, "
            f"system {summary['systemBefore']}->{summary['systemAfter']} chars"
        ),
    }
