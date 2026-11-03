# Assistant extensions

Open **AI Assistant → Assistant settings** to configure extensions for your
account. OpenCode runs them inside your own container. Other users have separate
settings, sessions and credentials.

## Model providers

In **Assistant settings → Provider**, select a provider and save its API key,
or select an available sign-in method. Follow the provider's authorization link
and enter a code if requested, then finish sign-in. **Disconnect account** removes
the saved native credential. Adding a credential does not change your selected
model or silently redirect requests to a cloud provider.

Credentials are stored by OpenCode in your own container. The browser does not
save keys or authorization codes in local storage. A provider can require its
own account, network connection or subscription. Only use providers you trust.

## MCP servers

For a local server, choose **stdio** and enter its command as a JSON array, for
example `["node", "/workspace/tools/server.mjs"]`. The program and its dependencies
must be installed in your workspace, not on the appliance host.

For a remote server, choose **HTTP** and enter the server's MCP URL. Save the
configuration, then use **Sign in** if the server requires OAuth. Complete the
provider's authorization in the new window. The Assistant displays the native
connection status when you return. **Disconnect account** removes the native
authorization; the checkbox enables or disables the saved server configuration.

Remote services require network access and may require their own account.
Configuration is persistent; an enabled server can still be unavailable if its
program, dependencies, network or authorization are unavailable.

## Skills

Place a Skill in your container's native configuration directory:

```text
/workspace/.teamaibox/config/opencode/skills/my-skill/SKILL.md
```

A minimal Skill contains a name, description and instructions:

```markdown
---
name: my-skill
description: Summarize the selected project documentation
---
Read the project documentation and summarize the setup and usage instructions.
```

Open **Skills** to read its description, location and instructions. Select its
command, add any input, choose an Agent/model if needed, and send. OpenCode loads
and executes the Skill; the Assistant does not run a separate Skill engine.

Install the tools required by the Skill inside your container. Missing programs
and other execution failures appear in the native tool details; model/provider
errors appear in the conversation. A listed Skill does not mean every external
dependency is installed. Review permission requests before allowing actions.

## Agents, instructions and commands

In **Assistant settings**, expand **Custom agent / Command** to save native
prompts and command templates. A custom Agent can be enabled or disabled and
assigned a native primary/subagent/all mode. Primary and all-mode Agents appear
in the conversation selector; subagents are available to the native engine.

**Project instructions** accepts native instruction paths or URLs, one per line.
Paths refer to files inside your container. Use local files for offline use.
**Plugins** accepts native package specifiers or file URLs; external packages
may need downloads and dependencies. Installing a plugin gives its code access
inside your user container: only install extensions you trust.

Platform-managed model/network restrictions remain in effect. Adding an
extension does not grant access to the host, another user's workspace or the
appliance administrator's credentials.

## Connecting a future box service

See the [read-only service example](../../examples/assistant/box-status-mcp/README.md)
for an official-SDK MCP server and an optional Skill. It uses a user-scoped
credential file, a fixed read-only API operation and native tool permissions.
The API contract is illustrative, not an installed Penpot or phone integration.
Service-side scope checks and revocation remain mandatory.

User-installed plugins and local MCP programs execute as your container user.
They can read files available to that user, including your native credential
storage. Install only trusted extensions; native permission prompts are not a
separate secret vault or an isolation boundary between your own extensions.
