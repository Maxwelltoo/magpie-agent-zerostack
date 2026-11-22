import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { syncOnce } from "../index.mjs"
import { agent, connect } from "../zerostack.agent.js"

const tempDirs = []
function makeTempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-zs-test-"))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true })
  }
})

function writeHandoff(home, obj) {
  const dir = path.join(home, ".magpie")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "zerostack-agent.json"), JSON.stringify(obj, null, 2))
}

describe("zerostack.agent.js descriptor", () => {
  test("exports valid agent descriptor and connect()", () => {
    expect(agent.id).toBe("zerostack")
    expect(agent.bin).toBe("zerostack")
    expect(agent.format).toBe("json")
    expect(agent.model).toBe("model")
    const out = connect({
      gateway: { url: "http://127.0.0.1:4141", v1: "http://127.0.0.1:4141/v1", key: "mp-k" },
    })
    expect(out).toEqual({
      "gateway.url": "http://127.0.0.1:4141",
      "gateway.v1": "http://127.0.0.1:4141/v1",
      "gateway.key": "mp-k",
    })
  })
})

describe("syncOnce end-to-end", () => {
  test("TOML: connect, switch model, recover from drift, and restore byte-for-byte", () => {
    const home = makeTempHome()
    const zsDir = path.join(home, ".config", "zerostack")
    fs.mkdirSync(zsDir, { recursive: true })
    const cfgPath = path.join(zsDir, "config.toml")
    const original = [
      "# My ZeroStack config",
      'provider = "openrouter"',
      'model = "deepseek-v4-pro"',
      "max_tokens = 16384",
      "",
      "# Custom local ollama",
      "[custom_providers.local]",
      'provider_type = "openai"',
      'base_url = "http://127.0.0.1:11434/v1"',
      "",
      "[api_keys]",
      'openrouter = "sk-or-user"',
      "",
    ].join("\n")
    fs.writeFileSync(cfgPath, original)

    const opts = { env: { ZS_CONFIG_DIR: zsDir }, platform: "linux", home }

    // 1. Connect to deepseek/pro
    writeHandoff(home, {
      model: "deepseek/pro",
      gateway: { url: "http://127.0.0.1:4141", v1: "http://127.0.0.1:4141/v1", key: "mp-test-key" },
    })
    const r1 = syncOnce(opts)
    expect(r1.action).toBe("synced")
    let parsed = Bun.TOML.parse(fs.readFileSync(cfgPath, "utf8"))
    expect(parsed.provider).toBe("magpie")
    expect(parsed.model).toBe("deepseek/pro")
    expect(parsed.max_tokens).toBe(16384)
    expect(parsed.custom_providers.local.base_url).toBe("http://127.0.0.1:11434/v1")
    expect(parsed.custom_providers.magpie).toEqual({
      provider_type: "openai",
      base_url: "http://127.0.0.1:4141/v1",
      api_style: "completions",
      api_key_env: "MAGPIE_ZEROSTACK_KEY",
    })
    expect(parsed.api_keys.openrouter).toBe("sk-or-user")
    expect(parsed.api_keys.magpie).toBe("mp-test-key")

    // 2. Idempotent when unchanged
    expect(syncOnce(opts).action).toBe("unchanged")

    // 3. Switch model to anthropic/claude-sonnet-4-5
    writeHandoff(home, {
      model: "anthropic/claude-sonnet-4-5",
      gateway: { url: "http://127.0.0.1:4141", v1: "http://127.0.0.1:4141/v1", key: "mp-test-key" },
    })
    expect(syncOnce(opts).action).toBe("synced")
    parsed = Bun.TOML.parse(fs.readFileSync(cfgPath, "utf8"))
    expect(parsed.model).toBe("anthropic/claude-sonnet-4-5")

    // 4. Simulate ZeroStack overwriting config.toml with an older model
    fs.writeFileSync(
      cfgPath,
      fs.readFileSync(cfgPath, "utf8").replace('model = "anthropic/claude-sonnet-4-5"', 'model = "stale"')
    )
    expect(syncOnce(opts).action).toBe("synced")
    expect(Bun.TOML.parse(fs.readFileSync(cfgPath, "utf8")).model).toBe("anthropic/claude-sonnet-4-5")

    // 5. Disconnect (magpie clears handoff keys)
    writeHandoff(home, {})
    expect(syncOnce(opts).action).toBe("restored")
    expect(fs.readFileSync(cfgPath, "utf8")).toBe(original)
    expect(fs.existsSync(path.join(home, ".magpie", "zerostack-agent-state.json"))).toBe(false)
  })

  test("Fresh install: creates config.toml on connect and removes it on disconnect", () => {
    const home = makeTempHome()
    const zsDir = path.join(home, "zs-fresh")
    const cfgPath = path.join(zsDir, "config.toml")
    const opts = { env: { ZS_CONFIG_DIR: zsDir }, platform: "linux", home }

    writeHandoff(home, {
      model: "openai/gpt-5",
      gateway: { v1: "http://127.0.0.1:4141/v1", key: "mp-fresh" },
    })
    expect(syncOnce(opts).action).toBe("synced")
    expect(fs.existsSync(cfgPath)).toBe(true)
    const parsed = Bun.TOML.parse(fs.readFileSync(cfgPath, "utf8"))
    expect(parsed.provider).toBe("magpie")
    expect(parsed.model).toBe("openai/gpt-5")

    writeHandoff(home, {})
    expect(syncOnce(opts).action).toBe("restored")
    expect(fs.existsSync(cfgPath)).toBe(false)
  })

  test("JSON and YAML configs sync and restore cleanly", () => {
    for (const [filename, initial] of [
      ["config.json", JSON.stringify({ provider: "openai", model: "gpt-4o", max_tokens: 8192 }, null, 2) + "\n"],
      ["config.yaml", 'provider: "openai"\nmodel: "gpt-4o"\nmax_tokens: 8192\n'],
    ]) {
      const home = makeTempHome()
      const zsDir = path.join(home, "zs")
      fs.mkdirSync(zsDir, { recursive: true })
      const cfgPath = path.join(zsDir, filename)
      fs.writeFileSync(cfgPath, initial)
      const opts = { env: { ZS_CONFIG_DIR: zsDir }, platform: "linux", home }

      writeHandoff(home, {
        model: "deepseek/pro",
        gateway: { v1: "http://127.0.0.1:4141/v1", key: "mp-k" },
      })
      expect(syncOnce(opts).action).toBe("synced")

      const rawAfter = fs.readFileSync(cfgPath, "utf8")
      const after = filename.endsWith(".json") ? JSON.parse(rawAfter) : Bun.YAML.parse(rawAfter)
      expect(after.provider).toBe("magpie")
      expect(after.model).toBe("deepseek/pro")
      expect(after.max_tokens).toBe(8192)
      expect(after.custom_providers.magpie.api_key_env).toBe("MAGPIE_ZEROSTACK_KEY")
      expect(after.api_keys.magpie).toBe("mp-k")

      writeHandoff(home, {})
      expect(syncOnce(opts).action).toBe("restored")

      const rawRestored = fs.readFileSync(cfgPath, "utf8")
      const restored = filename.endsWith(".json") ? JSON.parse(rawRestored) : Bun.YAML.parse(rawRestored)
      expect(restored).toEqual({ provider: "openai", model: "gpt-4o", max_tokens: 8192 })
    }
  })
})
