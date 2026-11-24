import { createRoot } from "react-dom/client";
import { AppProvider } from "../src/shared/model/store";
import { UserPage } from "../src/features/account/User";
import "../src/index.css";

createRoot(document.querySelector("#root")!).render(
  <AppProvider>
    <UserPage id={7} name="示例作者" onBack={() => {}} wide={false} />
  </AppProvider>,
);
