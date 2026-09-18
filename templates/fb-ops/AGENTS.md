# FB Ops

Read-only platform operations micro app for FutureBuild Cloud. One operator
job: surface platform facts. Capabilities are `defineAction()` calls, read-only
first; write-capable actions (restarts, backup runs, promotions) land only
behind an explicit approval gate.

## Surface

The public root is the dashboard: FB Console health per environment and this
app's runtime facts. The shared agent chat can call every action as a tool.
There is deliberately nothing else: no settings surface, no threads, no
extensions.

## Core Rules

- UI feedback: target 100 ms, never exceed 400 ms; acknowledge before network work.
- Never hardcode API keys, tokens, webhook URLs, signing secrets, private Builder/internal data, customer data, or credential-looking literals. Use secrets/OAuth/runtime configuration and obvious placeholders in examples.
- For external integrations, inspect the workspace/provider connection catalog first; reuse its scoped resolver.
- Follow the root framework contract: data in SQL, actions first, application state for navigation/selection, and shared agent chat for AI work.
- All fb-ops actions are read-only in v1. Say so when a write is requested; do not improvise one.
- Never fabricate. If an action fails or an environment is not found, say so and recover instead of inventing a result.

## Source Changes

Before building common workspace or agent UI, read `agent-native-toolkit`; read
`customizing-agent-native` before adapting shared UI.

## Actions

- `console-health`: probes the production and staging FB Console APIs. A guest
  call answering with the 401 scope JSON is the documented healthy signal.
- `runtime-info`: this process's app id, Node version, and uptime.

Planned read-only actions over FB Deploy, the DO account, and backup state
arrive with their credentials; the write actions stay gated.

## Conventions

Follow the workspace AGENTS.md. Actions live one per file in `actions/`; the
filename is the action name. UI reads go through `useActionQuery`. No secrets
in source; provider credentials arrive through the vault or deploy env, never
`process.env` in app code.
