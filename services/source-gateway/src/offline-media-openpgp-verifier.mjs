const FINGERPRINT = /^(?:[A-F0-9]{40}|[A-F0-9]{64})$/;
const MEDIA_PATH = /^\/run\/teamaibox\/offline-media\/[0-9a-f-]{36}\/(?:[A-Za-z0-9@+._-]+\/)*[A-Za-z0-9@+._-]+$/i;
const MEDIA_ROOT = /^\/run\/teamaibox\/offline-media\/[0-9a-f-]{36}$/i;

function result(value) { if (!value || !Number.isInteger(value.exitCode) || typeof value.stderr !== "string") throw new TypeError("Offline media OpenPGP executor returned an invalid result"); return value; }

export class OfflineMediaOpenPgpVerifier {
  #executor; #keyring;
  constructor({ executor, trustedKeyringFile = "/run/teamaibox/source-keys/offline-media.gpg" }) {
    if (typeof executor?.run !== "function" || !/^\/run\/teamaibox\/source-keys\/[A-Za-z0-9._-]+$/.test(trustedKeyringFile)) throw new TypeError("Offline media OpenPGP verifier configuration is invalid");
    this.#executor = executor; this.#keyring = trustedKeyringFile;
  }
  async verifyFiles({ payloadPath, signaturePath, expectedFingerprint, allowedRoot }) {
    if (!MEDIA_PATH.test(payloadPath) || !MEDIA_PATH.test(signaturePath) || !MEDIA_ROOT.test(allowedRoot) || !payloadPath.startsWith(`${allowedRoot}/`)
      || !signaturePath.startsWith(`${allowedRoot}/`) || !FINGERPRINT.test(expectedFingerprint)) throw new TypeError("Offline media OpenPGP verification input is invalid");
    const value = result(await this.#executor.run({ program: "gpg", arguments: ["--batch", "--no-tty", "--no-default-keyring", "--keyring", this.#keyring, "--status-fd", "2", "--verify", signaturePath, payloadPath],
      network: false, readOnlyRoot: true, readOnlyPaths: [allowedRoot, this.#keyring] }));
    const fingerprints = [...new Set([...value.stderr.matchAll(/\[GNUPG:\] VALIDSIG ([A-F0-9]{40}(?:[A-F0-9]{24})?)/g)].map((match) => match[1]))];
    return Object.freeze({ valid: value.exitCode === 0 && fingerprints.length === 1 && fingerprints[0] === expectedFingerprint, fingerprint: fingerprints.length === 1 ? fingerprints[0] : null });
  }
}
