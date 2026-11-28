import { createRoot } from "react-dom/client";
import { AppProvider } from "../src/shared/model/store";
import { CommentsPanel } from "../src/features/feed/Panels";
import "../src/index.css";

const PAGE_SIZE = 20;
const PAGES = 3;
const commentPageCalls: number[] = [];

function commentsPage(page: number) {
  const start = (page - 1) * PAGE_SIZE;
  const items = Array.from({ length: PAGE_SIZE }, (_, offset) => {
    const n = start + offset + 1;
    return {
      id: n,
      nickname: `评论用户${n}`,
      text: `第 ${n} 条评论：这是一条用于验证上滑自动加载的示例评论，内容足够长以便产生可滚动区域。`,
      time: "刚刚",
      like_count: n % 7,
      reply_count: n % 3 === 0 ? 2 : 0,
    };
  });
  return {
    items,
    pagination: { page, pages: PAGES, size: PAGE_SIZE, total: PAGE_SIZE * PAGES },
  };
}

Object.assign(window, {
  __TAURI_INTERNALS__: {
    invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
      if (cmd === "app_boot") return { user: null, logged_in: false, strict_security: true, base: "https://fixture.invalid" };
      if (cmd === "source_state") {
        return {
          activeSourceId: "fixture-source",
          allowUntrusted: true,
          sources: [{
            id: "fixture-source",
            name: "Fixture Source",
            version: "1.0.0",
            description: "Comments autoload fixture",
            author: "Fixture",
            apiVersion: "1",
            runtimeKind: "quickjs",
            origins: ["https://fixture.invalid"],
            capabilities: {
              home: true,
              search: true,
              catalog: { categories: true, tags: true, rankings: true, authors: true },
              detail: { episodes: true, related: true, comments: true },
              playback: { hls: true, mp4: true, subtitles: true },
              posts: true,
              account: true,
              lines: true,
            },
            updateUrls: [],
            signature: { status: "unsigned", keyId: "", fingerprint: "" },
            installedAt: 0,
            active: true,
          }],
        };
      }
      if (cmd === "api_comments") {
        const page = Math.max(1, Number(args.page) || 1);
        commentPageCalls.push(page);
        return commentsPage(page);
      }
      return null;
    },
  },
  commentsAutoloadProbe: {
    calls: () => commentPageCalls.slice(),
  },
});

localStorage.setItem("hghubx_theme", "dark");

createRoot(document.querySelector("#root")!).render(
  <AppProvider>
    <div className="comments-probe feed-comments-sheet">
      <CommentsPanel videoId={1} ep={1} total={PAGE_SIZE * PAGES} kind="video" onClose={() => {}} />
    </div>
  </AppProvider>,
);
