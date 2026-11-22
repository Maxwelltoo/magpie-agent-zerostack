// Bun plugin host entry for magpie-agent-zerostack.
//
// Magpie's Agents page runs zerostack.agent.js (in moejs) which writes the
// selected model and gateway details into ~/.magpie/zerostack-agent.json.
// This module watches/polls that handoff file and applies it to ZeroStack's
// real config file (TOML / YAML / JSON, resolved across $ZS_CONFIG_DIR,
// XDG/OS config dir, and XDG/OS data dir), restoring the previous settings
// when disconnected.
import fs from "node:fs"
import path from "node:path"
import {
  atomicWriteFile,
  configFormatOf,
  magpieFiles,
  readJsonSafe,
  resolveConfigPath,
  writeJsonAtomic,
} from "./lib/zerostack-files.mjs"
import { restoreSelection, selectionFrom, syncSelection } from "./lib/zerostack-sync.mjs"

const STARTED = Symbol.for("magpie.zerostack-agent.adapter.v1")
const POLL_MS = 2000
const WATCH_DEBOUNCE_MS = 100

export function syncOnce({
  env = process.env,
  platform = process.platform,
  home,
  say = () => {},
} = {}) {
  const mf = magpieFiles({ home })
  const picked = readJsonSafe(mf.selection)
  // If the handoff file is mid-write (unparseable JSON), wait for the next tick.
  if (!picked.ok && !picked.missing) return { action: "skip-invalid-handoff" }

  const selection = picked.ok ? selectionFrom(picked.value) : null
  const stateRead = readJsonSafe(mf.state)
  const state =
    stateRead.ok && stateRead.value && typeof stateRead.value === "object"
      ? stateRead.value
      : null

  if (!selection) {
    if (!state) return { action: "idle" }
    const targetPath = state.configPath || resolveConfigPath({ env, platform, home })
    const format = state.format || configFormatOf(targetPath)
    if (fs.existsSync(targetPath)) {
      const current = fs.readFileSync(targetPath, "utf8")
      const restored = restoreSelection({ content: current, format, state })
      if (restored.removeFile) {
        fs.rmSync(targetPath, { force: true })
      } else if (restored.changed) {
        atomicWriteFile(targetPath, restored.content)
      }
    }
    fs.rmSync(mf.state, { force: true })
    say(`zerostack: 已恢复原有配置 (${targetPath})，重启 ZeroStack 后生效。`)
    return { action: "restored", targetPath }
  }

  const targetPath = state?.configPath || resolveConfigPath({ env, platform, home })
  const format = state?.format || configFormatOf(targetPath)
  const fileExisted = fs.existsSync(targetPath)
  const current = fileExisted ? fs.readFileSync(targetPath, "utf8") : ""

  const result = syncSelection({
    content: current,
    format,
    configPath: targetPath,
    fileExisted,
    selection,
    state,
  })

  // Write state first so a crash after writing config never loses the original values.
  if (!state || JSON.stringify(result.state) !== JSON.stringify(state)) {
    writeJsonAtomic(mf.state, result.state)
  }

  if (result.changed) {
    atomicWriteFile(targetPath, result.content)
    say(`zerostack: 已同步模型 ${selection.model} 到 ${targetPath}，重启 ZeroStack 后生效。`)
    return { action: "synced", targetPath, model: selection.model }
  }

  return { action: "unchanged", targetPath, model: selection.model }
}

function start(input) {
  if (globalThis[STARTED]) return
  globalThis[STARTED] = true

  const log = (level, message) => {
    try {
      input?.client?.app?.log?.({ body: { service: "zerostack", level, message } })?.catch?.(() => {})
    } catch {
      /* Logging must never take the host down. */
    }
  }

  let lastMessage = ""
  const say = (message) => {
    if (message === lastMessage) return
    lastMessage = message
    log("info", message)
  }

  log("info", "zerostack: adapter started")

  let running = false
  let pending = false
  const run = () => {
    if (running) {
      pending = true
      return
    }
    running = true
    try {
      syncOnce({ say })
    } catch (err) {
      log("error", `zerostack: ${err?.message ?? err}`)
    } finally {
      running = false
      if (pending) {
        pending = false
        setTimeout(run, WATCH_DEBOUNCE_MS).unref?.()
      }
    }
  }

  run()

  // Fast path: watch ~/.magpie for changes to zerostack-agent.json.
  try {
    const mf = magpieFiles()
    fs.mkdirSync(mf.dir, { recursive: true })
    const handoffBase = path.basename(mf.selection)
    let debounceTimer = null
    const watcher = fs.watch(mf.dir, (_eventType, filename) => {
      if (filename && String(filename) !== handoffBase) return
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(run, WATCH_DEBOUNCE_MS)
      debounceTimer.unref?.()
    })
    watcher.on?.("error", () => {
      /* Fallback polling interval still runs. */
    })
    watcher.unref?.()
  } catch {
    /* Fallback polling interval still runs. */
  }

  setInterval(run, POLL_MS).unref?.()
}

export default async function zerostackAgent(input) {
  start(input)
  return {}
}
