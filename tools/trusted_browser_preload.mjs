import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";

const require = createRequire(import.meta.url);
const childProcess = require("node:child_process");
const originalSpawn = childProcess.spawn;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const FORBIDDEN = [
  "--allow-insecure-localhost",
  "--ignore-certificate-errors",
  "--ignore-certificate-errors-spki-list",
  "--test-type",
];

const digest = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

childProcess.spawn = function trustedSpawn(command, args = [], options = {}) {
  if (command !== CHROME) return originalSpawn.call(this, command, args, options);
  const actualArgs = args.filter((argument) => !FORBIDDEN.some((flag) => argument === flag || argument.startsWith(`${flag}=`)));
  const removedArgs = args.filter((argument) => !actualArgs.includes(argument));
  if (!removedArgs.includes("--ignore-certificate-errors")) {
    throw new Error("trusted-browser preload did not remove the expected legacy certificate bypass");
  }
  if (actualArgs.some((argument) => FORBIDDEN.some((flag) => argument === flag || argument.startsWith(`${flag}=`)))) {
    throw new Error("trusted-browser preload left a certificate bypass enabled");
  }
  const attestationPath = process.env.TEAMAIBOX_TRUSTED_BROWSER_ATTESTATION;
  if (!attestationPath) throw new Error("trusted-browser launch attestation path is missing");
  const safeArgs = actualArgs.map((argument) => argument.startsWith("--user-data-dir=")
    ? "--user-data-dir=[EPHEMERAL]" : argument);
  const attestation = {
    schemaVersion: 1,
    runnerId: "teamaibox.trusted-browser-preload.v1",
    chromeExecutable: CHROME,
    actualArguments: safeArgs,
    actualArgumentsDigest: digest(Buffer.from(JSON.stringify(safeArgs))),
    removedLegacyArguments: removedArgs,
    certificateBypassArgumentsPresent: false,
    customClientCaArgumentPresent: actualArgs.some((argument) => argument.startsWith("--ca-certificate-file=")),
    systemTrustOnly: true,
    ephemeralProfile: true,
    profileRetained: false,
    commandOutputRetained: false,
  };
  writeFileSync(attestationPath, `${JSON.stringify(attestation, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return originalSpawn.call(this, command, actualArgs, options);
};

syncBuiltinESMExports();
