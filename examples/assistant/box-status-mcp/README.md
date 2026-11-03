# Read-only box service example

This optional MCP server shows how a future Team AI Box service can connect to
the Assistant through OpenCode's native MCP support. It does not install Penpot,
control a phone, or add an Agent execution engine. The `/v1/status` endpoint below
is an example contract, not an existing appliance API.

Copy this directory into your own container's `/workspace/tools/box-status`, then
run `npm ci --ignore-scripts` there. The official MCP SDK version and integrity
values are pinned in the lockfile. This optional dependency must be installed or
provided offline before using the example.

The service behind the API must issue a short-lived, **read-only, user-scoped**
credential and enforce its scope on every request. Never use an appliance admin
token, model gateway key, Docker socket, another user's session or a host mount.
Store the credential at `/workspace/.secrets/box-status-token`, readable only by
your container user. Do not put the token in a Skill, prompt, command line or
repository. Revoking it on the service must take effect on the next request.

Add this entry through the Assistant's native JSON settings:

```json
{
  "mcp": {
    "boxStatus": {
      "type": "local",
      "command": ["node", "/workspace/tools/box-status/server.mjs"],
      "environment": {
        "BOX_API_ORIGIN": "https://your-authorized-service.example",
        "BOX_API_TOKEN_FILE": "/workspace/.secrets/box-status-token"
      },
      "enabled": true
    }
  }
}
```

OpenCode discovers `box_status` and presents its native permission request.
Rejecting that request must not call the service. The server performs only
`GET /v1/status`, disallows redirects, and filters the result to status fields.
Its read-only annotation is a hint; the service must still enforce authorization.
Disable the saved MCP entry to stop offering the tool. Future write-capable
Penpot or phone tools need separately scoped APIs and explicit permissions.

## Optional Skill

Place the following in your native Skills directory as
`box-status/SKILL.md`. It adds instructions, not credentials or new permissions.

```markdown
---
name: box-status
description: Summarize service availability through the configured box status tool
---
Use the configured box_status MCP tool to read service status. Summarize any
service that is starting or unavailable. Do not restart services, modify files,
or request administrator credentials. If access is denied, explain that the
user needs an authorized read-only connection.
```
