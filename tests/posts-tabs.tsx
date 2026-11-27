import { createRoot } from "react-dom/client";
import { AppProvider } from "../src/shared/model/store";
import { PostsPage } from "../src/features/posts/Posts";
import "../src/index.css";

createRoot(document.querySelector("#root")!).render(
  <AppProvider>
    <PostsPage onBack={() => {}} wide={false} />
  </AppProvider>,
);
