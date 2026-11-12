/**
 * Pure coercion core of the `enforce-background` plugin — no OpenCode imports,
 * unit-tested by `coerce.test.ts` (`node --test`).
 *
 * Returns the input the `subagent` tool must execute with:
 *
 * - any tool other than `subagent` → the input untouched (same reference);
 * - `subagent` with `background === true` → the input untouched (same reference);
 * - `subagent` otherwise (missing, false, or any non-`true` value) → `true`
 *   merged over the input's own fields. Non-object input (undefined, null,
 *   primitives, arrays) has no fields to preserve and becomes
 *   `{ background: true }`.
 *
 * Never throws — coercion is silent by design.
 */
export function coerceSubagentInput(tool: string, input: unknown): unknown {
  if (tool !== "subagent") return input
  const record: Record<string, unknown> =
    input !== null && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {}
  if (record.background === true) return input
  return { ...record, background: true }
}
