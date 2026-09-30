export class BusinessValueError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "BusinessValueError";
    this.code = code;
    this.details = details;
  }
}

export const fail = (code, message, details) => {
  throw new BusinessValueError(code, message, details);
};
