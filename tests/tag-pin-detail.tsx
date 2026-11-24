import { createRoot } from "react-dom/client";
import { AppProvider } from "../src/shared/model/store";
import { ToastHost } from "../src/shared/ui/ui";
import { TagPage } from "../src/features/discover/Discover";
import "../src/index.css";

const tag = new URLSearchParams(location.search).get("tag") || "都市";

createRoot(document.querySelector("#root")!).render(
  <AppProvider>
    <TagPage tag={tag} name={tag} onBack={() => {}} wide={false} />
    <ToastHost />
  </AppProvider>,
);
