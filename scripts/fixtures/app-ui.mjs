export function installFixture({ theme, titles, metrics = [], metricPages = 1, metricPageSize = 2, tagGroups = null, follows = [], finished = [] }) {
  const cards = titles.map((title, i) => ({
    id: i + 1, title, cover: `https://fixture.invalid/poster/${i}`, tags: ["都市", "剧情"], score: metrics[i]?.score ?? (i % 2 === 0 ? 8.5 : 0),
    episode_count: 24, total_episodes: 24,
    hot: metrics[i]?.hot ?? 286000, like_count: metrics[i]?.like_count ?? 1800, collect_count: metrics[i]?.collect_count ?? 900,
    comment_count: 20, is_finished: finished[i] ?? true, is_original: 0, description: "界面回归示例数据",
    author: { id: 1, name: "示例作者" },
  }));
  const topic = { id: 1, title: "本周精选", slug: "weekly", cover: cards[0].cover, intro: "城市与故事", video_count: cards.length };
  const paged = items => ({ items, pagination: { page: 1, pages: 1, size: 30, total: items.length } });
  const metricPaged = page => {
    if (metricPages <= 1) return paged(cards);
    const start = (page - 1) * metricPageSize;
    return {
      items: cards.slice(start, start + metricPageSize),
      pagination: { page, pages: metricPages, size: metricPageSize, total: cards.length },
    };
  };
  localStorage.setItem("hghubx_theme", theme);
  localStorage.setItem("hghubx_app_v1", JSON.stringify({ favs: [1, 2, 3, 4, 5, 6], follows, history: [{ id: 1, ep: 3, t: 55, dur: 180, at: 123 }], searchHist: ["都市"] }));
  localStorage.setItem("hghubx_swipe_ep_v2", "1");
  const callbacks = new Map();
  let nextCallback = 0;
  let authorDirectoryCalls = 0;
  // Real Tauri keeps every registered listener: the app shell and the launch
  // overlay can both listen for back-button, and unregister removes exactly one.
  const backChannels = new Map();
  window.__IOS_UI_FIXTURE__ = {
    hardwareBack() {
      if (!backChannels.size) throw new Error("Android back listener was not registered");
      for (const channel of [...backChannels.values()]) channel.onmessage({});
    },
    hasHardwareBack() { return backChannels.size > 0; },
  };
  window.__AUTHOR_DIRECTORY_CALLS__ = () => authorDirectoryCalls;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback(callback) { const id = ++nextCallback; callbacks.set(id, callback); return id; },
    unregisterCallback(id) { callbacks.delete(id); },
    async invoke(command, args = {}) {
      if (command === "app_boot") return { user: null, logged_in: false, strict_security: true, base: "https://fixture.invalid" };
      if (command === "playback_log_status") return { enabled: false, path: null, error: null };
      if (command === "line_auto") return { base: "https://fixture.invalid", previous: "https://fixture.invalid", switched: false, pick: { tier: "main", ms: 1, reason: "fixture", candidates: [] } };
      if (command === "api_feed") {
        if (args.size !== 100) return paged([]);
        authorDirectoryCalls += 1;
        const names = [
          "都市阿城", "古风小满", "悬疑老K", "甜宠七月", "逆袭阿岚", "校园小北", "职场安姐", "奇幻阿泽",
          "仙侠青禾", "现代老周", "脑洞小鹿", "都市阿梨", "反派阿川", "人间阿杏", "作者小满", "路人甲",
          "悬疑阿夏", "古风阿棠", "甜宠阿宁", "逆袭阿野", "校园阿星", "职场阿月", "奇幻阿岭", "仙侠阿松",
          "都市阿青", "古风阿兰", "悬疑阿秋", "甜宠阿夏", "逆袭阿成", "校园阿冬", "职场阿峰", "奇幻阿川",
          "仙侠阿海", "现代阿山", "脑洞阿云",
        ];
        const page = Math.max(1, Number(args.page) || 1);
        const size = 100;
        const total = 1892;
        const pages = Math.ceil(total / size);
        const start = (page - 1) * size;
        const count = Math.max(0, Math.min(size, total - start));
        const items = Array.from({ length: count }, (_, offset) => {
          const index = start + offset;
          const authorIndex = index % names.length;
          return {
            ...cards[index % cards.length],
            id: 10_000 + index,
            title: `作者目录视频 ${index + 1}`,
            author: { id: 100 + authorIndex, name: names[authorIndex], avatar: "" },
          };
        });
        return { items, pagination: { page, pages, size, total } };
      }
      if (["api_category", "api_original_videos", "api_search", "api_posts", "api_post_category", "api_tag_videos"].includes(command)) {
        return args.size === 100 ? metricPaged(args.page || 1) : paged(cards);
      }
      if (command === "api_topics") return paged([topic]);
      if (command === "api_topic") return { topic, videos: paged(cards), related: [] };
      if (command === "api_tags") return { categories: tagGroups ?? [{ name: "题材", tags: [{ id: 1, name: "都市", slug: "city" }] }] };
      if (command === "api_hot_tags") return { items: [{ name: "都市", slug: "dushi" }] };
      if (command === "api_user") return { id: args.id, username: `author-${args.id}`, nickname: "示例作者", avatar: "", counts: {} };
      if (command === "api_user_stats") {
        if (args.id >= 100 && args.id < 135) authorDirectoryCalls += 1;
        return {
          user_id: args.id, like_count: 178000, following: 0,
          followers: args.id >= 100 && args.id < 160 ? 1500000 - (args.id - 100) * 25000 : 1157,
          video_count: cards.length, post_count: 0,
        };
      }
      if (command === "api_user_videos") return args.size === 100 ? metricPaged(args.page || 1) : paged(cards);
      if (command === "api_rank") return paged(cards.map((card, index) => ({ ...card, rank: index + 1, video_id: card.id, metric_value: card.hot, metric_label: "热度" })));
      if (command === "api_search_hot") return paged(titles.map((title, index) => ({ video_id: index + 1, title, plays: `${550 - index * 10}.1w播放量` })));
      if (command === "api_video") return { ...cards[(args.id - 1) % cards.length], counts: { collect: 900, comment: 20, hot: 286000, like: 1800 }, episodes: [] };
      if (command === "api_login") {
        if (args.username === "profile-fixture") return { user: { id: 9, username: "fixture", nickname: "示例用户", avatar: "", avatar_color: "#63748b", counts: {} } };
        throw "账号或密码不正确";
      }
      if (command === "api_logout") return { ok: true };
      if (command === "security_set") return args.strict;
      if (command === "api_play") throw "UI fixture has no media";
      if (command === "plugin:app|register_listener" && args.event === "back-button") { backChannels.set(args.handler.id, args.handler); return null; }
      if (command === "plugin:app|remove_listener" && args.event === "back-button") { backChannels.delete(args.channelId); return null; }
      if (command === "plugin:window|is_maximized" || command === "plugin:window|is_fullscreen") return false;
      return null;
    },
  };
}
