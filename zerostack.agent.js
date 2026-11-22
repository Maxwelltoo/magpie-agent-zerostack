// Runs in-process inside magpie (moejs). No Node/Bun imports allowed here.
//
// ZeroStack prefers TOML (config.toml) and resolves its config across
// $ZS_CONFIG_DIR, XDG/OS config dir, and XDG/OS data dir. Magpie's declarative
// agent plugins currently only write a single static json/yaml/env file, so this
// file records the active magpie selection in ~/.magpie/zerostack-agent.json
// and index.mjs (running in magpie's Bun plugin host) applies it to ZeroStack's
// actual config file and restores it on disconnect.
export const agent = {
  id: "zerostack",
  name: "ZeroStack",
  bin: "zerostack",
  dir: "~/.local/share/zerostack",
  aliases: ["zs"],
  config: "~/.magpie/zerostack-agent.json",
  format: "json",
  model: "model",
  effort: true,
  notice:
    "ZeroStack reads its config on startup. Restart ZeroStack after switching models. (ZeroStack 只在启动时读取配置，切换模型后请重启 ZeroStack。)",
}

export function connect({ gateway }) {
  return {
    "gateway.url": gateway.url,
    "gateway.v1": gateway.v1,
    "gateway.key": gateway.key,
  }
}
