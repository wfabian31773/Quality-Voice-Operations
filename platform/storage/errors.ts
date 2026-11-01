export class ObjectNotFoundError extends Error {
  constructor() {
    super('Object not found');
    this.name = 'ObjectNotFoundError';
    Object.setPrototypeOf(this, ObjectNotFoundError.prototype);
  }
}

export class InvalidObjectPathError extends Error {
  constructor() {
    super('Invalid object path');
    this.name = 'InvalidObjectPathError';
    Object.setPrototypeOf(this, InvalidObjectPathError.prototype);
  }
}

export class StorageNotConfiguredError extends Error {
  constructor(message = 'Object storage is not configured') {
    super(message);
    this.name = 'StorageNotConfiguredError';
    Object.setPrototypeOf(this, StorageNotConfiguredError.prototype);
  }
}
