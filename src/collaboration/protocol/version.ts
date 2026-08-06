export const COLLABORATION_PROTOCOL_VERSION = 2 as const;
export const COLLABORATION_CONTROL_BRANCH =
  'refs/heads/icarus/control' as const;

export class CollaborationProtocolError extends Error {
  constructor(
    readonly code:
      | 'PROTOCOL_VERSION_UNSUPPORTED'
      | 'PROTOCOL_QUARANTINED'
      | 'EVENT_UNAUTHORIZED'
      | 'EVENT_CONFLICT',
    message: string,
  ) {
    super(message);
    this.name = 'CollaborationProtocolError';
  }
}
