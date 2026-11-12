// Server plugin: every `subagent` call is COERCED to `background: true`, so
// foreground subagent launches are mechanically impossible.
//
// Rationale (owner's ruling): the prompt rule in
// `.opencode/agents/lead-developer.md` ("Every `subagent` call MUST pass
// `background: true`") is defense-in-depth, not enforcement — a model can
// still omit `background`, block its turn, and stall the workflow. This
// plugin is the guardrail. Coercion (not rejection) was chosen deliberately:
// foreground stops existing for every call, so the model cannot even make
// the mistake. Applies globally to all agents — background is always the
// desired mode. Every other tool is untouched.
//
// Replace semantics: `execute.before` receives an event whose `input: unknown`
// is a mutable field of an owned draft; OpenCode reads `event.input` back
// AFTER all hooks run and executes the tool with it (both the direct path and
// Code Mode's `execute`), so plain assignment replaces the input.

import { Plugin } from "@opencode/plugin"

import { coerceSubagentInput } from "./coerce.ts"

export default Plugin.define({
  id: "enforce-background",
  async setup(ctx) {
    await ctx.tool.hook("execute.before", (event) => {
      event.input = coerceSubagentInput(event.tool, event.input)
    })
    console.log("[enforce-background] loaded: coercing subagent calls to background: true")
  },
})
