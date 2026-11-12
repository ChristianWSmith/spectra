import assert from "node:assert/strict"
import { test } from "node:test"

import { coerceSubagentInput } from "./coerce.ts"

test("subagent input without background gains background: true (other fields kept)", () => {
  const result = coerceSubagentInput("subagent", { prompt: "do it", agent: "explore" })
  assert.deepStrictEqual(result, { prompt: "do it", agent: "explore", background: true })
})

test("subagent input with background: false is coerced to true", () => {
  const result = coerceSubagentInput("subagent", { prompt: "do it", background: false })
  assert.deepStrictEqual(result, { prompt: "do it", background: true })
})

test("subagent input with a non-boolean background is coerced to boolean true", () => {
  assert.deepStrictEqual(coerceSubagentInput("subagent", { prompt: "x", background: "true" }), {
    prompt: "x",
    background: true,
  })
  assert.deepStrictEqual(coerceSubagentInput("subagent", { prompt: "x", background: 1 }), {
    prompt: "x",
    background: true,
  })
})

test("subagent input already background: true is unchanged (same reference)", () => {
  const input = { prompt: "do it", background: true }
  const result = coerceSubagentInput("subagent", input)
  assert.strictEqual(result, input)
  assert.deepStrictEqual(result, { prompt: "do it", background: true })
})

test("non-subagent tools are untouched (same reference, background never forced)", () => {
  const readInput = { file: "/tmp/x" }
  assert.strictEqual(coerceSubagentInput("read", readInput), readInput)
  assert.strictEqual(coerceSubagentInput("bash", readInput), readInput)
  assert.strictEqual(coerceSubagentInput("execute", readInput), readInput)
  // exact-name match only: a differently named tool never coerces
  const fg = { background: false }
  assert.strictEqual(coerceSubagentInput("subagentish", fg), fg)
  assert.strictEqual(coerceSubagentInput("Subagent", fg), fg)
  // non-subagent tools keep even a missing/undefined input as-is
  assert.strictEqual(coerceSubagentInput("read", undefined), undefined)
})

test("missing or empty subagent input does not crash and still yields background: true", () => {
  assert.deepStrictEqual(coerceSubagentInput("subagent", undefined), { background: true })
  assert.deepStrictEqual(coerceSubagentInput("subagent", null), { background: true })
  assert.deepStrictEqual(coerceSubagentInput("subagent", {}), { background: true })
  assert.deepStrictEqual(coerceSubagentInput("subagent", ""), { background: true })
  assert.deepStrictEqual(coerceSubagentInput("subagent", 42), { background: true })
  // arrays/primitives carry no schema fields to preserve
  assert.deepStrictEqual(coerceSubagentInput("subagent", ["x"]), { background: true })
})
