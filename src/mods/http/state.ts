import { SuperReadableStream } from "@hazae41/cascade"
import { Cursor } from "@hazae41/cursor"

export type HttpState =
  | HttpNoneState
  | HttpHeadingState
  | HttpHeadedState
  | HttpUpgradingState
  | HttpUpgradedState

export interface HttpNoneState {
  readonly type: "none"
}

export interface HttpUpgradingState {
  readonly type: "upgrading",
  readonly buffer: Cursor
}

export interface HttpUpgradedState {
  readonly type: "upgraded"
}

export interface HttpHeadingState {
  readonly type: "heading",
  readonly client_transfer: HttpTransfer
  readonly client_compression: HttpClientCompression
  readonly buffer: Cursor
}

export interface HttpHeadedState {
  readonly type: "headed",
  readonly client_transfer: HttpTransfer
  readonly client_compression: HttpClientCompression
  readonly server_transfer: HttpTransfer,
  readonly server_compression: HttpServerCompression
}

export type HttpTransfer =
  | HttpNoneTransfer
  | HttpLengthedTransfer
  | HttpChunkedTransfer

export interface HttpChunkedTransfer {
  readonly type: "chunked",
  readonly buffer: Cursor
}

export interface HttpNoneTransfer {
  readonly type: "none"
}

export interface HttpLengthedTransfer {
  readonly type: "lengthed",
  readonly length: number

  offset: number,
}

export interface HttpNoneCompression {
  readonly type: "none"
}

export type HttpClientCompression =
  | HttpNoneCompression
  | HttpGzipClientCompression

export interface HttpGzipClientCompression {
  readonly type: "gzip"
  readonly sourcer: SuperReadableStream<Uint8Array>
  readonly encoder: CompressionStream
}

export type HttpServerCompression =
  | HttpNoneCompression
  | HttpGzipServerCompression

export interface HttpGzipServerCompression {
  readonly type: "gzip"
  readonly sourcer: SuperReadableStream<Uint8Array>
  readonly decoder: DecompressionStream
}