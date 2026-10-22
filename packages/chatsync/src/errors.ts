/**
 * An expected failure that the CLI reports to the user without a stack trace.
 * Exit codes: 1 = error, 2 = unsupported platform or unrecognized data layout.
 */
export class ChatsyncError extends Error {
  constructor(
    message: string,
    readonly exitCode: 1 | 2 = 1,
  ) {
    super(message);
    this.name = "ChatsyncError";
  }
}
