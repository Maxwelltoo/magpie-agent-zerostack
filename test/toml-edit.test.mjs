import { describe, expect, test } from "bun:test"
import {
  deleteTable,
  deleteTableKey,
  getTable,
  getTopKey,
  restoreTable,
  restoreTopKey,
  setTable,
  setTableKey,
  setTopKey,
  tomlString,
  validateToml,
} from "../lib/toml-edit.mjs"

describe("toml-edit", () => {
  test("preserves leading comments of the next table when replacing or deleting a table", () => {
    const src = [
      'provider = "openrouter"',
      'model = "deepseek-v4-pro"',
      "",
      "[custom_providers.magpie]",
      'provider_type = "openai"',
      'base_url = "http://127.0.0.1:4141/v1"',
      "",
      "# Managed permissions block — DO NOT DELETE",
      "[permissions]",
      'mode = "standard"',
      "",
    ].join("\n")

    const deleted = deleteTable(src, "custom_providers.magpie")
    expect(deleted).toContain("# Managed permissions block — DO NOT DELETE\n[permissions]")
    expect(deleted).not.toContain("custom_providers.magpie")
    const parsed = validateToml(deleted)
    expect(parsed.permissions.mode).toBe("standard")
  })

  test("does not mistake [header] inside a multiline string for a table header", () => {
    const src = [
      'provider = "openrouter"',
      'system_prompt = """',
      "[custom_providers.magpie]",
      'not_a_table = "true"',
      '"""',
      "",
      "[api_keys]",
      'openrouter = "sk-or-test"',
      "",
    ].join("\n")

    expect(getTable(src, "custom_providers.magpie").found).toBe(false)
    let next = setTopKey(src, "provider", tomlString("magpie"))
    next = setTable(next, "custom_providers.magpie", [
      'provider_type = "openai"',
      'base_url = "http://127.0.0.1:4141/v1"',
    ])
    next = setTableKey(next, "api_keys", "magpie", tomlString("mp-key-123"))

    const parsed = validateToml(next)
    expect(parsed.provider).toBe("magpie")
    expect(parsed.system_prompt).toContain("[custom_providers.magpie]")
    expect(parsed.custom_providers.magpie.base_url).toBe("http://127.0.0.1:4141/v1")
    expect(parsed.api_keys.openrouter).toBe("sk-or-test")
    expect(parsed.api_keys.magpie).toBe("mp-key-123")
  })

  test("restores exact top-level key and drops empty api_keys table when created", () => {
    const src = [
      "# User comment",
      'provider = "anthropic" # inline comment',
      "",
      "[permissions]",
      'mode = "strict"',
      "",
    ].join("\n")

    const origProvider = getTopKey(src, "provider")
    let next = setTopKey(src, "provider", tomlString("magpie"))
    next = setTableKey(next, "api_keys", "magpie", tomlString("mp-secret"))
    expect(validateToml(next).api_keys.magpie).toBe("mp-secret")

    next = restoreTopKey(next, "provider", origProvider.raw)
    next = deleteTableKey(next, "api_keys", "magpie", { dropEmptyTable: true })
    expect(next).toBe(src)
  })

  test("preserves existing api_keys table when other keys exist", () => {
    const src = ['[api_keys]', 'openai = "sk-user"', ""].join("\n")
    let next = setTableKey(src, "api_keys", "magpie", tomlString("mp-1"))
    next = deleteTableKey(next, "api_keys", "magpie", { dropEmptyTable: true })
    expect(next).toBe(src)
  })

  test("round-trips existing custom_providers.magpie via restoreTable", () => {
    const src = [
      "[custom_providers.magpie]",
      'provider_type = "openai"',
      'base_url = "https://example.com/v1"',
      "",
    ].join("\n")
    const orig = getTable(src, "custom_providers.magpie")
    const updated = setTable(src, "custom_providers.magpie", [
      'provider_type = "openai"',
      'base_url = "http://127.0.0.1:4141/v1"',
    ])
    const restored = restoreTable(updated, "custom_providers.magpie", orig.raw)
    expect(restored).toBe(src)
  })
})
