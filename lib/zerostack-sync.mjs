import {
  deleteTable,
  deleteTableKey,
  deleteTopKey,
  getTable,
  getTableKey,
  getTopKey,
  restoreTable,
  restoreTableKey,
  restoreTopKey,
  setTable,
  setTableKey,
  setTopKey,
  tomlString,
  validateToml,
} from "./toml-edit.mjs"

export const PROVIDER_NAME = "magpie"
export const API_KEY_ENV = "MAGPIE_ZEROSTACK_KEY"

export function selectionFrom(raw) {
  if (!raw || typeof raw !== "object") return null
  const model = typeof raw.model === "string" ? raw.model.trim() : ""
  const gatewayV1 = typeof raw.gateway?.v1 === "string" ? raw.gateway.v1.trim() : ""
  const gatewayKey = typeof raw.gateway?.key === "string" ? raw.gateway.key.trim() : ""
  if (!model || !gatewayV1 || !gatewayKey) return null
  return { model, gatewayV1, gatewayKey }
}

function customProviderObject(selection) {
  return {
    provider_type: "openai",
    base_url: selection.gatewayV1,
    api_style: "completions",
    api_key_env: API_KEY_ENV,
  }
}

function customProviderTomlLines(selection) {
  return [
    `provider_type = ${tomlString("openai")}`,
    `base_url = ${tomlString(selection.gatewayV1)}`,
    `api_style = ${tomlString("completions")}`,
    `api_key_env = ${tomlString(API_KEY_ENV)}`,
  ]
}

// ---- minimal YAML serializer for ZeroStack config.yaml / config.yml ----------

function yamlScalar(v) {
  if (v === null || v === undefined) return "null"
  if (typeof v === "boolean" || typeof v === "number") return String(v)
  return JSON.stringify(String(v))
}

function serializeYaml(value, indent = 0) {
  const pad = " ".repeat(indent)
  if (value === null || value === undefined || typeof value !== "object") {
    return yamlScalar(value)
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]"
    return value
      .map((item) => {
        if (item !== null && typeof item === "object") {
          const nested = serializeYaml(item, indent + 2)
          const firstTrimmed = nested.trimStart()
          return `${pad}- ${firstTrimmed}`
        }
        return `${pad}- ${yamlScalar(item)}`
      })
      .join("\n")
  }
  const entries = Object.entries(value).filter(([, v]) => v !== undefined)
  if (entries.length === 0) return "{}"
  return entries
    .map(([k, v]) => {
      const key = /^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k)
      if (v !== null && typeof v === "object") {
        if (Array.isArray(v) && v.length === 0) return `${pad}${key}: []`
        if (!Array.isArray(v) && Object.keys(v).length === 0) return `${pad}${key}: {}`
        return `${pad}${key}:\n${serializeYaml(v, indent + 2)}`
      }
      return `${pad}${key}: ${yamlScalar(v)}`
    })
    .join("\n")
}

function parseStructured(content, format) {
  if (!content || !content.trim()) return {}
  if (format === "json") {
    const parsed = JSON.parse(content)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
  }
  if (typeof globalThis.Bun?.YAML?.parse === "function") {
    const parsed = globalThis.Bun.YAML.parse(content)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
  }
  throw new Error("YAML parser unavailable (requires Bun runtime)")
}

function stringifyStructured(obj, format) {
  if (format === "json") {
    return JSON.stringify(obj, null, 2) + "\n"
  }
  const out = serializeYaml(obj) + "\n"
  if (typeof globalThis.Bun?.YAML?.parse === "function") {
    globalThis.Bun.YAML.parse(out)
  }
  return out
}

// ---- TOML apply / restore ----------------------------------------------------

function captureTomlHad(content) {
  const provider = getTopKey(content, "provider")
  const model = getTopKey(content, "model")
  const customProvider = getTable(content, `custom_providers.${PROVIDER_NAME}`)
  const apiKey = getTableKey(content, "api_keys", PROVIDER_NAME)
  return {
    provider: { existed: provider.found, raw: provider.raw },
    model: { existed: model.found, raw: model.raw },
    customProvider: { existed: customProvider.found, raw: customProvider.raw },
    apiKey: {
      existed: apiKey.found,
      raw: apiKey.raw,
      tableExisted: apiKey.tableExisted,
    },
  }
}

function applyToml(content, selection) {
  let next = content
  next = setTopKey(next, "provider", tomlString(PROVIDER_NAME))
  next = setTopKey(next, "model", tomlString(selection.model))
  next = setTable(next, `custom_providers.${PROVIDER_NAME}`, customProviderTomlLines(selection))
  next = setTableKey(next, "api_keys", PROVIDER_NAME, tomlString(selection.gatewayKey))
  validateToml(next)
  return next
}

function restoreToml(content, had) {
  let next = content
  next = had.provider?.existed
    ? restoreTopKey(next, "provider", had.provider.raw)
    : deleteTopKey(next, "provider")
  next = had.model?.existed
    ? restoreTopKey(next, "model", had.model.raw)
    : deleteTopKey(next, "model")
  next = had.customProvider?.existed
    ? restoreTable(next, `custom_providers.${PROVIDER_NAME}`, had.customProvider.raw)
    : deleteTable(next, `custom_providers.${PROVIDER_NAME}`)
  next = had.apiKey?.existed
    ? restoreTableKey(next, "api_keys", PROVIDER_NAME, had.apiKey.raw)
    : deleteTableKey(next, "api_keys", PROVIDER_NAME, {
        dropEmptyTable: !had.apiKey?.tableExisted,
      })
  if (next.trim() !== "") {
    validateToml(next)
  }
  return next
}

// ---- JSON / YAML apply / restore ---------------------------------------------

function captureStructuredHad(obj) {
  const customProviders =
    obj.custom_providers && typeof obj.custom_providers === "object" ? obj.custom_providers : null
  const apiKeys = obj.api_keys && typeof obj.api_keys === "object" ? obj.api_keys : null
  return {
    provider: { existed: Object.hasOwn(obj, "provider"), value: obj.provider },
    model: { existed: Object.hasOwn(obj, "model"), value: obj.model },
    customProvider: {
      existed: Boolean(customProviders && Object.hasOwn(customProviders, PROVIDER_NAME)),
      value: customProviders ? structuredClone(customProviders[PROVIDER_NAME]) : undefined,
      tableExisted: Boolean(customProviders),
    },
    apiKey: {
      existed: Boolean(apiKeys && Object.hasOwn(apiKeys, PROVIDER_NAME)),
      value: apiKeys ? apiKeys[PROVIDER_NAME] : undefined,
      tableExisted: Boolean(apiKeys),
    },
  }
}

function applyStructured(content, format, selection) {
  const obj = parseStructured(content, format)
  obj.provider = PROVIDER_NAME
  obj.model = selection.model
  if (!obj.custom_providers || typeof obj.custom_providers !== "object") {
    obj.custom_providers = {}
  }
  obj.custom_providers[PROVIDER_NAME] = customProviderObject(selection)
  if (!obj.api_keys || typeof obj.api_keys !== "object") {
    obj.api_keys = {}
  }
  obj.api_keys[PROVIDER_NAME] = selection.gatewayKey
  return stringifyStructured(obj, format)
}

function restoreStructured(content, format, had) {
  const obj = parseStructured(content, format)
  if (had.provider?.existed) obj.provider = had.provider.value
  else delete obj.provider

  if (had.model?.existed) obj.model = had.model.value
  else delete obj.model

  if (had.customProvider?.existed) {
    if (!obj.custom_providers || typeof obj.custom_providers !== "object") {
      obj.custom_providers = {}
    }
    obj.custom_providers[PROVIDER_NAME] = structuredClone(had.customProvider.value)
  } else if (obj.custom_providers && typeof obj.custom_providers === "object") {
    delete obj.custom_providers[PROVIDER_NAME]
    if (!had.customProvider?.tableExisted && Object.keys(obj.custom_providers).length === 0) {
      delete obj.custom_providers
    }
  }

  if (had.apiKey?.existed) {
    if (!obj.api_keys || typeof obj.api_keys !== "object") {
      obj.api_keys = {}
    }
    obj.api_keys[PROVIDER_NAME] = had.apiKey.value
  } else if (obj.api_keys && typeof obj.api_keys === "object") {
    delete obj.api_keys[PROVIDER_NAME]
    if (!had.apiKey?.tableExisted && Object.keys(obj.api_keys).length === 0) {
      delete obj.api_keys
    }
  }

  return { text: stringifyStructured(obj, format), isEmpty: Object.keys(obj).length === 0 }
}

// ---- Public API --------------------------------------------------------------

export function syncSelection({
  content = "",
  format = "toml",
  configPath,
  fileExisted = true,
  selection,
  state = null,
}) {
  let nextState = state
  if (!nextState) {
    const had =
      format === "toml"
        ? captureTomlHad(content)
        : captureStructuredHad(parseStructured(content, format))
    nextState = {
      version: 1,
      configPath,
      format,
      createdFile: !fileExisted,
      had,
    }
  }

  const nextContent =
    format === "toml"
      ? applyToml(content, selection)
      : applyStructured(content, format, selection)

  return {
    content: nextContent,
    changed: !fileExisted || nextContent !== content,
    state: nextState,
  }
}

export function restoreSelection({ content = "", format = "toml", state }) {
  if (!state || !state.had) {
    return { removeFile: false, content, changed: false }
  }
  if (format === "toml") {
    const next = restoreToml(content, state.had)
    const isEmpty = next.trim() === ""
    if (state.createdFile && isEmpty) {
      return { removeFile: true, content: "", changed: true }
    }
    return { removeFile: false, content: next, changed: next !== content }
  }
  const { text, isEmpty } = restoreStructured(content, format, state.had)
  if (state.createdFile && isEmpty) {
    return { removeFile: true, content: "", changed: true }
  }
  return { removeFile: false, content: text, changed: text !== content }
}
