export class CollaborationProjectSpaceHistoryRewrittenError extends Error {
  constructor(
    message: string,
    readonly replacementGroupId: string | null,
  ) {
    super(message);
    this.name = 'CollaborationProjectSpaceHistoryRewrittenError';
  }
}
