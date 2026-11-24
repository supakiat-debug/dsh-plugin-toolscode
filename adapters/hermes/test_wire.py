"""Cross-language contract test for the Hermes port of the wire shrink.

Run it from anywhere: ``python adapters/hermes/test_wire.py``.

The fixture is the one ``test/wire.test.mjs`` runs against, and the assertions
below are the same ones, down to the pinned truncated strings. That is the whole
point of the file: the JavaScript shrink and the Python shrink are separate
programs in separate languages that must produce byte-identical requests, and a
shared fixture with pinned output is the only cheap way to know that a change on
one side did not quietly move the other.

Standard library only, on purpose: Hermes refuses to install on Python 3.14 and
this test still has to run here.
"""

from __future__ import annotations

import copy
import json
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
sys.path.insert(0, str(HERE))

import toolscode  # noqa: E402  (path set above)
from toolscode import BRIDGE_TOOLS, shrink_request  # noqa: E402
from toolscode import toolscode_core as core  # noqa: E402

with open(REPO / "test" / "fixtures" / "wire-payloads.json", "r", encoding="utf-8") as handle:
    FIXTURE = json.load(handle)

CONFIG = dict(FIXTURE["caps"])
CONFIG.update({"exclude": ["secret_*"], "systemSections": {"Personality": ""}})
EXPECT = FIXTURE["expect"]


def run(name: str, config=None):
    """Shrink one fixture payload, returning ``(result, untouched_input)``."""
    payload = copy.deepcopy(FIXTURE["payloads"][name])
    original = copy.deepcopy(payload)
    return core.shrink_wire_payload(payload, dict(CONFIG if config is None else config)), payload, original


class PinnedContract(unittest.TestCase):
    """The assertions the JavaScript makes with the same numbers: exact strings."""

    def test_shapes(self):
        for name, shape in EXPECT["shapes"].items():
            self.assertEqual(core.detect_shape(FIXTURE["payloads"][name]), shape, name)

    def test_pinned_strings(self):
        result, _, _ = run("openai-chat")
        tools = result["payload"]["tools"]
        self.assertEqual(tools[0]["function"]["description"], EXPECT["findFilesDescription"])
        self.assertEqual(
            tools[0]["function"]["parameters"]["properties"]["root"]["description"],
            EXPECT["rootDescription"],
        )
        self.assertEqual(len(tools[2]["function"]["description"]), EXPECT["secretDescriptionLength"])
        self.assertEqual(len(FIXTURE["longDescription"]), EXPECT["longDescriptionLength"])

    def test_shrunk_lists_and_tool_counts(self):
        for name in FIXTURE["payloads"]:
            result, _, _ = run(name)
            self.assertEqual(result["report"]["shrunk"], EXPECT["shrunk"][name], name)
            self.assertEqual(len(result["payload"]["tools"]), EXPECT["toolCount"][name], name)

    def test_dropped_tools_are_named_in_request_order(self):
        result, _, _ = run("openai-chat", dict(CONFIG, drop=["secret_*", "read"]))
        self.assertEqual([tool["function"]["name"] for tool in result["payload"]["tools"]], ["find_files"])
        self.assertEqual(result["report"]["dropped"], ["read", "secret_tool"])


class Shapes(unittest.TestCase):
    def test_openai_chat_system_message_keeps_lead_and_other_sections(self):
        result, _, _ = run("openai-chat")
        content = result["payload"]["messages"][0]["content"]
        self.assertTrue(content.startswith("Lead line about the agent."))
        self.assertNotIn("## Personality", content)
        self.assertIn("## Tools", content)
        self.assertIn("## Environment", content)

    def test_anthropic_rewrites_only_the_first_block(self):
        result, _, _ = run("anthropic")
        system = result["payload"]["system"]
        self.assertNotIn("Personality", system[0]["text"])
        self.assertEqual(system[1]["text"], "Second block, must stay untouched.")

    def test_anthropic_cache_control_survives_the_rewrite(self):
        # The middleware runs after Hermes decorates the prompt with cache
        # breakpoints; if the rewrite dropped them the shrink would cost more in
        # cache writes than it saves in prose, which is the whole trade.
        payload = {"system": [{"type": "text", "text": "Lead.\n\n## Personality\n\nLong persona prose that goes on."},
                              {"type": "text", "text": "Second block, must stay untouched."}]}
        payload["system"][0]["cache_control"] = {"type": "ephemeral"}
        result = core.shrink_wire_payload(payload, {"systemSections": {"Personality": ""}})
        self.assertEqual(result["payload"]["system"][0]["cache_control"], {"type": "ephemeral"})
        self.assertEqual(result["payload"]["system"][0]["text"], "Lead.\n")
        self.assertEqual(result["payload"]["system"][1]["text"], "Second block, must stay untouched.")

    def test_openai_responses_instructions(self):
        result, _, _ = run("openai-responses")
        instructions = result["payload"]["instructions"]
        self.assertNotIn("## Personality", instructions)
        self.assertIn("## Tools", instructions)
        self.assertEqual(
            result["payload"]["tools"][0]["description"], EXPECT["findFilesDescription"]
        )

    def test_hermes_kwargs_leaves_the_transcript_alone(self):
        result, _, _ = run("hermes-kwargs")
        self.assertEqual(result["payload"]["messages"][1]["content"], "hello")
        self.assertNotEqual(result["payload"]["messages"][0]["content"],
                            FIXTURE["payloads"]["hermes-kwargs"]["messages"][0]["content"])


class Guarantees(unittest.TestCase):
    def test_input_is_never_mutated(self):
        # Hermes hands this middleware a copy, but model_tools memoizes tool
        # definitions and shares them across requests; a shrink that wrote
        # through would corrupt the cache for every later turn.
        for name in FIXTURE["payloads"]:
            result, payload, original = run(name)
            self.assertEqual(payload, original, name)
            self.assertIsNot(result["payload"], payload)

    def test_byte_stable(self):
        for name in FIXTURE["payloads"]:
            one, _, _ = run(name)
            two, _, _ = run(name)
            self.assertEqual(
                json.dumps(one["payload"], sort_keys=True),
                json.dumps(two["payload"], sort_keys=True),
                name,
            )

    def test_unmatched_section_key_is_reported_and_never_invented(self):
        result, _, _ = run("openai-chat", dict(CONFIG, systemSections={"Nope": "Injected."}))
        self.assertEqual(result["report"]["systemMissing"], ["Nope"])
        self.assertNotIn("Injected.", result["payload"]["messages"][0]["content"])

    def test_system_cap_cuts_with_a_visible_marker(self):
        result, _, _ = run("openai-chat", dict(CONFIG, systemCap=40))
        content = result["payload"]["messages"][0]["content"]
        self.assertTrue(content.endswith("[toolscode: system prompt truncated]"))
        self.assertLess(len(content), 120)

    def test_non_object_payload_passes_through(self):
        for value in (None, "text", 7):
            result = core.shrink_wire_payload(value, CONFIG)
            self.assertIs(result["payload"], value)

    def test_hosted_tool_entries_pass_through(self):
        # Anthropic names its server tools, so `read_tool` sees a name; the
        # shrinker has to notice there is no prose and no schema to cap rather
        # than writing an empty description onto a tool the provider owns.
        entry = {"type": "web_search_20250305", "name": "web_search", "max_uses": 3}
        payload = {"tools": [entry], "system": "hi"}
        result = core.shrink_wire_payload(payload, {"descriptionCap": 1})
        self.assertEqual(result["payload"]["tools"], [entry])
        self.assertNotIn("description", result["payload"]["tools"][0])
        self.assertEqual(result["report"]["shrunk"], [])
        self.assertEqual(result["report"]["toolsAfter"], result["report"]["toolsBefore"])


class Primitives(unittest.TestCase):
    def test_truncate_text(self):
        self.assertEqual(core.truncate_text("hello", 0), "")
        self.assertEqual(core.truncate_text("hello", 10), "hello")
        self.assertEqual(core.truncate_text("alpha beta gamma", 11), "alpha beta…")
        self.assertEqual(core.truncate_text("alpha beta gamma", 7), "alpha…")
        # A break point before half the cap loses more than a hard cut would.
        self.assertEqual(core.truncate_text("a " + "b" * 40, 30), "a " + "b" * 28 + "…")
        self.assertEqual(core.truncate_text(42, 5), 42)

    def test_glob_match(self):
        self.assertTrue(core.glob_match(["*"], "anything"))
        self.assertTrue(core.glob_match(["secret_*"], "secret_tool"))
        self.assertFalse(core.glob_match(["secret"], "secret_tool"))
        self.assertFalse(core.glob_match([], "anything"))
        self.assertFalse(core.glob_match(None, "anything"))
        self.assertTrue(core.glob_match(["mcp_*_search"], "mcp_github_search"))

    def test_heading_blocks(self):
        parsed = core.heading_blocks("lead one\nlead two\n# A\n\nbody a\n\n### B\ndeep\n")
        self.assertEqual(parsed["lead"], "lead one\nlead two")
        self.assertEqual([(b["heading"], b["level"]) for b in parsed["blocks"]], [("A", 1), ("B", 3)])
        self.assertIn("body a", parsed["blocks"][0]["text"])

    def test_apply_system_sections_with_no_keys_is_the_identity(self):
        text = FIXTURE["payloads"]["anthropic"]["system"][0]["text"]
        applied = core.apply_system_sections(text, {})
        self.assertEqual(applied["text"], text)
        self.assertEqual(applied["replaced"], [])
        self.assertEqual(applied["missing"], [])

    def test_patch_entry_keeps_key_order_and_siblings(self):
        entry = {"type": "function", "function": {"name": "x", "description": "long " * 40, "parameters": {}}}
        patched = core.patch_entry(entry, description="short", schema={"type": "object"})
        self.assertEqual(list(patched["function"].keys()), ["name", "description", "parameters"])
        self.assertEqual(patched["type"], "function")
        self.assertEqual(entry["function"]["description"], "long " * 40)
        removed = core.patch_entry(entry, description=None)
        self.assertNotIn("description", removed["function"])
        self.assertEqual(list(removed["function"].keys()), ["name", "parameters"])


class HermesAdapter(unittest.TestCase):
    """The middleware contract, without importing Hermes."""

    class Ctx:
        def __init__(self):
            self.middleware = {}

        def register_middleware(self, kind, callback):
            self.middleware.setdefault(kind, []).append(callback)

    def config(self, **over):
        config = dict(CONFIG)
        config["enabled"] = True
        config.update(over)
        return config

    def test_register_mounts_llm_request(self):
        # register() reads the config file, which no test should depend on, so it
        # is pinned here. What matters is that the one lever it uses is
        # llm_request, because that is the only Hermes hook whose return value
        # replaces the request the provider gets.
        original = toolscode.load_config
        toolscode.load_config = lambda *args, **kwargs: self.config()
        ctx = self.Ctx()
        try:
            toolscode.register(ctx)
        finally:
            toolscode.load_config = original
        self.assertEqual(list(ctx.middleware), ["llm_request"])
        self.assertEqual(len(ctx.middleware["llm_request"]), 1)

    def test_register_does_nothing_when_disabled(self):
        original = toolscode.load_config
        toolscode.load_config = lambda *args, **kwargs: self.config(enabled=False)
        ctx = self.Ctx()
        try:
            toolscode.register(ctx)
        finally:
            toolscode.load_config = original
        self.assertEqual(ctx.middleware, {})

    def test_changed_request_comes_back_tagged_for_the_trace(self):
        from toolscode import _STATE

        _STATE["config"] = self.config()
        payload = copy.deepcopy(FIXTURE["payloads"]["hermes-kwargs"])
        out = shrink_request(request=payload, original_request=copy.deepcopy(payload))
        self.assertIsNotNone(out)
        self.assertIn("request", out)
        self.assertEqual(out["source"], "toolscode")
        self.assertIn("chars", out["reason"])
        self.assertEqual(out["request"]["tools"][0]["function"]["description"], EXPECT["findFilesDescription"])

    def test_unchanged_request_returns_none(self):
        from toolscode import _STATE

        _STATE["config"] = self.config(descriptionCap=10_000, nestedDescriptionCap=10_000, systemSections={})
        payload = copy.deepcopy(FIXTURE["payloads"]["hermes-kwargs"])
        self.assertIsNone(shrink_request(request=payload))

    def test_bridge_tools_are_left_out_by_default(self):
        # tool_call's description is the deferred catalog itself; a cap there
        # would not save prose, it would truncate the list of tools to reach.
        from toolscode import _STATE

        _STATE["config"] = self.config(exclude=list(BRIDGE_TOOLS) + ["secret_*"], systemSections={})
        payload = {
            "model": "hermes-4",
            "messages": [{"role": "user", "content": "hi"}],
            "tools": [
                {"type": "function", "function": {"name": "tool_call", "description": FIXTURE["longDescription"],
                                                  "parameters": {"type": "object"}}},
                {"type": "function", "function": {"name": "read_file", "description": FIXTURE["longDescription"],
                                                  "parameters": {"type": "object"}}},
            ],
        }
        out = shrink_request(request=payload)
        tools = out["request"]["tools"]
        self.assertEqual(tools[0]["function"]["description"], FIXTURE["longDescription"])
        self.assertTrue(tools[1]["function"]["description"].endswith("…"))

    def test_a_request_with_nothing_to_shrink_is_handed_back_untouched(self):
        from toolscode import _STATE

        _STATE["config"] = self.config()
        self.assertIsNone(shrink_request(request={"model": "x"}))
        self.assertIsNone(shrink_request(request=None))


if __name__ == "__main__":
    unittest.main(verbosity=2)
