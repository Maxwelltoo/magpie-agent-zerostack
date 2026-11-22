import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// Matches zerostack/src/config/load.rs CONFIG_CANDIDATES priority order.
export const CONFIG_CANDIDATES = [
  "config.toml",
  "config.yaml",
  "config.yml",
  "config.json",
]

export function expandTilde(inputPath, home = os.homedir()) {
  if (!inputPath) return inputPath
  if (inputPath === "~") return home
  if (inputPath.startsWith("~/") || inputPath.startsWith("~\\")) {
    return path.join(home, inputPath.slice(2))
  }
  return inputPath
}

function isAbsoluteForPlatform(p, platform) {
  if (!p) return false
  return platform === "win32" ? path.win32.isAbsolute(p) : path.posix.isAbsolute(p)
}

function joinForPlatform(platform, ...parts) {
  return platform === "win32" ? path.win32.join(...parts) : path.posix.join(...parts)
}

/**
 * Mirrors Rust `dirs::config_dir()` + "zerostack".
 */
export function defaultConfigDir({
  env = process.env,
  platform = process.platform,
  home = os.homedir(),
} = {}) {
  if (platform === "darwin") {
    return joinForPlatform(platform, home, "Library", "Application Support", "zerostack")
  }
  if (platform === "win32") {
    const base = env.APPDATA || joinForPlatform(platform, home, "AppData", "Roaming")
    return joinForPlatform(platform, base, "zerostack")
  }
  const xdg = env.XDG_CONFIG_HOME
  const base =
    xdg && isAbsoluteForPlatform(xdg, platform)
      ? xdg
      : joinForPlatform(platform, home, ".config")
  return joinForPlatform(platform, base, "zerostack")
}

/**
 * Mirrors zerostack/src/session/storage.rs `data_dir()`.
 */
export function defaultDataDir({
  env = process.env,
  platform = process.platform,
  home = os.homedir(),
} = {}) {
  if (env.ZS_DATA_DIR && env.ZS_DATA_DIR.trim() !== "") {
    return expandTilde(env.ZS_DATA_DIR, home)
  }
  if (platform === "darwin") {
    return joinForPlatform(platform, home, "Library", "Application Support", "zerostack")
  }
  if (platform === "win32") {
    const base = env.APPDATA || joinForPlatform(platform, home, "AppData", "Roaming")
    return joinForPlatform(platform, base, "zerostack")
  }
  const xdg = env.XDG_DATA_HOME
  const base =
    xdg && isAbsoluteForPlatform(xdg, platform)
      ? xdg
      : joinForPlatform(platform, home, ".local", "share")
  return joinForPlatform(platform, base, "zerostack")
}

export function pickExisting(dir, { exists = fs.existsSync, platform = process.platform } = {}) {
  for (const name of CONFIG_CANDIDATES) {
    const candidate = joinForPlatform(platform, dir, name)
    if (exists(candidate)) return candidate
  }
  return joinForPlatform(platform, dir, CONFIG_CANDIDATES[0])
}

/**
 * Mirrors zerostack/src/config/load.rs `resolve_config_path()`.
 */
export function resolveConfigPath({
  env = process.env,
  platform = process.platform,
  home = os.homedir(),
  exists = fs.existsSync,
} = {}) {
  if (env.ZS_CONFIG_DIR && env.ZS_CONFIG_DIR.trim() !== "") {
    return pickExisting(expandTilde(env.ZS_CONFIG_DIR, home), { exists, platform })
  }

  const cdir = defaultConfigDir({ env, platform, home })
  const pickedConfig = pickExisting(cdir, { exists, platform })
  if (exists(pickedConfig)) {
    return pickedConfig
  }

  const ddir = defaultDataDir({ env, platform, home })
  return pickExisting(ddir, { exists, platform })
}

export function configFormatOf(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === ".toml") return "toml"
  if (ext === ".json") return "json"
  if (ext === ".yaml" || ext === ".yml") return "yaml"
  return "toml"
}

export function magpieFiles({ home = os.homedir() } = {}) {
  const dir = path.join(home, ".magpie")
  return {
    dir,
    selection: path.join(dir, "zerostack-agent.json"),
    state: path.join(dir, "zerostack-agent-state.json"),
  }
}

export function readJsonSafe(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8")
    return { ok: true, missing: false, value: JSON.parse(raw) }
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return { ok: false, missing: true, value: null }
    }
    return { ok: false, missing: false, value: null, error: err }
  }
}

export function atomicWriteFile(filePath, content, { mode = 0o600 } = {}) {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })

  let finalMode = mode
  try {
    finalMode = fs.statSync(filePath).mode & 0o777
  } catch {
    /* file does not exist yet */
  }

  const tmp = `${filePath}.magpie.${process.pid}.${Date.now()}.tmp`
  try {
    fs.writeFileSync(tmp, content, { encoding: "utf8", mode: finalMode })
    fs.renameSync(tmp, filePath)
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      /* ignore cleanup errors */
    }
    throw err
  }
}

export function writeJsonAtomic(filePath, value, opts) {
  atomicWriteFile(filePath, JSON.stringify(value, null, 2) + "\n", opts)
}
