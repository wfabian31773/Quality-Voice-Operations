export class ObjectNotFoundError extends Error {
  constructor() {
    super('Object not found');
    this.name = 'ObjectNotFoundError';
    Object.setPrototypeOf(this, ObjectNotFoundError.prototype);
  }
}

export class StorageNotConfiguredError extends Error {
  constructor(message = 'Object storage is not configured') {
    super(message);
    this.name = 'StorageNotConfiguredError';
    Object.setPrototypeOf(this, StorageNotConfiguredError.prototype);
  }
}
