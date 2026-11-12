# enforce-background

OpenCode **server plugin** (V2 API): coerces every `subagent` tool call to
`background: true`, making foreground subagent launches mechanically
impossible. Guardrail behind the prompt-level rule in
`.opencode/agents/lead-developer.md` (defense-in-depth, not enforcement).

- Hook: `ctx.tool.hook("execute.before", ...)` — when `event.tool === "subagent"`
  and `event.input.background !== true`, `event.input` is replaced with the same
  input carrying `background: true`. Silent, never throws, all other tools
  untouched, global across all agents.
- Loading: no `package.json` on purpose — OpenCode's documented fallback loads
  the directory's root `index.ts`, and the bare `@opencode/plugin` import is
  resolved from the **host** (no `node_modules` needed at runtime; OpenCode
  refuses any other bare dependency: *"plugins must use the host's effect and
  '@opencode/plugin' modules"*).

## Dev (node_modules is gitignored)

`npm install --no-save` with no `package.json` prunes packages not named in the
command — always install everything in ONE shot:

```sh
npm install --no-save @opencode/plugin@2.2.7 typescript @types/node @types/json-schema
npx tsc --noEmit          # strict, no skipLibCheck
node --test coerce.test.ts
```

## Verify loading

```sh
grep 'loading plugin.*enforce-background' ~/.local/share/opencode/log/opencode.log
```

Expected INFO line: `msg="loading plugin" id=<repo>/.opencode/plugins/enforce-background entrypoint=file://<repo>/.opencode/plugins/enforce-background/index.ts`,
plus stdout `[enforce-background] loaded: coercing subagent calls to background: true`.
The entry file and `coerce.ts` are both watcher-subscribed, so saves reload
automatically (nudge with `opencode reload` or a `touch index.ts`).
