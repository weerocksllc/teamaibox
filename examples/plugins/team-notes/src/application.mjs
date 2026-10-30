import { createDelegatedPlatformClient } from "../../../../packages/plugin-sdk/src/delegated-client.mjs";

export function createTeamNotesApplication({ baseUrl, tokenProvider, fetchImpl }) {
  const client = createDelegatedPlatformClient({
    baseUrl,
    pluginId: "example.team-notes",
    tokenProvider,
    fetchImpl,
  });
  return Object.freeze({
    async listNotes(teamId) {
      return client.request({
        scope: "files:read",
        resource: { kind: "team", key: teamId },
        operation: "files.list",
        body: { path: "/notes", pageSize: 50 },
      });
    },
  });
}
