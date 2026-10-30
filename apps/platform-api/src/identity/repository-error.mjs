export class IdentityRepositoryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "IdentityRepositoryError";
    this.code = code;
  }
}
