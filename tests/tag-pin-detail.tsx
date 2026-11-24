import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { AppProvider, useStore } from "../src/shared/model/store";
import { ToastHost } from "../src/shared/ui/ui";
import { TagPage } from "../src/features/discover/Discover";
import "../src/index.css";

const tag = new URLSearchParams(location.search).get("tag") || "都市";

// Probe: expose the real toast API so the regression can verify the shared slot.
function Probe() {
  const { toast } = useStore();
  useEffect(() => { Object.assign(window, { tagPinToastProbe: { toast } }); }, [toast]);
  return null;
}

createRoot(document.querySelector("#root")!).render(
  <AppProvider>
    <TagPage tag={tag} name={tag} onBack={() => {}} wide={false} />
    <ToastHost />
    <Probe />
  </AppProvider>,
);
