import { createRoot } from "react-dom/client";
import { AppProvider, useStore } from "../src/shared/model/store";
import Category from "../src/features/category/Category";
import "../src/index.css";

function StackProbe() {
  const { stack } = useStore();
  return <div data-test-stack={stack.map(page => page.kind).join("|")} />;
}

createRoot(document.querySelector("#root")!).render(
  <AppProvider>
    <Category wide={false} active={true} />
    <StackProbe />
  </AppProvider>,
);
