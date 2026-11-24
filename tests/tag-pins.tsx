import { createRoot } from "react-dom/client";
import { AppProvider } from "../src/shared/model/store";
import { TagsPage } from "../src/features/discover/Discover";
import "../src/index.css";

createRoot(document.querySelector("#root")!).render(
  <AppProvider>
    <TagsPage onBack={() => {}} wide={false} />
  </AppProvider>,
);
