import { describe, expect, test } from "bun:test"
import { resolveConfigPath } from "../lib/zerostack-files.mjs"

describe("resolveConfigPath", () => {
  test("Linux: prefers existing file in ~/.config/zerostack over ~/.local/share/zerostack", () => {
    const existing = new Set([
      "/home/alice/.config/zerostack/config.yaml",
      "/home/alice/.local/share/zerostack/config.toml",
    ])
    const p = resolveConfigPath({
      env: {},
      platform: "linux",
      home: "/home/alice",
      exists: (x) => existing.has(x),
    })
    expect(p).toBe("/home/alice/.config/zerostack/config.yaml")
  })

  test("Linux: falls back to ~/.local/share/zerostack/config.toml when nothing exists", () => {
    const p = resolveConfigPath({
      env: {},
      platform: "linux",
      home: "/home/alice",
      exists: () => false,
    })
    expect(p).toBe("/home/alice/.local/share/zerostack/config.toml")
  })

  test("Linux: respects XDG_CONFIG_HOME and XDG_DATA_HOME", () => {
    const existing = new Set(["/srv/xdg/data/zerostack/config.toml"])
    const p = resolveConfigPath({
      env: { XDG_CONFIG_HOME: "/srv/xdg/cfg", XDG_DATA_HOME: "/srv/xdg/data" },
      platform: "linux",
      home: "/home/alice",
      exists: (x) => existing.has(x),
    })
    expect(p).toBe("/srv/xdg/data/zerostack/config.toml")
  })

  test("ZS_CONFIG_DIR overrides everything and picks candidate in priority order", () => {
    const existing = new Set([
      "/custom/zs/config.yml",
      "/custom/zs/config.json",
    ])
    const p = resolveConfigPath({
      env: { ZS_CONFIG_DIR: "/custom/zs" },
      platform: "linux",
      home: "/home/alice",
      exists: (x) => existing.has(x),
    })
    expect(p).toBe("/custom/zs/config.yml")
  })

  test("ZS_DATA_DIR overrides default data dir when config dir has no file", () => {
    const p = resolveConfigPath({
      env: { ZS_DATA_DIR: "~/my-zs" },
      platform: "linux",
      home: "/home/alice",
      exists: () => false,
    })
    expect(p.replace(/\\/g, "/")).toBe("/home/alice/my-zs/config.toml")
  })

  test("macOS and Windows default paths", () => {
    const mac = resolveConfigPath({
      env: {},
      platform: "darwin",
      home: "/Users/alice",
      exists: () => false,
    })
    expect(mac).toBe("/Users/alice/Library/Application Support/zerostack/config.toml")

    const win = resolveConfigPath({
      env: { APPDATA: "C:\\Users\\alice\\AppData\\Roaming" },
      platform: "win32",
      home: "C:\\Users\\alice",
      exists: () => false,
    })
    expect(win).toBe("C:\\Users\\alice\\AppData\\Roaming\\zerostack\\config.toml")
  })
})
