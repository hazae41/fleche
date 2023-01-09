import { Binary } from "@hazae41/binary"
import { GzDecoder } from "@hazae41/foras"
import { Stream, TransformByteStream } from "libs/streams/streams.js"

export type HttpState =
  | HttpNoneState
  | HttpHeadedState

export interface HttpNoneState {
  type: "none"
  buffer: Binary
}

export interface HttpHeadedState {
  type: "headed",
  version: string,
  transfer: HttpTransfer,
  compression: HttpCompression
}

export type HttpTransfer =
  | HttpChunkedTransfer
  | HttpLengthedTransfer

export interface HttpChunkedTransfer {
  type: "chunked",
  buffer: Binary
}

export interface HttpLengthedTransfer {
  type: "lengthed",
  offset: number,
  length: number
}

export type HttpCompression =
  | HttpNoneCompression
  | HttpGzipCompression

export interface HttpNoneCompression {
  type: "none"
}

export interface HttpGzipCompression {
  type: "gzip"
  decoder: GzDecoder
}

export interface HttpStreamParams {
  signal?: AbortSignal
}

export class HttpStream extends EventTarget {
  private _state: HttpState = { type: "none", buffer: Binary.allocUnsafe(10 * 1024) }

  readonly readable: ReadableStream<Uint8Array>
  readonly writable: WritableStream<Uint8Array>

  /**
   * Create a new HTTP 1.1 stream
   * @param substream substream
   */
  constructor(
    readonly substream: Stream<Uint8Array>,
    readonly params: HttpStreamParams = {}
  ) {
    super()

    const { signal } = params

    const output = new TransformByteStream({ transform: this.onRead.bind(this) })
    const input = new TransformByteStream({ transform: this.onWrite.bind(this) })

    this.readable = output.readable
    this.writable = input.writable

    substream.readable.pipeTo(output.writable, { signal }).catch(e => { })
    input.readable.pipeTo(substream.writable, { signal }).catch(e => { })
  }

  i = 0

  private async onRead(chunk: Uint8Array, controller: ReadableByteStreamController) {
    console.log("<-", chunk)

    if (this.i++ === 2)
      this.dispatchEvent(new Event("body"))

    controller.enqueue(chunk)
  }

  private async onWrite(chunk: Uint8Array, controller: ReadableByteStreamController) {
    console.log("->", chunk)

    controller.enqueue(chunk)
  }
}