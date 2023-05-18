export class UnsupportedContentEncoding extends Error {
  readonly #class = UnsupportedContentEncoding

  constructor(
    readonly type: string
  ) {
    super(`Unsupported "Content-Encoding" header value "${type}"`)
  }
}

export class UnsupportedTransferEncoding extends Error {
  readonly #class = UnsupportedTransferEncoding

  constructor(
    readonly type: string
  ) {
    super(`Unsupported "Transfer-Encoding" header value "${type}"`)
  }
}

export class ContentLengthOverflowError extends Error {
  readonly #class = ContentLengthOverflowError

  constructor(
    readonly offset: number,
    readonly length: number
  ) {
    super(`Received ${offset} bytes but "Content-Length" header said it was ${length} bytes`)
  }
}