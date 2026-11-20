#!/usr/bin/env python3
"""PreToolUse guard for the Agent tool: subagents must run on Haiku.

An omitted model is refused too, because a subagent with no model inherits
the parent's model. Exit 2 blocks the call and returns stderr to the model.
"""
import json
import sys

ALLOWED = "haiku"

try:
    event = json.load(sys.stdin)
except json.JSONDecodeError:
    sys.exit(0)  # not a tool-call payload we can judge; do not guess

if event.get("tool_name") != "Agent":
    sys.exit(0)

model = (event.get("tool_input") or {}).get("model")
if isinstance(model, str) and model.strip().lower() == ALLOWED:
    sys.exit(0)

shown = model if model else "(none, which inherits the parent model)"
sys.stderr.write(
    "Blocked: subagents must use model \"haiku\" (project rule, 2026-11-20). "
    f"This call specified {shown}. Re-issue the Agent call with model: \"haiku\".\n"
)
sys.exit(2)
