import { CollaborationProtocolError } from './protocol/version.js';

export class CollaborationProjectSpaceValidationError extends CollaborationProtocolError {
  constructor(
    code: CollaborationProtocolError['code'],
    message: string,
    options?: ErrorOptions,
  ) {
    super(code, message);
    this.name = 'CollaborationProjectSpaceValidationError';
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

export class CollaborationProjectSpaceHistoryNotDescendantError extends CollaborationProjectSpaceValidationError {
  constructor(message: string) {
    super('PROTOCOL_QUARANTINED', message);
    this.name = 'CollaborationProjectSpaceHistoryNotDescendantError';
  }
}

export class CollaborationProjectSpaceGitOperationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CollaborationProjectSpaceGitOperationError';
  }
}

export class CollaborationProjectSpaceHistoryRewrittenError extends Error {
  constructor(
    message: string,
    readonly replacementGroupId: string | null,
  ) {
    super(message);
    this.name = 'CollaborationProjectSpaceHistoryRewrittenError';
  }
}
