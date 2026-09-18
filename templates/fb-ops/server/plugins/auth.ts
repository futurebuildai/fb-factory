import { createAuthPlugin } from "@agent-native/core/server";

const rawAppTitle = "{{APP_TITLE}}";
const appTitle = rawAppTitle === "{" + "{APP_TITLE}}" ? "FB Ops" : rawAppTitle;

export default createAuthPlugin({
  workspaceAppPublicPaths: ["/"],
});
