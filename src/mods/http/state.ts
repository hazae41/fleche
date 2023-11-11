import { SuperReadableStream } from "@hazae41/cascade"
import { Cursor } from "@hazae41/cursor"
import { Nullable } from "@hazae41/option"

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
  readonly buffer: Cursor

  readonly client_transfer: HttpTransfer
  readonly client_compression?: Nullable<HttpCompression>
}

export interface HttpHeadedState {
  readonly type: "headed",

  readonly client_transfer: HttpTransfer
  readonly server_transfer: HttpTransfer

  readonly client_compression?: Nullable<HttpCompression>
  readonly server_compression?: Nullable<HttpCompression>
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

  offset: number
}

export interface HttpCompression {
  readonly sourcer: SuperReadableStream<Uint8Array>
}