// Comment-preserving surgical TOML editor for ZeroStack's config.toml.
// Only touches:
//   - top-level keys (`provider`, `model`)
//   - `[custom_providers.magpie]` table
//   - `[api_keys]` -> `magpie` key
// Preserves user comments, formatting, and all unrelated tables/keys.

export function tomlString(value) {
  let out = '"'
  for (const ch of String(value)) {
    const code = ch.charCodeAt(0)
    if (ch === "\\") out += "\\\\"
    else if (ch === '"') out += '\\"'
    else if (ch === "\b") out += "\\b"
    else if (ch === "\f") out += "\\f"
    else if (ch === "\n") out += "\\n"
    else if (ch === "\r") out += "\\r"
    else if (ch === "\t") out += "\\t"
    else if (code < 0x20 || code === 0x7f) {
      out += "\\u" + code.toString(16).padStart(4, "0")
    } else {
      out += ch
    }
  }
  return out + '"'
}

export function validateToml(text) {
  if (typeof globalThis.Bun?.TOML?.parse === "function") {
    return globalThis.Bun.TOML.parse(text)
  }
  return null
}

function detectEol(text) {
  return text.includes("\r\n") ? "\r\n" : "\n"
}

function splitLines(text) {
  if (!text) return []
  const normalized = text.replace(/\r\n/g, "\n")
  const lines = normalized.split("\n")
  // Drop single trailing empty element caused by final newline.
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop()
  }
  return lines
}

function joinLines(lines, eol) {
  if (lines.length === 0) return ""
  return lines.join(eol) + eol
}

function stripComment(line) {
  let inSingle = false
  let inDouble = false
  let escaped = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inDouble) {
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') inDouble = false
    } else if (inSingle) {
      if (ch === "'") inSingle = false
    } else {
      if (ch === '"') inDouble = true
      else if (ch === "'") inSingle = true
      else if (ch === "#") return line.slice(0, i)
    }
  }
  return line
}

function normalizeTableName(rawHeader) {
  // Split dotted header outside quotes and normalize bare/quoted segments.
  const parts = []
  let cur = ""
  let quote = null
  let escaped = false
  for (let i = 0; i < rawHeader.length; i++) {
    const ch = rawHeader[i]
    if (quote) {
      cur += ch
      if (quote === '"') {
        if (escaped) escaped = false
        else if (ch === "\\") escaped = true
        else if (ch === '"') quote = null
      } else if (ch === "'") {
        quote = null
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch
      cur += ch
    } else if (ch === ".") {
      parts.push(cur.trim())
      cur = ""
    } else {
      cur += ch
    }
  }
  if (cur.trim() !== "") parts.push(cur.trim())
  return parts
    .map((seg) => {
      if ((seg.startsWith('"') && seg.endsWith('"')) || (seg.startsWith("'") && seg.endsWith("'"))) {
        const inner = seg.slice(1, -1)
        if (/^[A-Za-z0-9_-]+$/.test(inner)) return inner
      }
      return seg
    })
    .join(".")
}

function parseKeyName(line) {
  const m = line.match(/^\s*([A-Za-z0-9_-]+|"[^"\\]*(?:\\.[^"\\]*)*"|'[^']*')\s*=/)
  if (!m) return null
  const raw = m[1]
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1)
  }
  return raw
}

/**
 * Tracks multiline strings (""" / ''') and bracket depth across lines
 * so we know where each key-value span starts/ends and never mistake
 * a line inside a multiline string for a table header.
 */
function scanToml(lines) {
  const sections = []
  let current = { name: "", isArray: false, headerLine: -1, startLine: 0, endLine: lines.length - 1, keys: [] }
  sections.push(current)

  let multiQuote = null // '"""' | "'''" | null
  let bracketDepth = 0
  let braceDepth = 0
  let activeKey = null

  const updateDelimiters = (line, startIdx) => {
    let inSingle = false
    let inDouble = false
    let escaped = false
    for (let i = startIdx; i < line.length; i++) {
      if (multiQuote) {
        if (multiQuote === '"""') {
          if (escaped) {
            escaped = false
            continue
          }
          if (line[i] === "\\") {
            escaped = true
            continue
          }
        }
        if (line.slice(i, i + 3) === multiQuote) {
          multiQuote = null
          i += 2
        }
        continue
      }
      const ch = line[i]
      if (inDouble) {
        if (escaped) escaped = false
        else if (ch === "\\") escaped = true
        else if (ch === '"') inDouble = false
      } else if (inSingle) {
        if (ch === "'") inSingle = false
      } else {
        if (ch === "#") break
        if (line.slice(i, i + 3) === '"""') {
          multiQuote = '"""'
          i += 2
        } else if (line.slice(i, i + 3) === "'''") {
          multiQuote = "'''"
          i += 2
        } else if (ch === '"') {
          inDouble = true
        } else if (ch === "'") {
          inSingle = true
        } else if (ch === "[") {
          bracketDepth++
        } else if (ch === "]") {
          bracketDepth = Math.max(0, bracketDepth - 1)
        } else if (ch === "{") {
          braceDepth++
        } else if (ch === "}") {
          braceDepth = Math.max(0, braceDepth - 1)
        }
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (multiQuote || bracketDepth > 0 || braceDepth > 0) {
      updateDelimiters(line, 0)
      if (activeKey) activeKey.endLine = i
      if (!multiQuote && bracketDepth === 0 && braceDepth === 0) {
        activeKey = null
      }
      continue
    }

    const trimmed = stripComment(line).trim()
    if (!trimmed) continue

    if (trimmed.startsWith("[[") && trimmed.endsWith("]]")) {
      current.endLine = i - 1
      current = {
        name: normalizeTableName(trimmed.slice(2, -2)),
        isArray: true,
        headerLine: i,
        startLine: i,
        endLine: lines.length - 1,
        keys: [],
      }
      sections.push(current)
      continue
    }

    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      current.endLine = i - 1
      current = {
        name: normalizeTableName(trimmed.slice(1, -1)),
        isArray: false,
        headerLine: i,
        startLine: i,
        endLine: lines.length - 1,
        keys: [],
      }
      sections.push(current)
      continue
    }

    const keyName = parseKeyName(line)
    if (keyName !== null) {
      const eqIdx = line.indexOf("=")
      const entry = { key: keyName, startLine: i, endLine: i }
      current.keys.push(entry)
      activeKey = entry
      updateDelimiters(line, eqIdx + 1)
      if (!multiQuote && bracketDepth === 0 && braceDepth === 0) {
        activeKey = null
      }
    }
  }

  // Compute bodyEnd for each section: excludes trailing blank lines and
  // any comment lines immediately preceding the next table header.
  for (let s = 0; s < sections.length; s++) {
    const sec = sections[s]
    const hasNext = s + 1 < sections.length
    const minLine = sec.headerLine >= 0 ? sec.headerLine : -1
    let end = sec.endLine
    if (hasNext) {
      // Walk backward skipping comments/blanks that belong to the next header.
      while (end > minLine) {
        const t = lines[end].trim()
        if (t === "" || t.startsWith("#")) end--
        else break
      }
    } else {
      while (end > minLine && lines[end].trim() === "") end--
    }
    sec.bodyEnd = end
  }

  return sections
}

function findSection(sections, tableName) {
  return sections.find((s) => !s.isArray && s.name === tableName) || null
}

function spliceKeyInSection(lines, sec, key, newLines) {
  const existing = sec.keys.find((k) => k.key === key)
  if (existing) {
    lines.splice(existing.startLine, existing.endLine - existing.startLine + 1, ...newLines)
    return lines
  }
  if (newLines.length === 0) return lines

  if (sec.headerLine === -1) {
    // Root section: insert right after the last top-level key, or at line 0.
    const insertAt = sec.keys.length > 0 ? sec.keys[sec.keys.length - 1].endLine + 1 : 0
    lines.splice(insertAt, 0, ...newLines)
    // Ensure a blank line before the first table header if we inserted at top of a file with tables.
    const nextIdx = insertAt + newLines.length
    if (nextIdx < lines.length && lines[nextIdx].trim().startsWith("[")) {
      lines.splice(nextIdx, 0, "")
    }
    return lines
  }

  const insertAt = Math.max(sec.headerLine + 1, sec.bodyEnd + 1)
  lines.splice(insertAt, 0, ...newLines)
  return lines
}

export function getTopKey(text, key) {
  const lines = splitLines(text)
  const root = scanToml(lines)[0]
  const entry = root.keys.find((k) => k.key === key)
  if (!entry) return { found: false, raw: null }
  return { found: true, raw: lines.slice(entry.startLine, entry.endLine + 1).join("\n") }
}

export function setTopKey(text, key, formattedValue) {
  const eol = detectEol(text)
  const lines = splitLines(text)
  const root = scanToml(lines)[0]
  spliceKeyInSection(lines, root, key, [`${key} = ${formattedValue}`])
  return joinLines(lines, eol)
}

export function deleteTopKey(text, key) {
  const eol = detectEol(text)
  const lines = splitLines(text)
  const root = scanToml(lines)[0]
  const entry = root.keys.find((k) => k.key === key)
  if (!entry) return text
  lines.splice(entry.startLine, entry.endLine - entry.startLine + 1)
  return joinLines(lines, eol)
}

export function restoreTopKey(text, key, raw) {
  if (raw == null) return deleteTopKey(text, key)
  const eol = detectEol(text)
  const lines = splitLines(text)
  const root = scanToml(lines)[0]
  spliceKeyInSection(lines, root, key, raw.split("\n"))
  return joinLines(lines, eol)
}

export function getTable(text, tableName) {
  const lines = splitLines(text)
  const sec = findSection(scanToml(lines), tableName)
  if (!sec) return { found: false, raw: null }
  return {
    found: true,
    raw: lines.slice(sec.headerLine, sec.bodyEnd + 1).join("\n"),
  }
}

export function setTable(text, tableName, kvLines) {
  const eol = detectEol(text)
  const lines = splitLines(text)
  const sec = findSection(scanToml(lines), tableName)
  const block = [`[${tableName}]`, ...kvLines]
  if (sec) {
    lines.splice(sec.headerLine, sec.bodyEnd - sec.headerLine + 1, ...block)
    return joinLines(lines, eol)
  }
  // Append new table with a separating blank line if file is non-empty.
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
    lines.pop()
  }
  if (lines.length > 0) lines.push("")
  lines.push(...block)
  return joinLines(lines, eol)
}

export function deleteTable(text, tableName) {
  const eol = detectEol(text)
  const lines = splitLines(text)
  const sec = findSection(scanToml(lines), tableName)
  if (!sec) return text

  let start = sec.headerLine
  let count = sec.bodyEnd - sec.headerLine + 1
  // Also remove a single preceding blank line if present so we don't leave double blank lines.
  if (start > 0 && lines[start - 1].trim() === "") {
    start--
    count++
  } else if (start + count < lines.length && lines[start + count].trim() === "") {
    count++
  }
  lines.splice(start, count)
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
    lines.pop()
  }
  return joinLines(lines, eol)
}

export function restoreTable(text, tableName, raw) {
  if (raw == null) return deleteTable(text, tableName)
  const eol = detectEol(text)
  const lines = splitLines(text)
  const sec = findSection(scanToml(lines), tableName)
  const block = raw.split("\n")
  if (sec) {
    lines.splice(sec.headerLine, sec.bodyEnd - sec.headerLine + 1, ...block)
    return joinLines(lines, eol)
  }
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
    lines.pop()
  }
  if (lines.length > 0) lines.push("")
  lines.push(...block)
  return joinLines(lines, eol)
}

export function getTableKey(text, tableName, key) {
  const lines = splitLines(text)
  const sec = findSection(scanToml(lines), tableName)
  if (!sec) return { found: false, raw: null, tableExisted: false }
  const entry = sec.keys.find((k) => k.key === key)
  if (!entry) return { found: false, raw: null, tableExisted: true }
  return {
    found: true,
    raw: lines.slice(entry.startLine, entry.endLine + 1).join("\n"),
    tableExisted: true,
  }
}

export function setTableKey(text, tableName, key, formattedValue) {
  const eol = detectEol(text)
  const lines = splitLines(text)
  const sec = findSection(scanToml(lines), tableName)
  if (!sec) {
    return setTable(text, tableName, [`${key} = ${formattedValue}`])
  }
  spliceKeyInSection(lines, sec, key, [`${key} = ${formattedValue}`])
  return joinLines(lines, eol)
}

export function deleteTableKey(text, tableName, key, { dropEmptyTable = false } = {}) {
  const eol = detectEol(text)
  const lines = splitLines(text)
  const sec = findSection(scanToml(lines), tableName)
  if (!sec) return text
  const entry = sec.keys.find((k) => k.key === key)
  if (!entry) return text

  if (dropEmptyTable && sec.keys.length === 1) {
    return deleteTable(text, tableName)
  }
  lines.splice(entry.startLine, entry.endLine - entry.startLine + 1)
  return joinLines(lines, eol)
}

export function restoreTableKey(text, tableName, key, raw, { dropEmptyTable = false } = {}) {
  if (raw == null) {
    return deleteTableKey(text, tableName, key, { dropEmptyTable })
  }
  const eol = detectEol(text)
  const lines = splitLines(text)
  const sec = findSection(scanToml(lines), tableName)
  if (!sec) {
    return setTable(text, tableName, raw.split("\n"))
  }
  spliceKeyInSection(lines, sec, key, raw.split("\n"))
  return joinLines(lines, eol)
}
