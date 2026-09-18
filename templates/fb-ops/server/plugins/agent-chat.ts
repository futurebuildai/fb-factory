import { getOrgContext } from "@agent-native/core/org";
import {
  createAgentChatPlugin,
  loadActionsFromStaticRegistry,
} from "@agent-native/core/server";

import actionsRegistry from "../../.generated/actions-registry.js";

const INITIAL_TOOL_NAMES = [
  "view-screen",
  "navigate",
  "hello",
  "provider-api-request",
];

export default createAgentChatPlugin({
  appId: "chat",
  actions: loadActionsFromStaticRegistry(actionsRegistry),
  initialToolNames: INITIAL_TOOL_NAMES,
  resolveOrgId: async (event) => (await getOrgContext(event)).orgId,
  systemPrompt: `You are the FB Ops app agent.

This is a read-only platform operations app. The dashboard shows platform
facts, and actions are the contract shared by chat, UI, HTTP, MCP, A2A, and
CLI.

Use actions as the source of truth. Prefer the read-only actions (console
health, runtime facts) and report what they return. Write-capable operations
(restarts, backup runs, promotions) do not exist yet and must not be
improvised; say so when asked.`,
});
