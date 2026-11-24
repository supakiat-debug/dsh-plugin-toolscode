"""Harness-neutral prompt shrink, ported from ``lib/shrink.js`` + ``lib/wire.js``.

Hermes hands a plugin the kwargs it is about to POST — ``model``, ``messages``,
``tools`` — which is an OpenAI-chat payload. That is the same thing pi hands
``before_provider_request`` and the same thing dsh hands its executor wrapper, so
this file is a line-for-line port of the JavaScript module rather than a second
opinion about how to shrink a prompt:

    JS                              Python
    ``truncateText(text, cap)``     ``truncate_text(text, cap)``
    ``shrinkToolSchema(schema, o)`` ``shrink_tool_schema(schema, ...)``
    ``globMatch(patterns, name)``   ``glob_match(patterns, name)``
    ``detectShape / readTool``      ``detect_shape / read_tool``
    ``headingBlocks / apply...``    ``heading_blocks / apply_system_sections``
    ``shrinkWirePayload``           ``shrink_wire_payload``

Both are tested against ``test/fixtures/wire-payloads.json`` — the pinned
truncated strings in there are asserted by ``test_wire.py`` here and by
``test/wire.test.mjs`` there, so the two implementations cannot drift apart
silently. Two deliberate differences, both harmless and both noted:

* JavaScript counts UTF-16 code units, Python counts code points, so a cap
  measured against an emoji-heavy description can differ by a character. Tool
  prose is not emoji-heavy; a system prompt that was would only ever be cut one
  character differently, on both sides, consistently.
* ``json.dumps`` is used only to *measure* a tool entry (``json_chars``), never
  to produce what is sent, so its escaping differences from ``JSON.stringify``
  cannot change the request.

The two contracts that make it safe to run this on every request are the same
ones the JavaScript documents: pure and byte-stable (a rewriter that wobbled
would break prompt caching, which is the point), and never invent (a
``system_sections`` key matching nothing is reported, not injected).

Only the standard library is imported, so this is testable on any Python Hermes
will run on — including one Hermes itself refuses to install onto.
"""

from __future__ import annotations

import json
import os
import re
from typing import Any, Dict, List, Optional, Tuple

__all__ = [
    "OMIT",
    "DEFAULTS",
    "truncate_text",
    "shrink_tool_schema",
    "glob_match",
    "json_chars",
    "detect_shape",
    "read_tool",
    "patch_entry",
    "heading_blocks",
    "apply_system_sections",
    "shrink_wire_payload",
    "load_config",
]

#: Marks "leave this field alone" for :func:`patch_entry`, where ``None`` means
#: "remove the field" (JavaScript has one undefined for both jobs; Python needs
#: two values to keep ``descriptionCap: 0`` — delete the description — distinct
#: from "this entry was not touched").
OMIT = object()

#: Prose keys a schema may carry that the model only reads. Dropping or capping
#: these cannot change what the schema validates.
PROSE_KEYS = frozenset({"description", "title", "examples", "$comment"})

#: Keys whose values are sub-schemas and must be walked.
SUBSCHEMA_KEYS = frozenset(
    {
        "items", "additionalItems", "additionalProperties", "contains",
        "propertyNames", "not", "if", "then", "else",
        "anyOf", "oneOf", "allOf", "prefixItems",
        "properties", "patternProperties", "$defs", "definitions",
    }
)

#: Sub-schema keys that are ``name -> schema`` maps, so their object values are
#: sub-schemas and their keys are arbitrary property names, not keywords.
MAP_KEYS = frozenset({"properties", "patternProperties", "$defs", "definitions"})

_HEADING = re.compile(r"(#{1,6})\s+(.*)$")
_TRAILING_WS = re.compile(r"\s+$")
_GLOB_SPECIAL = re.compile(r"[.*+?^${}()|[\]\\]")

DEFAULTS: Dict[str, Any] = {
    "enabled": True,
    "include": ["*"],
    "exclude": [],
    "drop": [],
    "minChars": 0,
    "descriptionCap": 200,
    "nestedDescriptionCap": 100,
    "systemSections": {},
    "systemCap": 0,
}


def truncate_text(text: Any, cap: int) -> Any:
    """Cut ``text`` to at most ``cap`` characters, on a word boundary if cheap.

    Deterministic: same input and cap give the same bytes every time. A single
    ``…`` is appended when text was actually cut, so the model can tell the prose
    was trimmed rather than the tool being badly maintained.

    :param text: the original string; anything else passes through.
    :param cap: characters to keep; ``0`` drops the text entirely.
    """
    if not isinstance(text, str) or text == "":
        return text
    if cap <= 0:
        return ""
    if len(text) <= cap:
        return text
    cut = cap
    # Break on whitespace, but only when the break is not too early: below half
    # the cap a hard cut keeps more information than the sentence fragment does.
    space = max(text.rfind(" ", 0, cap + 1), text.rfind("\n", 0, cap + 1))
    if space > cap / 2:
        cut = space
    return _TRAILING_WS.sub("", text[:cut]) + "…"


def _shrink_node(node: Any, cap: int, depth: int) -> Any:
    if isinstance(node, list):
        if depth > 32:
            return node
        return [_shrink_node(item, cap, depth + 1) for item in node]
    if node is None or not isinstance(node, dict):
        return node
    out: Dict[str, Any] = {}
    for key, value in node.items():
        if key in PROSE_KEYS:
            if cap <= 0:
                continue
            if key == "examples":
                continue  # a pure prose payload, always droppable
            if isinstance(value, str):
                out[key] = truncate_text(value, cap)
            continue
        if key in SUBSCHEMA_KEYS and depth <= 32:
            if key in MAP_KEYS and isinstance(value, dict):
                out[key] = {name: _shrink_node(sub, cap, depth + 1) for name, sub in value.items()}
            else:
                out[key] = _shrink_node(value, cap, depth + 1)
            continue
        out[key] = value
    return out


def shrink_tool_schema(
    schema: Dict[str, Any],
    description_cap: int = 200,
    nested_description_cap: int = 100,
) -> Dict[str, Any]:
    """Shrink one tool schema, keeping its structure and validation semantics.

    Property order is preserved and structural keywords are copied untouched, so
    the shrunk schema still says the same thing about the same arguments — it
    just says less about itself.

    :param schema: ``{"name", "description", "parameters"}``.
    :param description_cap: characters kept of the tool's own description;
        ``0`` removes the key, which is what the JavaScript does too.
    :param nested_description_cap: characters kept of every prose string inside
        the parameter schema.
    """
    shrunk = dict(schema)
    shrunk["parameters"] = _shrink_node(schema.get("parameters"), nested_description_cap, 0)
    if description_cap <= 0:
        shrunk.pop("description", None)
    else:
        shrunk["description"] = truncate_text(schema.get("description") or "", description_cap)
    return shrunk


def glob_match(patterns: Any, name: str) -> bool:
    """Whether ``name`` matches any ``*``-glob in ``patterns``.

    An empty or missing list never matches, which is what makes ``exclude: []``
    mean "exclude nothing" and ``include: []`` mean "match everything" once the
    caller has decided which of the two it is wiring.
    """
    if not isinstance(patterns, list) or len(patterns) == 0:
        return False
    for pattern in patterns:
        if not isinstance(pattern, str):
            continue
        if pattern == "*":
            return True
        escaped = _GLOB_SPECIAL.sub(lambda m: ".*" if m.group(0) == "*" else "\\" + m.group(0), pattern)
        if re.fullmatch(escaped, name):
            return True
    return False


def json_chars(value: Any) -> int:
    """Approximate wire cost of ``value`` — a measurement, never the request.

    ``separators`` drops the spaces ``json.dumps`` would add, and
    ``ensure_ascii=False`` keeps non-ASCII as itself the way ``JSON.stringify``
    does, so the number is close to what the provider actually receives.
    """
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")))


def detect_shape(payload: Any) -> str:
    """Which provider shape a payload is in, from where a tool keeps its fields.

    The one question that distinguishes the three is whether a tool's own
    description sits beside its name or inside a ``function`` object, and whether
    its schema is called ``parameters`` or ``input_schema``.
    """
    tools = payload.get("tools") if isinstance(payload, dict) else None
    tools = tools if isinstance(tools, list) else []
    if len(tools) == 0:
        system = payload.get("system") if isinstance(payload, dict) else None
        if isinstance(system, str) or isinstance(system, list):
            return "anthropic"
        return "unknown"
    first = tools[0] if isinstance(tools[0], dict) else {}
    if isinstance(first.get("function"), dict):
        return "openai-chat"
    if first.get("input_schema"):
        return "anthropic"
    if first.get("parameters") or first.get("name"):
        return "openai-responses"
    return "unknown"


def read_tool(entry: Any) -> Optional[Dict[str, Any]]:
    """Read one element of ``tools`` as name / description / schema.

    :returns: the three fields the shrinker touches, or ``None`` when the entry
        is not a function tool (a hosted tool, say) and must pass through.
    """
    if not isinstance(entry, dict):
        return None
    nested = isinstance(entry.get("function"), dict)
    holder = entry["function"] if nested else entry
    if not isinstance(holder, dict) or not isinstance(holder.get("name"), str):
        return None
    schema_key = "parameters" if nested else ("input_schema" if holder.get("input_schema") else "parameters")
    return {
        "name": holder["name"],
        "description": holder.get("description"),
        "schema": holder.get(schema_key),
        "schemaKey": schema_key,
        "nested": nested,
    }


def patch_entry(entry: Dict[str, Any], description: Any = OMIT, schema: Any = OMIT) -> Dict[str, Any]:
    """Return a copy of ``entry`` with a new description and/or schema.

    Hermes memoizes tool definitions and hands the same dicts to every request,
    so nothing here writes to a container it was given: each level that changes
    is copied, the rest is shared.

    :param description: the new description, ``None`` to remove the field,
        :data:`OMIT` to leave it alone.
    :param schema: the new schema, or :data:`OMIT` to leave it alone.
    """
    info = read_tool(entry)
    if info is None:
        return entry
    nested = info["nested"]
    schema_key = info["schemaKey"]

    def patch(target: Dict[str, Any]) -> Dict[str, Any]:
        # Rebuild key by key rather than assigning: a dict assignment on a key
        # that exists keeps its position, but deleting and re-adding would move
        # `description` to the end of the object, and the byte-for-byte contract
        # with the JavaScript says the shrunk entry differs from the original
        # only in the text of its prose.
        out: Dict[str, Any] = {}
        for key, value in target.items():
            if key == "description" and description is not OMIT:
                if description is not None:
                    out[key] = description
                continue
            if key == schema_key and schema is not OMIT:
                out[key] = schema
                continue
            out[key] = value
        if description is not OMIT and description is not None and "description" not in out:
            out["description"] = description
        if schema is not OMIT and schema_key not in out:
            out[schema_key] = schema
        return out

    if not nested:
        return patch(entry)
    return dict(entry, function=patch(entry["function"]))


def heading_blocks(text: Any) -> Dict[str, Any]:
    """Split system text into ``{lead, blocks}`` heading blocks.

    A block runs from its heading line to the line before the next heading line
    at any level; level-aware nesting would make one config key mean different
    things in two harnesses that structure their prompts differently. Text before
    the first heading is ``lead``: it has no name to match, so no config key can
    reach it and it is always kept.
    """
    lines = ("" if text is None else str(text)).split("\n")
    lead: List[str] = []
    blocks: List[Dict[str, Any]] = []
    current: Optional[Dict[str, Any]] = None
    for line in lines:
        heading = _HEADING.match(line)
        if heading:
            current = {"heading": heading.group(2).strip(), "level": len(heading.group(1)), "lines": [line]}
            blocks.append(current)
            continue
        if current is None:
            lead.append(line)
        else:
            current["lines"].append(line)
    return {
        "lead": "\n".join(lead),
        "blocks": [
            {"heading": block["heading"], "level": block["level"], "text": "\n".join(block["lines"])}
            for block in blocks
        ],
    }


def apply_system_sections(text: str, sections: Optional[Dict[str, str]]) -> Dict[str, Any]:
    """Replace or remove heading blocks matched by ``*``-glob against the heading.

    :param sections: glob -> replacement; ``""`` removes the block. A block
        matched by two globs takes the first matching key in insertion order.
    :returns: ``{text, replaced, missing}``, where ``missing`` names keys that
        matched nothing — a config naming a section this harness does not send
        has to show up in the report rather than silently inject a paragraph
        under a heading nobody owns.
    """
    keys = list((sections or {}).keys())
    if len(keys) == 0:
        return {"text": text, "replaced": [], "missing": []}
    parsed = heading_blocks(text)
    replaced: List[str] = []
    matched = set()
    out: List[str] = []
    for block in parsed["blocks"]:
        hit = None
        for key in keys:
            if not glob_match([key], block["heading"]):
                continue
            matched.add(key)
            if key not in replaced:
                replaced.append(key)
            hit = sections[key]
            break
        out.append(block["text"] if hit is None else hit)
    kept = [block for block in out if block != ""]
    parts = ([parsed["lead"]] if parsed["lead"] != "" else []) + kept
    return {
        "text": "\n".join([part for part in parts if part != ""]),
        "replaced": replaced,
        "missing": [key for key in keys if key not in matched],
    }


def _system_of(payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """The system text of a payload, plus the address it lives at.

    Anthropic keeps it in ``system`` (a string, or text blocks that carry the
    cache breakpoints), OpenAI Responses keeps it in ``instructions`` beside the
    payload, and OpenAI chat keeps it as a ``role: system`` message whose content
    is a string or a list of parts.
    """
    if isinstance(payload.get("system"), str):
        return {"text": payload["system"], "kind": "string"}
    if isinstance(payload.get("system"), list):
        for block in payload["system"]:
            if isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str):
                return {"text": block["text"], "kind": "blocks"}
        return None
    if isinstance(payload.get("instructions"), str):
        return {"text": payload["instructions"], "kind": "instructions"}
    messages = payload.get("messages")
    head = messages[0] if isinstance(messages, list) and len(messages) > 0 else None
    if not isinstance(head, dict) or head.get("role") != "system":
        return None
    if isinstance(head.get("content"), str):
        return {"text": head["content"], "kind": "message-string"}
    content = head.get("content")
    if isinstance(content, list):
        for part in content:
            if isinstance(part, dict) and part.get("type") == "text" and isinstance(part.get("text"), str):
                return {"text": part["text"], "kind": "message-parts"}
    return None


def _write_system(payload: Dict[str, Any], address: Dict[str, Any], text: str) -> Dict[str, Any]:
    """Write back to exactly the address ``_system_of`` read from.

    Only the one container that holds the text is rebuilt, and a block keeps
    whatever else it carried — including Anthropic's ``cache_control`` markers,
    which is how a shrink can be applied to a cached prompt without paying for
    the cache write again.
    """
    kind = address["kind"]
    if kind == "string":
        return dict(payload, system=text)
    if kind == "instructions":
        return dict(payload, instructions=text)
    if kind == "blocks":
        done = False

        def rewrite_block(block: Any) -> Any:
            nonlocal done
            if done or not isinstance(block, dict) or block.get("type") != "text" or not isinstance(block.get("text"), str):
                return block
            done = True
            return dict(block, text=text)

        return dict(payload, system=[rewrite_block(block) for block in payload["system"]])
    head, rest = payload["messages"][0], payload["messages"][1:]
    if kind == "message-string":
        return dict(payload, messages=[dict(head, content=text), *rest])
    done = False

    def rewrite_part(part: Any) -> Any:
        nonlocal done
        if done or not isinstance(part, dict) or part.get("type") != "text" or not isinstance(part.get("text"), str):
            return part
        done = True
        return dict(part, text=text)

    return dict(payload, messages=[dict(head, content=[rewrite_part(p) for p in head["content"]]), *rest])


def shrink_wire_payload(payload: Any, config: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Shrink one provider request payload, whatever harness built it.

    Config is the subset of the dsh plugin's keys that means something on a raw
    payload — ``include``, ``exclude``, ``drop``, ``minChars``,
    ``descriptionCap``, ``nestedDescriptionCap`` — plus ``systemSections`` where
    dsh has ``sectionText`` (a payload has no section registry, only text) and
    ``systemCap`` as a blunt tail cut. ``drop`` is the one key that changes
    behaviour rather than prose: the tool leaves the request, and the harness can
    still dispatch a call to it, which is why the report names every removal.

    :param payload: a provider request body; never mutated.
    :param config: the knobs above, all optional.
    :returns: ``{payload, shape, report}`` with character counts before and after
        so a caller can log what the shrink cost the model.
    """
    config = config or {}
    include = config.get("include") or ["*"]
    exclude = config.get("exclude") or []
    drop = config.get("drop") or []
    min_chars = config.get("minChars", 0)
    description_cap = config.get("descriptionCap", 200)
    nested_cap = config.get("nestedDescriptionCap", 100)
    system_sections = config.get("systemSections") or {}
    system_cap = config.get("systemCap", 0)

    shape = detect_shape(payload)
    report: Dict[str, Any] = {
        "shape": shape,
        "toolsBefore": 0, "toolsAfter": 0, "dropped": [], "shrunk": [],
        "systemBefore": 0, "systemAfter": 0, "systemReplaced": [], "systemMissing": [],
    }
    if not isinstance(payload, dict):
        return {"payload": payload, "shape": shape, "report": report}

    next_payload = payload

    if isinstance(payload.get("tools"), list):
        report["toolsBefore"] = sum(json_chars(entry) for entry in payload["tools"])
        tools: List[Any] = []
        for entry in payload["tools"]:
            tool = read_tool(entry)
            if tool is None:
                tools.append(entry)
                continue
            # A hosted tool (`{"type":"web_search_20250305","name":"web_search"}`)
            # has a name and neither prose nor schema of its own: there is nothing
            # here to cap, and writing an empty description onto it would add a
            # key the provider never asked for and report a shrink that never
            # happened.
            if tool["description"] is None and tool["schema"] is None:
                tools.append(entry)
                continue
            if glob_match(drop, tool["name"]):
                report["dropped"].append(tool["name"])
                continue
            if (
                glob_match(exclude, tool["name"])
                or not glob_match(include, tool["name"])
                or json_chars(entry) < min_chars
            ):
                tools.append(entry)
                continue
            shrunk = shrink_tool_schema(
                {"name": tool["name"], "description": tool["description"] or "", "parameters": tool["schema"] or {}},
                description_cap,
                nested_cap,
            )
            patched = patch_entry(
                entry,
                description=shrunk["description"] if "description" in shrunk else None,
                schema=shrunk["parameters"],
            )
            # Already-short prose comes back identical; only report real moves.
            if json_chars(patched) != json_chars(entry):
                report["shrunk"].append(tool["name"])
            tools.append(patched)
        report["toolsAfter"] = sum(json_chars(entry) for entry in tools)
        next_payload = dict(next_payload, tools=tools)

    system = _system_of(next_payload)
    if system is not None:
        report["systemBefore"] = len(system["text"])
        applied = apply_system_sections(system["text"], system_sections)
        report["systemReplaced"] = applied["replaced"]
        report["systemMissing"] = applied["missing"]
        text = applied["text"]
        if system_cap > 0 and len(text) > system_cap:
            text = text[:system_cap].rstrip() + "\n…[toolscode: system prompt truncated]"
        report["systemAfter"] = len(text)
        if text != system["text"]:
            next_payload = _write_system(next_payload, system, text)

    return {"payload": next_payload, "shape": shape, "report": report}


def load_config(path: Optional[str] = None, env: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    """Read config from ``~/.hermes/toolscode.json`` and the environment.

    Hermes gives a plugin no config accessor — ``plugin.yaml`` declares
    ``requires_env`` and the plugin reads what it needs — so JSON it is, and
    environment variables win over the file because the person debugging a
    surprising prompt should be able to override a file without editing it.
    ``TOOLSCODE_DROP`` is comma-separated. There is no ``TOOLSCODE_WIRE`` here:
    that knob turns the raw payload rewrite on for pi, where it is a fallback
    behind better hooks, and on Hermes rewriting the payload is the only lever
    there is, so it is always on.
    """
    environ = os.environ if env is None else env
    if path is None:
        path = os.path.join(os.path.expanduser("~"), ".hermes", "toolscode.json")
    config = dict(DEFAULTS)
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as handle:
            config.update(json.load(handle))
    if environ.get("TOOLSCODE_ENABLED") == "0":
        config["enabled"] = False
    if environ.get("TOOLSCODE_DROP"):
        config["drop"] = [item.strip() for item in environ["TOOLSCODE_DROP"].split(",") if item.strip()]
    if environ.get("TOOLSCODE_DESCRIPTION_CAP"):
        config["descriptionCap"] = int(environ["TOOLSCODE_DESCRIPTION_CAP"])
    return config
