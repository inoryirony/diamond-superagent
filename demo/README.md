# 面板预览（不依赖 DSH host）

把 `src/client` 的管理面板直接跑在浏览器里，`/orchestrator/api/*` 由测试夹具 `tests/fixtures/panel-server.ts` 的假服务器回答（通过 Vite SSR 加载，`vitest` 被 `demo/vitest-shim.ts` 顶替）。
用来理解面板的页面、工单状态和按钮，不连接真实 host，没有主 Session，也不会真的派工。

```bash
pnpm exec vite --config demo/vite.config.ts      # http://127.0.0.1:3083/   加 ?lang=en 切英文
```

- 假数据定义在 `tests/fixtures/panel-server.ts` 的 `initial()`：两个开着的工单（一个待回答、一个 worker 失败）、一个已停止的工单、一个飞书线程、一条 unavailable 评估、飞书来源 `socket closed`。
- 停止 / 重试 / 暂停 / 重新评估 / 取消订阅 / 保存设置都会改假服务器的内存状态，刷新页面即复位（重启 Vite）。
- "打开主 Session" / "打开 Session" 在真实部署里会在 DSH 工作区打开对应 Session，这里只弹提示。
- `shots/` 是各页截图。

# 真实装载（本机 DeepSeek Harness.app 自带的 dsh 0.2.1-rc.2）

```bash
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
pnpm build                                                        # 产出 lib/，profile 通过 link 引用
"$DSH" superagent --from-default-profile web --dump-config >/dev/null   # 只在首次建 profile 时跑，会清空 cordis.patch.yml
"$DSH" plugin --profile superagent add "link:$PWD"
# ~/.dsh/profiles/superagent/cordis.patch.yml：webserver 127.0.0.1:3082、dsh-superagent.stateDir、
# agent-default-model、llm-pi-ai providers（从 desktop profile 复制，apiKeyEnv 由 ~/.zshenv 提供）
zsh -lc 'exec "$DSH" --profile superagent --no-open' > /tmp/superagent-service.log 2>&1 &
```

- 面板地址带 token，从日志里取：`rg -o 'http://127.0.0.1:3082/\?token=\S+' /tmp/superagent-service.log`。
- 管理 API 不需要 token：`curl -H 'x-orchestrator-request: 1' http://127.0.0.1:3082/orchestrator/api/state`。
- 未填 GitHub 仓库和 agent CLI 时 host 处于 `setupPending`：面板可看、设置可改，主 Session 不创建，不收任何触发。
- `scripts/dsh-superagent status` 认不出 App 启动的进程（进程名是 `DeepSeek Harness` 而不是 `node`/`dsh`），会报 pids 为空，用 API 判断即可。
- 状态目录 `~/.dsh/state/superagent`（orchestrator.sqlite、work/）。
