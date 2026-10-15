# dsh-context-windows

仿 Codex 实验性上下文管理（experimental context management）的 DeepSeek Harness（dsh）插件。

它不生成摘要：模型边干活边给自己记笔记；上下文快满时切换到新窗口，再通过笔记和会话历史找回需要的信息。

## 工作方式

- **窗口**：模型可以用 `get_context_remaining` 查剩余预算，用 `new_context` 主动开新窗口。快满时插件提醒一次；预算用完时，要求模型先保存检查点再切换；到硬上限时强制切换。切换保留系统提示和环境信息，不调用模型做摘要。用量以服务商返回的实际 usage 为准，只对之后新增、尚未发送的内容做估算。到硬上限被强制切换时，新窗口会提示上一个窗口被切断、检查点可能过时，并给出该窗口的条目范围。
- **笔记**：会话内的虚拟文件，跨窗口保留。提供 `notes_list_files_by_prefix`、`notes_read_file`、`notes_search_contents`、`notes_append_to_file`、`notes_write_file` 五个工具。
- **历史**：只读查询本会话的原始事件。提供 `history_list_windows`、`history_list_items`、`history_search_contents`、`history_read_item` 四个工具。
- **条目编号**：与 Codex 相同，每个非助手条目（用户消息、工具结果等）在发给模型时，末尾带一个 `[id: #N]`。模型把编号记进笔记，换窗后用 `history_read_item({ seq: N })` 精确读回原文。编号只出现在发给模型的内容里，不写入会话日志。
- **`/compact`**：手动开新窗口。

## 安装

需要 dsh（已在 `0.2.1-alpha.2` 上验证）。从 GitHub Release 直接安装：

```sh
dsh plugin --profile web add https://github.com/Zhaoyi-Tian/dsh-context-windows/releases/download/v0.1.3/dsh-context-windows-0.1.3.tgz
```

装好后重启对应 profile：

- **Web**：新建对话时选择 **Context Windows** 预设（带持久化 shell）。其他预设不受影响，仍使用原生压缩。
- **命令行**：把上面命令里的 `web` 换成 `headless`，安装后直接生效，用本插件替换原生的压缩和 `/compact`。

卸载：

```sh
dsh plugin --profile web remove dsh-context-windows
```

卸载后旧会话可以正常恢复，只是不再显示条目编号。也可以从源码打包安装：`pnpm install && pnpm pack`，再把上面的 URL 换成生成的 `.tgz` 路径。

## 配置

在 profile 的 `cordis.patch.yml` 中覆盖：

```yaml
- id: dsh-context-windows
  config:
    contextTokens: 81920
    reminderThresholdTokens: 6144
    fallbackBufferTokens: 16384
    maxFileBytes: 1000000
```

| 配置 | 默认值 | 含义 |
| --- | --- | --- |
| `contextTokens` | 81920 | 硬上限，实际取它和「模型窗口减输出预留」中的较小值；`null` 表示只按模型窗口。默认值偏小，日常使用可以开大一些 |
| `reminderThresholdTokens` | 6144 | 剩余预算低于此值时提醒一次 |
| `fallbackBufferTokens` | 16384 | 预算用完后留给模型保存检查点的缓冲 |
| `maxFileBytes` | 1000000 | 单个笔记的字节上限，与 Codex 相同 |

`prompts.guidance`、`prompts.reminder`、`prompts.fallback` 可以替换默认提示，其中 `{n_remaining}` 会替换为剩余预算；`fallback: null` 关闭兜底提示和缓冲。

## 与 Codex 的差异

- 笔记和历史保存在本地会话日志里，不加密，也不要求模型对用户保密。
- 条目编号直接使用 dsh 的事件序号，在整个会话内唯一，所以不需要额外的窗口 ID。
- 不支持跨 agent 读取笔记或历史。
- 恢复效果取决于模型是否主动记笔记。插件只在快满和用完两个时间点提醒，到硬上限时也不会替模型补写检查点。

## 开发

```sh
pnpm install
pnpm build
pnpm test           # 单元测试
pnpm test:install   # 在隔离的 DSH_HOME 中安装打包产物并验证
pnpm test:e2e       # 真实模型测试，需要 DEEPSEEK_API_KEY 和 DEEPSEEK_BASE_URL
```

## 许可

MIT。部分代码取自 DeepSeek Harness 的实验实现，版权声明见 [LICENSE](LICENSE)。
