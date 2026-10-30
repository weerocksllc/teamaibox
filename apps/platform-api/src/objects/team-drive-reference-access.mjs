import { PlatformError } from "../../../../packages/observability/src/index.mjs";

export function teamDriveReferenceAccess({ grants, teamDrive }) {
  if (!grants?.find || !teamDrive?.authorizeObjectRead) throw new TypeError("File reference access requires current file permissions");
  return async ({ context, referenceId }) => {
    const grant = await grants.find(referenceId);
    // Other audiences keep their existing object-service authorization.
    if (!grant || !["team-drive.download", "team-drive.preview"].includes(grant.audience)) return;
    if (grant.issuedByIdentityId !== context.identityId) {
      throw new PlatformError("file_not_found", "File is unavailable", { status: 404 });
    }
    await teamDrive.authorizeObjectRead({
      actorIdentityId: context.identityId, permissions: context.permissions, teamRoles: context.teamRoles ?? {},
    }, { objectId: grant.objectId, objectVersion: grant.objectVersion });
  };
}
