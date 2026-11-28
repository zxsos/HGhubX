# 上游线路

## 责任与边界

线路子系统负责当前激活视频源上游 origin 的选择、持久化和信任判定：当前源声明的固定线路清单
（`manifest.network.origins`）、激活源 `discoverMirrors` 返回的可信镜像、用户显式保存的
自定义线路，以及探测、自动选线和回切默认线路。它回答“这次请求发往哪个 HTTPS origin”，
不负责 HTTP 客户端、代理、DNS 固定或媒体字节（见
[network-proxy-media.md](network-proxy-media.md)）。

凭据只属于 origin：`token()`/`user()`/`snapshot()` 按 origin 精确匹配。同一视频源的可信线路
共享账号体系，因此源内固定线路与可信镜像之间的切换经 `SessionStore::rebase_if_trusted()`
把会话 origin 改写为新线路（revision 递增并落盘），登录得以保留；任一端不可信（自定义线路、
未被激活源 `discoverMirrors` 确认的镜像）时仍然 `SessionStore.clear()`，旧 token 不会跟着
地址走。镜像只有在本次进程内通过激活源 `discoverMirrors` 返回并通过 `normalize_base()`
校验后才进入 `TRUSTED_MIRRORS`，获得携带凭据与参与 rebase 的资格；`line.json` 里的历史
地址本身不授予信任。客户端不内置任何固定域名、导航站或站点发布页解析器。

## 事实来源

- 线路状态与持久化：[`src-tauri/src/net/mod.rs`](../../src-tauri/src/net/mod.rs) 的
  `DEFAULT_BASE`（`""`）、`LineConfig`、`BASE`、`BASE_FILE`；
  [`src-tauri/src/net/line.rs`](../../src-tauri/src/net/line.rs) 的
  `base()`（为空时回退 `crate::source::active_default_origin()`）、`sync_base_for_source()`、
  `is_custom_line()`、`normalize_base()`、`trusted_auth_origin()`、`persisted_line()`、
  `bind_base()`、`set_base()`、`set_custom_base()`、`save_line()`、`apply_base()`。
- 源声明线路与镜像发现：[`src-tauri/src/lines/mirror.rs`](../../src-tauri/src/lines/mirror.rs) 的
  `MIRROR_MAX`、`fixed()`、`is_fixed()`、`mirrors()`、`remember_published()`、
  `is_trusted_mirror()`、`trusted_mirrors_snapshot()`、`verify_published_origin()`
  （委托 [`src-tauri/src/source/commands.rs`](../../src-tauri/src/source/commands.rs) 的
  `invoke_active("discoverMirrors", json!({}), None, None)`）。
- 探测与选择：[`src-tauri/src/lines/probe.rs`](../../src-tauri/src/lines/probe.rs) 的
  `healthy_video_data()`、`probe_hit()`、`probe_hit_with_timeout()`（优先调用激活源
  `probeLine`，未实现时回退 `home({ page: 1, size: 1 })`）、`probe()`、`auto_candidates()`、
  `pick_from_hits()`、`auto_pick()`、`try_main()`、`health()`。
- Tauri 命令：[`src-tauri/src/api/lines.rs`](../../src-tauri/src/api/lines.rs) 的
  `line_state`、`line_set`、`line_custom_set`、`line_reset`、`line_cancel`、`line_mirrors`、
  `line_probe`、`line_auto`、`line_try_main`、`line_health`；命令注册在
  [`src-tauri/src/lib.rs`](../../src-tauri/src/lib.rs) 的 `generate_handler!`。
- 前端自动选线：[`src/shared/network/autoLine.ts`](../../src/shared/network/autoLine.ts) 的 `autoLineEnabled()`、
  `pickLine()`、`check()`、`attach()`、`initAutoLine()`、`setAutoLine()`。
- 线路 UI：[`src/features/settings/LinePicker.tsx`](../../src/features/settings/LinePicker.tsx) 的
  `readState()`、`readMirrors()`、`probe()`、`applyLine()`、`saveCustom()`。

## 主运行时路径

1. 启动时 `bind_base(app_data_dir)` 读取 `line.json`。格式是 `{v:2, base, custom}`；
   `persisted_line()` 只接受纯 HTTPS origin，旧 `{base}` 格式恢复地址但不恢复自定义线路的登录
   授权。`source::bind` 或切换视频源（`source_activate` / `source_import` / `source_resolve_import` /
   `source_import_subscription` / `source_rollback` / `source_remove` / `source_remove_many`）时调用 `sync_base_for_source()` 对齐默认线路，并由 `refresh_media_scope()` 让媒体缓存看到新的线路代次。
2. 固定线路列表 `fixed()` 动态读取当前激活视频源的 `manifest.network.origins`；没有导入源或
   `origins` 为空（例如纯离线源）时返回空列表，`auto_pick()` 直接返回 `reason="no-source"`。
   `line_state` 返回 `base`、`default`、`custom` 和 `fixed`；`line_mirrors` 调用 `lines::mirrors()`，
   委托激活源在 QuickJS 沙箱内执行 `discoverMirrors`（受 `manifest.network.publishOrigins` /
   `origins` 白名单、12 秒执行超时与 2 MB 响应上限约束）。
3. `lines::mirrors()` 对激活源返回的候选逐一经 `normalize_base()` 校验为纯 HTTPS origin
   （最多 `MIRROR_MAX = 20` 个）；非空时调用 `remember_published()` 写入进程内
   `TRUSTED_MIRRORS`（上限 256），Rust 不再内置任何 HTML/JS 发布页解析器。
4. 手动选择固定或镜像线路走 `line_set`；自定义线路走 `line_custom_set`。二者都先经过
   `normalize_base()`（HTTPS、无路径/查询/片段、拒绝内网），非自定义线路还必须属于 `is_fixed()`
   或 `is_trusted_mirror()`。成功后写入 `line.json`（临时文件 + rename），刷新 HTTP 客户端；
   地址变化时 `line_set` 先尝试 `rebase_if_trusted()`（两端都是当前源的固定/可信镜像则保留会话），
   失败才 `state.session.clear()`；`line_custom_set` 永远清空——自定义站点不参与可信 rebase，
   即使旧 origin 可信也不能把 token 带过去。
5. 自动选线由 `autoLine.ts` 驱动（仅当当前激活源 `capabilities.lines` 为 `true` 且已配置可用线路时启用）：
   启动、上线、页面重新可见、`api_*` 连续两次网络失败或手动开启都会触发体检。`line_health`
   只探当前线路；连续两次失败才 `line_auto`，每 15 秒最多主动选一次，定时体检按 60/120/300 秒退避。
6. `auto_pick()` 先以 3 秒超时探测主线路 `origins[0]`（优先调用激活源 `probeLine`，未实现时回退
   `home({ page: 1, size: 1 })`）；主线路健康则中止并发 `mirrors()` 任务并直接返回。否则从
   `discoverMirrors` 返回且加入 `TRUSTED_MIRRORS` 的候选中最多取 10 个并发探测（6 秒超时）。
   判据是 `healthy_video_data()`：返回 `{ ok: true }`，或解包后的 `items`（每项含正整数 `id` 与非空 `title`）
   及 `pagination`（`page > 0`、`size > 0`、`pages`、`total`）都有效；HTTP 200 空壳或 HTML 落地页都不算健康。
7. `pick_from_hits()` 选择 `ok=true` 且耗时最短的候选；没有候选时返回
   `reason="all-down"`、`base=""`（无有效源时返回 `reason="no-source"`）。前端收到 `all-down`
   只提示一次并保持当前线路。`line_auto` 在真正落盘前重新检查 `LINE_SELECTION` 代次，用户手动操作会让旧探测作废。
8. 当前是备选镜像时，健康检查会调用 `line_try_main()`：仅探测 `active_default_origin()`，通了就切回，
   代价是一个请求；两端可信时会话经 rebase 保留，旧 origin 不可信（如自定义线路）则清空。切回后
   `hg:line-changed` 让列表和详情按新 `lineEpoch` 重新读取。`line_auto` 落盘切换时同样执行
   rebase-or-clear；`app_boot` 在当前 origin 查不到会话、但存有旧 origin 会话时，同时对旧 origin
   与当前 origin 做 `verify_published_origin()` 可信刷新（填充 `TRUSTED_MIRRORS`），再尝试 rebase，覆盖
   镜像登录后重启回默认线路或切新镜像的场景。
9. `Api::optional_token()`（供 `source_call` 携带可选登录态）在严格模式下检查 `trusted_auth_origin()`：
   仅当当前 origin 为激活源固定线路、本次进程内通过 `discoverMirrors` 确认过的可信镜像，或用户显式
   保存的自定义线路时才附带 token，否则降级为游客请求。`account_source_call()` 按 `SessionStore`
   当前 `origin` 精确匹配会话（`account_session()`）；`verify_published_origin()` 仅在启动对账
   `app_boot`（`reconcile_on_boot`）及 401 自动重登（`verify_relogin_origins`）时按需触发，
   常规业务请求与手动 `api_login` / `api_register` 不额外拦截或触发镜像发现。

## 状态转换

- 启动：无 `line.json` 或内容损坏 → `DEFAULT_BASE`；有效 v2 自定义线路 → 恢复
  `{base, custom:true}`；旧格式 → 只恢复地址，`custom=false`。boot 的登录可见性由
  `session::boot_credentials_visible()` 决定：严格模式下本进程镜像发现验证失败时，
  绑在当前线路的会话仍对前端可见（不报登出）；未绑当前线路的会话仍 fail closed 报登出。
- 选择：手动点击 → `line_set`/`line_custom_set` → 校验 → 写临时文件 → rename →
  更新内存 `BASE` → `refresh_client()` → 地址变化时清会话 → UI 收到 `hg:line-changed`。
- 自动：`lines::health()` 探测前先刷新 HTTP 客户端以丢弃切换网络后的旧连接/DNS/代理缓存；
  `health.ok` → 重置失败计数并延长体检间隔；连续两次不健康 → `auto_pick`；
  有赢家 → 切换并回到 60 秒；all-down → 保持当前线路并 10 秒后重试。`online` 事件跳过冷却强制
  选线（后台触发时记 `pendingOnlinePick`，回到前台立即补跑）；HTTP 403 纳入网络观察信号。
- 取消：`line_cancel` 只增加代次，不修改线路；正在探测的 `line_auto` 返回
  `cancelled=true`，不再落盘。
- 镜像发现：激活源 `discoverMirrors` 首次成功返回 → `remember_published()` 写入进程内可信集合（上限 256）；
  单纯读取 `line.json`、展示当前地址或手动探测都不会加入该集合。

## 约束与失败行为

- 镜像发现完全在 QuickJS 沙箱内执行，受 `host.fetch` 白名单（`origins` + `publishOrigins`）、
  禁止受限头、逐跳重定向检查与单次调用超时限制；Rust 只接收归一化后的纯 HTTPS origin 列表。
- 线路必须是纯 HTTPS origin。`normalize_base()` 拒绝路径、查询、片段、认证信息和普通内网/
  回环地址；`FakeIP` 的 198.18/19 段由网络策略单独处理。
- 全部线路不可用时不得返回一个“可切换”的地址；`all-down` 必须保留当前线路，避免把可用会话
  切到无效或未验证地址。
- 自动选线不持久化“候选信任”。只有激活源 `discoverMirrors` 返回后才更新 `TRUSTED_MIRRORS`；
  持久化文件、探测结果和 UI 推荐都不能替代这一步。
- 镜像未获信任导致的登录态不可用或自动重登失败不是网络错误：严格模式下未通过 `discoverMirrors`
  确认的镜像无法继承旧线路会话（`reconcile_on_boot` 保持原绑定、401 `verify_relogin_origins`
  拒绝跨线自动重登），`optional_token()` 也不向其附带可选凭据；应提示用户切回默认线路或重新刷新
  镜像列表（或手动重新登录），不要清空本地收藏/历史来“修复”。
- 账号 401 的自动重登必须携带预期账号与线路。若当前线路已变化，或保存凭据来自不同且不互信的线路，
  后端不发送凭据；即使重登接口成功，身份或会话代次不符也不写回原会话。
- 启动时镜像发现超时不清本地登录态：若本地会话已绑定当前线路，`app_boot` 的
  `boot_credentials_visible()` 仍返回登录态；同时 `optional_token()` 在严格模式下仅向
  `trusted_auth_origin()` 放行可选凭据（`net/edge.rs` 仅负责媒体字节下载，不处理凭据），
  用户可通过刷新镜像列表（`line_mirrors` 调用 `discoverMirrors`）在当前进程恢复可信镜像集合。
- 线路保存失败要保留原线路并返回错误；不能先改内存再报告成功。写文件采用临时文件 + rename，
  避免半截 JSON。

## 验证命令

```sh
cargo test --manifest-path src-tauri/Cargo.toml --lib
node scripts/test-line-selection.mjs
pnpm test:smoke
```

[`src-tauri/src/lines/mod.rs`](../../src-tauri/src/lines/mod.rs) 与 [`src-tauri/src/source/mod.rs`](../../src-tauri/src/source/mod.rs) 的单元测试覆盖域名规范化、
`no-source` / `all-down`、健康判据、候选排序与沙箱镜像白名单；`test-line-selection` 覆盖前端自动选线状态。
真实上游镜像的可达性属于外部状态，测试不请求上游网络；实机结果需单独记录。
