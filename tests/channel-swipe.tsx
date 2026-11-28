import { createRoot } from "react-dom/client";
import { AppProvider } from "../src/shared/model/store";
import { ChannelPage, CHANNELS } from "../src/features/category/Category";
import "../src/index.css";

const params = new URLSearchParams(location.search);
const cate = params.get("cate") || "featured";
const name = params.get("name") || CHANNELS.find(channel => channel.cate === cate)?.name || cate;

createRoot(document.querySelector("#root")!).render(
  <AppProvider>
    <ChannelPage cate={cate} name={name} onBack={() => {}} wide={false} />
  </AppProvider>,
);
