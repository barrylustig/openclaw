import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createKagiWebSearchProvider } from "./src/kagi-search-provider.js";

export default definePluginEntry({
  id: "kagi",
  name: "Kagi Plugin",
  description: "Bundled Kagi web search plugin",
  register(api) {
    api.registerWebSearchProvider(createKagiWebSearchProvider());
  },
});
