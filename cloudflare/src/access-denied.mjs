export class AccessDenied extends Error {
  constructor(status = 401) {
    super("Access denied");
    this.status = status;
  }
}

