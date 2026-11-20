# CLAUDE.md

Project instructions for Claude Code in this repo. The full project guide is
`AGENTS.md`; this file holds the rules that must hold in every session.

## Subagents run on Haiku only

Every Agent call specifies `model: "haiku"`. Do not use Opus or Sonnet for
subagents, and do not omit the model, since an omitted model inherits the
parent's. Reason: the 2026-11-20 session exhausted the account's 5-hour limit
with Opus and Sonnet workers. A PreToolUse hook (`.claude/hooks/require-haiku-agent.py`,
wired in `.claude/settings.json`) refuses any other model, so a violation fails
at the call rather than running.
