# Feed 与详情

## 责任与边界

Feed 负责列表播放页的条目位置、详情/帖子读取、标签门、详情/评论/选集面板、
相关推荐和动作上下文；详情子组件只消费已经归一化的 `Detail`/`Post` 数据。
播放器的媒体生命周期、seek 和 HLS 恢复归 [playback.md](playback.md)；
线路、代理、账号凭据分别归各自的子系统页。

## 事实来源

- [`src/features/feed/Feed.tsx`](../../src/features/feed/Feed.tsx)：`requestPlay`、
  `useFeedDetails` 的调用、`tagKey`/`permissionKey`、`effectiveVideoIds`、
  `details`/`posts`、`relatedByVideo`、`actionContext`；视口/手势/动作与界面覆盖层分别位于同目录的
  [`useFeedViewport.ts`](../../src/features/feed/useFeedViewport.ts)、
  [`useFeedTouchGestures.ts`](../../src/features/feed/useFeedTouchGestures.ts)、
  [`useFeedActions.ts`](../../src/features/feed/useFeedActions.ts)、
  [`FeedItemChrome.tsx`](../../src/features/feed/FeedItemChrome.tsx)、
  [`FeedPlayerShellChrome.tsx`](../../src/features/feed/FeedPlayerShellChrome.tsx)。
- [`src/features/feed/useFeedDetails.ts`](../../src/features/feed/useFeedDetails.ts)：
  `detailRequests`、`requestDetail`、`effectiveVideoIds`、`detailsRef`。
- [`src/features/feed/Panels.tsx`](../../src/features/feed/Panels.tsx) 的
  `CommentsPanel`、`EpisodesPanel`、`ArticlePanel`；
  [`src/features/feed/VideoDetailsPanel.tsx`](../../src/features/feed/VideoDetailsPanel.tsx)。
- [`src/features/posts/Posts.tsx`](../../src/features/posts/Posts.tsx) 的 `PostDetail`：
  图文详情的正文/播放数据 effect 与线路事件下的后台刷新。
- [`src/features/category/Category.tsx`](../../src/features/category/Category.tsx)：
  `Category`、`ChannelPage` 与频道能力/声明驱动逻辑。
- [`src/features/authors/authorDirectory.ts`](../../src/features/authors/authorDirectory.ts)：
  作者目录加载（`api.popularAuthors`）与关注列表缓存。
  [`SearchAuthors`](../../src/features/authors/SearchAuthors.tsx) 的热门作者只负责打开主页；
  关注/取消关注的长按入口只保留在 [`AuthorsPage`](../../src/features/authors/AuthorsPage.tsx) 的作者列表与已关注列表。
- [`src/shared/model/store.tsx`](../../src/shared/model/store.tsx) 的 `lineEpoch` 和 `accountScope` 传递；
  [`src/shared/model/store.tsx`](../../src/shared/model/store.tsx) 暴露的 `accountGeneration` 与
  [`src/shared/model/accountData.ts`](../../src/shared/model/accountData.ts) 的 `generation`；
  [`src/shared/model/contentPreferences.ts`](../../src/shared/model/contentPreferences.ts) 的 `blockReason`。
- 切换视频源时，`lineEpoch` 在 `api.sourceState()` 返回新快照后与 `sourceState` 同批推进；`MainTabs` 以活动源 id 作为首页、搜索、分类的 `key`，切源后重新挂载。
- 后端读取：[`src-tauri/src/api/feed.rs`](../../src-tauri/src/api/feed.rs)、
  [`src-tauri/src/api/video.rs`](../../src-tauri/src/api/video.rs)、
  [`src-tauri/src/api/interact.rs`](../../src-tauri/src/api/interact.rs)、
  [`src-tauri/src/authors.rs`](../../src-tauri/src/authors.rs)（全部委托 [`src-tauri/src/source/mod.rs`](../../src-tauri/src/source/mod.rs) 当前激活的视频源插件）。

## 主运行时路径

1. Feed 使用 `api_feed`/分类/搜索/list page 传入的 `videoIds`，不自行重新请求列表；
   首页 [`src/features/feed/Home.tsx`](../../src/features/feed/Home.tsx) 与
   [`src/features/feed/homeRandom.ts`](../../src/features/feed/homeRandom.ts) 按源缓存已知总页数
   （`STORAGE_KEYS.homePages` / `hghubx_home_pages_v1`），在默认首页（页池上限 120 页）与置顶标签
   （`pinnedTags` 非空时每标签页池上限 40 页、并发上限 4 调用 `api.tagVideos`）均构建去重随机页码队列，
   优先展示近期未看过的新条目并避开连续重复首抽页；首次未知总页数时仍只发第 1 页请求，随机页为空时
   自动回退第 1 页；再次点击已激活的「首页」导航项派发 `hg:home-refresh` 换一批推荐（失败保留当前列表与页码队列）；
   请求作用域包含 `accountScope`、`lineEpoch` 与 `pinnedKey`，旧作用域在途结果一律丢弃。
   当前条目由 `position` 与 `effectiveVideoIds` 锚定；列表变化时优先保持正在播放的 id，
   找不到才取相邻可见项。
2. 详情读取走 `useFeedDetails.requestDetail(id)`。single-flight key 是
   `` `${accountScope}:${lineEpoch}:${id}` ``，最多保留 12 个进行中 Promise；
   成功结果放入组件内 `details: Record<number, Detail>`，失败不写入成功缓存。
3. 帖子读取走 `api.post(id)`，结果进入 `posts: Record<number, Post>`。Feed 的
   标签门、正文入口和播放界面从同一个 `Post` 归一化视图读取。
4. 标签门只在 `filtering` 时成为媒体闸门：
   `filtering = !preferences.paused && (blockedTags.length > 0 || hideUntagged)`。
   需要读取的候选是当前项以及前后各一项；普通模式只读当前项。
5. 标签门的键是 `` `${accountScope}:${lineEpoch}:${kind}:${id}` ``。
   `checked` 只在成功响应后置 true；`tagErrors` 保留可重试错误。
   失败不会把标签当成空数组；启用过滤时，读取失败继续阻止媒体请求。
6. `allowed = !filtering || (tagsReady && !blocked)`：普通模式直接允许；启用过滤时，
   必须成功读取标签且 `blockReason` 为空才允许。`allowed` 之前不请求播放地址；
   在首页被屏蔽时通过 `onBlocked` 跳过，在上下文播放页则关闭面板。
7. `requestPlay(id, episode)` 的 key 是
   `` `${accountScope}:${lineEpoch}:${id}:${episode}` ``，最多缓存 12 个 Promise。
   当前集开始播放后，才预取下一集的地址；下一部视频还要先通过详情/标签检查。
8. 评论面板使用 `api.comments` 或 `api.postComments`（仅视频开放评论发送，帖子评论只读，
   不向视频评论接口串写），选集使用当前 `detail.episodes`，
   详情面板显示作者/标签/相关推荐。桌面端停靠 `desktop-dock-panel`，移动端使用
   `Sheet`；面板本身不在 Feed 之外维护第二套详情缓存。
9. 相关推荐只在 `panel === "detail"` 时调用 `api.related`，缓存键是
   `` `${lineEpoch}:${curId}` ``。它不是首播前的预取，避免和视频地址争网络。
10. 动作使用 `actionContext = { accountScope, lineEpoch, id, ep, kind }`。
    请求返回后，`actionIsCurrent()` 再比较这五个字段；旧账号/旧线路/旧集数的结果
    不弹 toast、不更新视觉反馈。动作 pending key 也带 `accountScope`。

## 状态转换

- 条目切换：更新 `position`/`renderIndex` → 清理标签菜单和面板 → 重置播放 key →
  按新 key 读取详情/标签 → 允许后才请求播放地址。活跃条目的手势 overlay 在整个切集
  过渡期常驻：新集地址未解析（`playUrl` 为空）时 overlay 内部渲染封面而不是卸载，
  保证连续上下划继续切集，不会落到可滚动列表上切到别的视频。
- 标签门：未读 → loading → `checked=true`（再按 `blockReason` 判断）或 `tagErrors`（显示重试）；
  启用过滤时依据结果放行媒体；设置或账号/线路变化会使旧键失效并重新判断。
- 过滤结果：`effectiveVideoIds` 先按 `checked`/`tagErrors`/`blockReason` 过滤；
  正在播放项被移除时锚定相邻项，避免列表突然跳回第一屏。
- 详情加载：`requestDetail` 进行中 → 成功写入 `details` 和 `detailsRef` →
  面板可见；失败保留已有对象，不把 `undefined` 写成“无标签”。
- 动作：用户点击 → pending → 成功更新本地收藏/喜欢/关注 → 若上下文仍匹配才反馈；
  失败只提示错误，不凭空翻转状态。

## 约束与失败行为

- [创作者主页](../../src/features/account/User.tsx)按当前登录账号 ID 判断是否为本人；
  本人主页隐藏「关注」，并在处理关注操作前拦截本人目标。其他创作者主页仍可关注或取消关注。
- `details`/`posts` 是 Feed 实例的局部状态，不是跨应用持久缓存；页面销毁后重新读取。
  这避免把旧标签或旧正文带进新会话，但也意味着返回 Feed 时可能重新请求。
- 详情读失败不能标记 `checked`，不能把 `tags` 当空数组；启用过滤时不能让播放器抢跑。
  标签门重试会删除对应 `tagErrors` 并增加 `proxyRetry`。
- `useFeedDetails.requestDetail` 的 key 按账号/线路隔离、去重进行中的请求，本身不校验响应
  是否仍可写入。详情/标签 effect 返回后检查组件仍挂载及 `actionContext` 的账号/线路；
  动作返回后另由 `actionIsCurrent()` 校验完整动作上下文，防止旧结果更新当前反馈。
- 标签过滤不是内容搜索：`normalizeTag` 只做大小写/空白归一，不做模糊匹配；
  未知标签按 `hideUntagged` 处理。
- 相关推荐不做后台无限预取；关闭详情面板或切换条目不会删除 `relatedByVideo` 中的旧键。
  缓存留在当前 Feed 实例，读取按 `lineEpoch:curId` 隔离，不把旧线路键当作当前结果。
- 评论/选集面板只在 `active` 且 `allowed` 时保持开放；被覆盖时关闭，不阻塞返回键
  或下层 Feed。
- 手势 overlay 的挂载只取决于条目是否活跃，不取决于 `playUrl` 是否已解析；否则切集
  过渡期的触摸会被列表原生滚动吃掉（2.2.0 反馈的连划跳视频根因）。
- 标准版「我的」卡片支持电脑右键、手机长按进入多选，继续点按切换选择，并可通过批量栏「全选」选中当前分栏全量记录（含未滚入视口的分页）；收藏页逐项取消收藏，历史页按选中范围调用 `clearHistory()` 或 `removeHistory()` 删除记录。批量操作需确认，切换收藏/历史或视频/帖子会清空选择；
  收藏部分失败时保留失败项供重试，未选中的观看记录和收藏互不影响。批量取消收藏在开始时捕获
  `accountGeneration` 与 `actionRevision`；每项请求前后都校验二者，线路/代理事件或组件卸载会使修订号失效，
  随即停止未发送项并抑制旧批次的错误、完成状态与 toast。账号代次检查独立于组件重挂载，避免 cleanup
  执行前队列继续用新账号发起下一项。
- 分类与频道列表由当前激活视频源能力及可选声明驱动（[`src/features/category/Category.tsx`](../../src/features/category/Category.tsx)、[`src/tv/BrowsePage.tsx`](../../src/tv/BrowsePage.tsx)）：若 `activeSource.catalog.channels` 声明了频道，按 `ch.kind === "post" ? capabilities.posts : capabilities.catalog.categories` 过滤后渲染（`kind: "post"` 走 `api_post_category`，否则走 `api_category`）；未声明或过滤后为空且 `capabilities.home` 为 `true` 时，回退为默认「推荐发现」频道（`__feed__`，走 `api_feed`）；当 `capabilities.posts` 为 `true` 且未声明帖子频道时追加默认「图文帖子」预览。服务端排序胶囊仅在 `channel.sorts` 非空时展示，具体数据抓取或解析全部由激活源插件的 `category`（或帖子分类 `postCategory` / 首页 `home`）实现；`sorts` 项可以是字符串 key，也可以是 `{ key, name, default? }`，后者用 `name` 显示、用 `key` 请求，数组顺序即 tab 顺序；带 `default: true` 的项为默认选中项，未标记时选中第一项。Rust 壳不内置站点 slug 或 CSS 选择器（`api_original_videos` 仅作向后兼容 IPC 保留，当前页面不再调用）。
- 分类总览的每个频道区块标题行只有右侧「全部」按钮可点击；图标、标题和空白区域不响应指针事件，避免纵向滚动时误触进入频道页。
- 频道页（非 `__feed__`）与标签结果页支持指标排序（`VideoSortMenu` / `sortVideosByMetric`）：频道页在分类/排序胶囊行右侧、标签页在「视频 N」标题行右侧显示排序入口；默认态只显示排序图标，选择后控件变为「指标 + 方向箭头」胶囊（↓ 从多到少、↑ 从少到多），菜单保留「默认排序」项用于恢复；再次点击当前指标会反转方向，菜单保持展开。切换到指标排序时通过 `api_category` 的 `jsonOnly` 选项交给激活源跳过耗时解析（若源实现区分），以每页 100 条抓取完整结果（最多 30 页），按列表返回的 `like_count` / `collect_count` / `hot` / `score` 先按所选方向稳定排序再以 20 条渐进渲染；在频道 tab 间切换时保留当前指标并按新 tab 重新排序。指标排序只作用于视频列表，不影响标签页图文帖子。
- 排行榜读取（`api_rank`）直接委托激活源插件的 `rank` 方法，受 `capabilities.catalog.rankings` 门控，保持 `{ type, items: RankItem[] }` 契约不变。
- 搜索页热搜榜读取（`api_search_hot`）直接委托激活源插件的 `searchHot` 方法；前端 [`src/features/search/Search.tsx`](../../src/features/search/Search.tsx) 使用单行左右紧凑布局（序号 + 单行省略标题 + 右对齐热度文本 + 右箭头），移动端无卡片底色、宽屏（`>= 560px`）保持双列紧凑卡片。
- 搜索页热门题材/标签读取（`api_hot_tags`）直接委托激活源插件的 `hotTags` 方法，受 `capabilities.catalog.tags` 门控；前端 [`src/features/search/SearchTags.tsx`](../../src/features/search/SearchTags.tsx) 严格保留 `api.hotTags()` 返回集合与顺序，不混入全量 `api.tags()`，屏蔽过滤与每批 `BATCH_SIZE = 10` 个「换一批」均只在该热门集合内生效。
- 搜索页复位（[`src/features/search/Search.tsx`](../../src/features/search/Search.tsx)）：提交查询后，点底栏当前「搜索」tab 与点输入框右侧 X 等效，统一清空查询与结果、回到热搜/历史态并滚回顶部；底栏触发不重新聚焦输入框，避免大屏单手操作时软键盘再次弹出。
- 标签视频列表（`api_tag_videos`）向激活源 `tagVideos` 透传 `{ tag, page, size, sort }`（标准版与 TV 端标签页默认按需传 `"latest"`，切换指标或明确请求时按对应方式处理）。
- 标签聚合页（`TagsPage`）顶部提供「置顶标签」板块；长按标签 600ms 切换置顶，再次长按取消，点击仍进入对应标签结果页。置顶项保存到内容偏好 `pinnedTags`（最多 24 个，按最近置顶优先），刷新或重启后保留；普通点按不会误置顶，横向拖动超过 10px 会取消长按。置顶板内的标签只显示名称，不使用高亮边框；分类分组内的已置顶标签保留高亮外框，但不再追加 pin 图标。分类分组经 [`src/features/discover/useNonEmptyTags.ts`](../../src/features/discover/useNonEmptyTags.ts) 的 `loadTagDirectory` 采用与作者目录一致的缓存模式：首次进入在渲染前按并发 6 过滤确认无作品标签（未直出 `video_count` 时探测 `api.tagVideos(name, 1, 1)`，视频为 0 且当前源开启 `capabilities.posts` 时再查 `api.postTag(name, 1, 1)` 保留纯图文标签；探测失败按「未知不是空」保留，同时过滤空分组），全量探测完成后按 `${sourceId}:${lineEpoch}` 写入 `STORAGE_KEYS.tagsCache`（`hghubx_tags_cache_v1`），后续进入直接复用缓存不闪烁；点击右上角「刷新」强制重新拉取并全量重探（刷新期间保留现有列表，失败不清空缓存）。搜索页热门标签不受影响。
- 标签结果页（`TagPage`）标题栏右侧提供同一置顶开关：pin 占原搜索按钮槽位，与左侧标签图标垂直居中对齐；未置顶和已置顶都使用同款圆形强调底，仅针尖朝向不同（未置顶斜向、置顶后针尖向下）。原搜索图标与页脚搜索入口已移出该页，从首页视频标签、详情页标签等直接进入时也能置顶。
- 图文帖子列表（[`src/features/posts/Posts.tsx`](../../src/features/posts/Posts.tsx) 的 `PostsPage`）先调用 `api.postCategories()` 获取可选帖子分类胶囊，并过滤掉 `route === "all"` 或名称为「全部」的伪分类（该分类由旧版前端追加，不由源提供）。分类就绪后默认选中源返回的第一个真实分类，而不是全量列表；只有存在选中分类时才请求 `api_post_category(route, ...)`，不再调用 `api.posts()`。点击当前分类不会取消选中；列表滚动容器统一复用 [`src/shared/ui/hooks/useTabSwipe.ts`](../../src/shared/ui/hooks/useTabSwipe.ts) 支持触摸与鼠标横向滑动切换相邻分类（左滑下一个、右滑上一个），锁定主轴并抑制尾随 click，纵向滚动不受影响。数据抓取与分类列表完全由当前激活视频源插件驱动，客户端不内置站点分类 slug 或网页解析器。
- 分页列表（频道页、图文列表、专题/标签详情、关注/创作者作品与全局/栏目搜索）统一使用 [`src/shared/lib/useAutoLoadMore.ts`](../../src/shared/lib/useAutoLoadMore.ts)（`IntersectionObserver` + 滚动位置检查）在接近底部哨兵时自动加载下一页，正常态不再展示手动「加载更多」按钮；开启标签屏蔽时同样保持上滑自动加载，仅当连续 2 页过滤后均无可见条目（`AUTO_LOAD_EMPTY_PAGE_LIMIT = 2`）才暂停自动续载并显示手动「加载更多」兜底按钮，点击手动加载或调整筛选会重置计数。
- 视频卡片（[`src/shared/ui/cards.tsx`](../../src/shared/ui/cards.tsx) 的 `WaterfallCard` 与 `RowCard`）在海报左上角按「原创」「热播」「新片」（`new_at` 72 小时窗口）「完结」（`is_finished`）顺序显示角标，与右上角评分保持间距不遮挡；集数状态位于海报底部遮罩左侧（与播放量同排）：完结视频显示「全 N 集」（N 优先取 `total_episodes`，缺失时回退 `episode_count`），未完结仍显示现有的更新集数文案。「我的」页 `MediaCard` 不再重复显示绿色「已完结」封面标签，每张卡只保留一个左上角角标，并按当前分类切换：「未看完」中使用蓝色「未看 N 集」，「连载中」中使用「更新至 N 集」，「已完结」中使用「全 N 集」，`全部` 中按完结状态显示「更新至 N 集」或「全 N 集」；观看位置与进度继续由卡片左下角进度行表达。
- 标准版「我的」收藏与观看历史保持原有网格列数；滚动容器接近底部哨兵（提前 300px）时
  每次扩展 12 项，不再显示「加载更多」按钮。收藏页不再提供与下拉重复的「刷新收藏」按钮，下拉刷新提示块位于收藏列表区域顶部（`[data-favorite-refresh-region]`），手势触发限定在收藏列表区域内，资料卡区域下拉不触发刷新。
- 标准版「我的 → 收藏 → 视频」默认显示全部收藏并保持收藏顺序（按添加顺序）；右上角单个筛选图标展开「观看状态」菜单，提供「未看完」「连载中」「已完结」三个可以重叠的分类：`未看完` 显示所有 `最新集数 - 已看到集数 > 0` 的收藏，不管它已完结还是连载中（例如 10 集完结视频看到第 2 集即显示「未看 8 集」，从未看过则从第 1 集起算）；`连载中` 显示所有未完结收藏，即使其中还有未看集数；`已完结` 显示所有已完结收藏。三者均按 `updated_at`/`last_ep_at`/`created_at` 的最新更新时间倒序，时间相同按原收藏顺序稳定排序；选择分类后菜单收起，筛选胶囊内显示当前分类与数量；再次点击胶囊只收起/展开菜单，不回退筛选。要回到默认「我的收藏 / 视频 / 全部收藏」，再次点击底部「我的」导航（与搜索 tab 的复位手势一致），同时回到页面顶部。「视频 N」「帖子 N」显示该类型收藏总数，菜单中的「未看完 N」「连载中 N」「已完结 N」显示当前分类计数（同一部可同时计入未看完与连载中/已完结），底部「已显示 X / Y 项本机记录」的 Y 跟随当前分类结果，因此与对应计数一致。进入收藏视频页后按每批最多 6 部渐进补齐全部收藏详情以统计分类，未知详情不会被猜成未完结、已完结或未看完；默认态详情加载失败时提示分类计数可能不完整，筛选态则提示筛选结果可能不完整。播放列表随之按当前筛选顺序传给 Feed；同一激活期间已刷新的条目不重复请求，旧卡片与观看断点保留，刷新失败不将旧集数当空数据，离开页面或切线后丢弃在途结果。
- 图文详情（[`src/features/posts/Posts.tsx`](../../src/features/posts/Posts.tsx) 的
  `PostDetail`）区分「换帖子/账号」与「仅线路代次变化」：`hg:line-changed`/`hg:proxy-changed`
  （自动选线切换、保存代理）推进 `lineEpoch` 时，只有 `id`/`accountScope` 变化才清空重置；
  仅 `lineEpoch` 变化保留已显示的 `post`、正文与滚动位置，后台重拉 `api_post` 与
  `api_post_playback`，播放地址解析失败保留旧地址不清空。否则整页回加载态会卸载播放器
  portal，视频从 0 重播（issue #165）。
- 图文详情的正文仅在正文内容或安全模式改变时重新清洗。渲染时复用同一个
  `dangerouslySetInnerHTML` 属性对象；滚动更新「阅读进度」以及刷新得到同一正文时不替换
  图片节点，避免懒加载图片反复消失、重载和撑开布局（issue #165）。
- 图文正文链接拦截（[`src/shared/lib/html.ts`](../../src/shared/lib/html.ts) 的 `handleArticleClick` / `parseInternalVideoId` / `normalizeInternalVideoUri`、`PostDetail` 与 `ArticlePanel`）：`store.tsx` 启动/切线读取 `boot().base` 后同步 `setSiteOrigin`，点击正文 `<a>` 时仅放行并入栈站内 `feed` 播放页的内部链接（统一格式 `hg://video/{id}`，或匹配当前源声明的 `activeSource.links.videoIdPathPattern` 且命中 `activeSiteOrigin` / `activeSource.origins` 同源校验），其余外链与非规范路径仍交 `api.openUrl` 打开（失败回退剪贴板）。
- 播放页状态提示（上下划切集、剧集边界、上下划切集开关、屏幕锁定/解锁、双击暂停的当前集提示）统一带 `tag="playback-hint"`（`Feed.tsx`、`FeedPlayerShellChrome.tsx`、`useFeedTouchGestures.ts` 与 `useFeedViewport.ts`）；`store.tsx` 的
  `pushToastItem` 对同 tag 原地替换内容并重置 2200ms 计时，快速连续操作只显示一张最新卡片，
  不堆叠、不重放入场动画；双击暂停的当前集提示使用 `showStickyToast` 的零时长槽，由 `dismissToast` 在暂停图标消失时同步收起；无 tag 的普通 toast 仍按原逻辑堆叠（最多 3 张）。同剧同作用域（`permissionKey` 不变）切集过渡期内，
  `Feed.tsx` 沿用本剧最近一次已确认的宽高比例直到新集回传真实尺寸，避免 `.player-root` 丢掉 `.fs-landscape` 回退竖屏导致旋转舞台和已有提示卡片闪回竖屏位置（换剧、切账号/线路或改过滤规则仍立即清零；首次进入全屏尚无已确认宽高时继续由 `pendingEpisodeToast` 等待解码）；`ToastHost` 通过 `registerRotatedToastHost` 在绘制前响应式同步 `.fs-landscape` 宿主与偏移，进出全屏不滞留旧坐标。桌面端开启「上下划切集」或处于全屏时，
  `useFeedViewport` 在播放区滚动容器上注册非被动 `wheel` 监听（`{ passive: false }`），按位移阈值与冷却时间将
  滚轮/触控板纵向滚动转为单步 `stepDir`，避免浏览器原生纵向滚动直接切到下一部剧；底部控制栏「下一集 ↓ / 下一部 ↓」
  按钮同样遵循 `swipeEp` 开关。
- 详情/选集双栏抽屉滑动与横屏旋转态（[`src/features/feed/PanelSwipeArea.tsx`](../../src/features/feed/PanelSwipeArea.tsx)、[`src/features/feed/FeedPlayerShellChrome.tsx`](../../src/features/feed/FeedPlayerShellChrome.tsx)、[`src/index.css`](../../src/index.css)、[`src/styles/video-details.css`](../../src/styles/video-details.css)）：`PanelSwipeArea` 接入 `rotated`（并兜底检测 `.fs-landscape` 祖先）把 90° 顺时针旋转舞台的屏幕位移换算回面板局部坐标（`dx = rawDy, dy = -rawDx`），锁定主轴方向、横向切 tab 时 `preventDefault()` 并抑制尾随 click，`touchcancel` 中止手势不误切；右侧横屏抽屉传 `allowPullDownClose={!landscapeStage}` 防止顶部下滑误关。在 `.fs-landscape` 下 Chromium 按物理轴评估 `overscroll-behavior` 与单轴 `overflow-*-hidden`，因此 `.fs-landscape .scroll-x` 与 `.fs-landscape .current-video-tags` 对调为 `overscroll-behavior-x: auto; overscroll-behavior-y: contain`，且不给 `.scroll-y`/`.scroll-x` 加反轴 `overflow-*-hidden`，确保详情滚到「相关推荐」后仍可流畅回滑且横向轮播正常。
- 帖子与评论时间戳归一化（[`src/shared/lib/time.ts`](../../src/shared/lib/time.ts) 与 [`src/features/posts/postData.ts`](../../src/features/posts/postData.ts)）：`formatTimestamp` 仅接受 `2000-01-01` 至 `Date.now() + 5 分钟` 窗口内的有效日历时间，对 Unix 秒/毫秒、ISO-8601（含带空格时区偏移）、无时区本地日期时间、中文年月日、RFC-2822 与「N小时后」等未来相对文案均拒绝未来时间；`formatPostTime` 跳过未来 `publish_time` 自动回退 `created_at` 或隐藏无效占位。
- 弹出菜单与滑动手势交互守卫：全部 5 个弹出菜单（[`VideoSortMenu`](../../src/shared/ui/VideoSortMenu.tsx)、[`WorkStatusMenu`](../../src/features/account/WorkStatusMenu.tsx)、[`TagStatusMenu`](../../src/features/discover/TagStatusMenu.tsx)、[`Profile`](../../src/features/account/Profile.tsx) 收藏筛选菜单、[`PlayerControls`](../../src/features/playback/PlayerControls.tsx) 桌面倍速菜单）展开期间均注册 `registerOverlayBack` 并在 `document` 捕获阶段以 `stopImmediatePropagation()` 处理 `Escape`（被 `inert` 遮盖时不抢占，[`useInlinePlayerFullscreen`](../../src/features/playback/useInlinePlayerFullscreen.tsx) 在存在展开的 `[role="menu"]` 时优先让菜单收起再退出全屏），避免 `Escape` 或安卓返回键穿透退页/退全屏；[`useTabSwipe`](../../src/shared/ui/hooks/useTabSwipe.ts)、[`useRankSwipe`](../../src/features/search/useRankSwipe.ts)、[`PanelSwipeArea`](../../src/features/feed/PanelSwipeArea.tsx) 与 `Profile` 收藏下拉刷新在新的 `touchstart`/`pointerdown` 开始时立即清除上一次滑动遗留的 click 抑制窗口，`touchcancel` 统一中止手势而不提交切换或刷新。
- 桌面与移动版面及控件一致性（[`src/styles/ios.css`](../../src/styles/ios.css)、[`src/app/shell/DesktopChrome.tsx`](../../src/app/shell/DesktopChrome.tsx)、[`src/features/category/Category.tsx`](../../src/features/category/Category.tsx)、[`src/features/settings/Settings.tsx`](../../src/features/settings/Settings.tsx)）：`.ios-page` 按容器单位限宽 `clamp(720px, 92cqi, 960px)` 并去掉 `.ios-page-body` 非对称 `scrollbar-gutter`，保证桌面 1280px 列表与「我的」页统一 5 列对齐；分类页横向片架由 `ShelfRow` 统一承载（移动端通栏延展至屏幕边缘，桌面端提供右/左边缘渐隐与悬停左右翻页按钮），宽屏快捷入口收敛为单行均分；桌面侧栏在二级钻取页保留来源 tab 的 `is-ancestor` 高亮，根级「设置」「排行榜」隐藏冗余返回键；设置分组标题带图标与实时状态摘要，弹出菜单选中态满足 WCAG AA（≥ 4.5:1）对比度，全部抽屉关闭按钮统一 44px `ios-icon-button`。

## 验证命令

```sh
pnpm build
pnpm test:smoke
pnpm test:api-loading
pnpm test:post-flicker
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

`test:smoke` 当前包含 `api-loading`、`channel-autoload-badges`、`storage-migration`、`line-selection`、
`diagnostic-copy`、`ui-feedback`、`home-controls`、`account-sync` 与 `i18n`。账号切换期间批量取消收藏的
fixture 位于 `scripts/test-account-sync-empty-state.mjs`；需要单独运行时可执行
`node scripts/test-account-sync-empty-state.mjs`。浏览器 fixture 使用 mock Tauri IPC 且阻断外部请求，
不能证明真实上游的正文结构或账号接口；真实接口变化需要另加网络隔离的 fixture 或手动验证。
`test:post-flicker` 是图文详情线路/代理事件的回归（issue #165）：浏览器 fixture，
mock IPC，本地 ffmpeg HLS 分片，不访问上游；需要 ffmpeg，归入播放诊断
（`pnpm test:playback --scenarios post-flicker`，CI 的 core 分片），不进 smoke。
账号切换 fixture 会挂起第一项取消收藏请求，切换账号后再释放，并检查没有发送第二项、没有向新账号
写入旧结果或弹出旧批次成功提示；该回归随 `pnpm test:smoke` 的 `account-sync` 套件运行。
