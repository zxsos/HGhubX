import { createRoot } from "react-dom/client";
import { AppProvider } from "../src/shared/model/store";
import { PostDetail } from "../src/features/posts/Posts";
import { ToastHost } from "../src/shared/ui/ui";
import "../src/index.css";

const post = {
  id: 1,
  title: "示例帖子",
  cover: "https://fixture.invalid/cover.jpg",
  tags: ["都市"],
  hot: 1200,
  content: "<p>这是用于验证提示槽的帖子正文。</p>",
  counts: { like: 3, comment: 2, collect: 1 },
  publish_time: "2026-11-19 10:00",
};

Object.assign(window, {
  __TAURI_INTERNALS__: {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback() { return 0; },
    unregisterCallback() {},
    invoke(cmd: string, args: Record<string, unknown> = {}) {
      if (cmd === "app_boot") return Promise.resolve({ user: null, logged_in: false, strict_security: true, base: "https://fixture.invalid" });
      if (cmd === "playback_log_status") return Promise.resolve({ enabled: false, path: null, error: null });
      if (cmd === "debug_log") return Promise.resolve();
      if (cmd === "api_post") return Promise.resolve({ ...post, id: Number(args.id) || 1 });
      if (cmd === "api_post_like" || cmd === "api_post_collect") return Promise.resolve({ ok: true });
      return Promise.resolve(null);
    },
  },
});

createRoot(document.querySelector("#root")!).render(
  <AppProvider>
    <PostDetail id={1} onBack={() => {}} active />
    <ToastHost />
  </AppProvider>,
);
