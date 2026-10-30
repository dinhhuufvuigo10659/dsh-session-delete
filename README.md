# 右键删除会话（dsh-session-delete）

在 DSH Web 侧栏的会话行上**右键**，即可永久删除该会话。

## 用法

1. 在左侧会话列表里**右键**任意一行；
2. 菜单里选「删除会话…」；
3. 在确认卡片里点「删除」。

同一个动作也出现在会话行的「…」菜单里（「删除会话…」），方便触屏与键盘用户。
**当前正打开的那个会话**不能删除：先把界面切到别的会话，再回来删（避免删掉正在显示的会话）。

## 它到底删了什么

DSH 只提供"归档 / 取消归档"，没有删除会话的 API，所以由本插件的宿主半区真正清理磁盘足迹：

| 内容 | 路径 |
| --- | --- |
| 会话日志目录 | `$DSH_HOME/sessions/<工作区 slug>/<sessionId>/`（含 `session.v*.jsonl.zstd`） |
| 投影检查点 | `$DSH_HOME/storages/session_projcache/sessions/<sessionId>.json` |
| 子代理会话 | 该会话派生出的全部 subagent 会话日志（递归，最多 200 个） |

`$DSH_HOME` 默认是 `~/.dsh`。删除不可恢复。删除完成后宿主会发出 `api-session/removed`，侧栏那一行通常**立即消失**，不需要刷新页面；只有当行没消失时插件才自动整页刷新兜底。

## 安全边界

- **正在运行的回合先停**：会话若正在跑，插件会先 `sessionController.cancel()` 并等待其停下，再摘除运行时、删文件——避免半截日志和"删了又被写回来"。
- **先摘运行时再删文件**：通过 `sessions.detachEntered()` 关掉写句柄，删完还会复查 3 次，目录若被写回来会如实报错，而不是假装删除成功。
- **只删可验证的目录**：优先用 `sessionPersistence.locate()`，否则在会话根下一层扫描；目录名必须与 sessionId 完全一致才允许删除。
- 路由只接受**本机回环地址 + 同源**请求，并会委托 `connection.requestRejection` 做宿主自己的准入判断；跨站请求一律 403，未登录（无 DSH 的 HttpOnly cookie）一律 401。浏览器的同源 `fetch` 会自动带上该 cookie。
- 会话 id 先做白名单校验，路径拼接无法越出会话根目录。
- 附件（`~/.dsh/attachments`）是内容寻址且跨会话共享的，**不会**被删除。

## 实现结构

- `index.js`：宿主半区。注册 `POST /dsh-session-delete/delete`、`GET /dsh-session-delete/health`。
- `client.js`：浏览器半区（`window.__ModuleLoader__` 模块）。注册 `shell.overlay` 上下文菜单卡片、`sidebar.workspaces.session.menu.item` 菜单行，并在捕获阶段监听 `contextmenu`。
- `cordis.patch.yml`：把宿主半区插入当前 profile。
- `locale/*.json`：插件管理器里显示的名称与说明；界面文案走 `ctx.locale`。

## 已知限制

- 右键识别依赖会话行的 `data-row-key="session:<id>"`（当前 DSH 侧栏唯一携带会话 id 的标记）。若未来改名，右键会静默不响应，但仍可从「…」菜单删除。
- 若宿主在删除后仍把该 id 留在工作区清单里，它是无害的：清单渲染时会丢弃找不到会话摘要的 id，宿主下次写清单时也会顺带清理。
- 删除「当前打开的会话」被有意禁止（见上），宿主侧其实具备摘除能力，只是不想让对话区停在一个已销毁的会话上。
