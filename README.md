# magpie-agent-zerostack

把 [ZeroStack](https://github.com/gi-dellav/zerostack) 接入 [magpie](https://github.com/yetone/magpie) 的 Agent 列表，在 magpie 的 Agents 页直接选择模型，自动同步到 ZeroStack 的 `config.toml` / `config.yaml` / `config.json`，并在断开时恢复原有配置。

## 工作原理

- `zerostack.agent.js`（运行在 magpie 内置 moejs）：把用户在 Agents 页选择的模型和网关地址/密钥写入交接文件 `~/.magpie/zerostack-agent.json`。
- `index.mjs`（运行在 magpie 的 Bun 插件宿主）：监听并轮询该交接文件，按 ZeroStack 的真实查找顺序（`$ZS_CONFIG_DIR` → `~/.config/zerostack/` → `~/.local/share/zerostack/`，优先级 `config.toml` > `config.yaml` > `config.yml` > `config.json`）找到配置文件，无损写入：

```toml
provider = "magpie"
model = "<provider>/<model>"

[custom_providers.magpie]
provider_type = "openai"
base_url = "http://127.0.0.1:<port>/v1"
api_style = "completions"
api_key_env = "MAGPIE_ZEROSTACK_KEY"

[api_keys]
magpie = "<gateway key>"
```

- 零外部依赖，直接由 Bun 运行；修改 `config.toml` 时保留原有注释、权限规则和其他自定义 Provider，写入前用 `Bun.TOML.parse` 校验并原子替换。
- 断开连接时，按 `~/.magpie/zerostack-agent-state.json` 记录的原始值还原 `provider` / `model` 并清理 magpie 写入的表项。

## 在 Linux 服务器上安装

1. 把本目录复制到 Linux 服务器（例如 `~/magpie-agent-zerostack`），或推到 GitHub 仓库。
2. 安装插件：

```bash
# 从 GitHub 直接安装（推荐）
magpie plugin add github:Maxwelltoo/magpie-agent-zerostack

# 或本地路径安装
# magpie plugin add ~/magpie-agent-zerostack
```

3. 确认 ZeroStack 已出现在 magpie 的 Agents 列表，选择模型（或在 CLI 执行）：

```bash
magpie agent list
```

4. ZeroStack 只在启动时读取配置，切换模型后重开 ZeroStack 生效。

> 注意：如果系统环境变量中设置了 `ZS_CONFIG_DIR` / `ZS_DATA_DIR`，请确保运行 `magpie` 的环境也能看到同一变量，插件会按与 ZeroStack 相同的优先级解析配置文件。

## 运行测试

```bash
bun test
```
