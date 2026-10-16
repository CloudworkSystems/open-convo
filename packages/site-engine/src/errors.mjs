export class SiteEngineError extends Error {
  constructor(message) {
    super(message);
    this.name = "SiteEngineError";
  }
}
