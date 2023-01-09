import { Binary } from "@hazae41/binary"
import { GzDecoder } from "@hazae41/foras"
import { Stream, TransformByteStream } from "libs/streams/streams.js"
import { Uint8Arrays } from "libs/uint8arrays/uint8arrays.js"

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
  pathname: string,
  host: string,
  method: string,
  headers?: Headers,
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
    readonly params: HttpStreamParams
  ) {
    super()

    const { signal } = params

    const output = new TransformByteStream({
      transform: this.onRead.bind(this)
    })

    const input = new TransformByteStream({
      start: this.onWriteStart.bind(this),
      transform: this.onWrite.bind(this)
    })

    this.readable = output.readable
    this.writable = input.writable

    substream.readable.pipeTo(output.writable, { signal }).catch(() => { })
    input.readable.pipeTo(substream.writable, { signal }).catch(() => { })
  }

  i = 0

  private async onRead(chunk: Uint8Array, controller: ReadableByteStreamController) {
    try {
      // console.log("<-", chunk)

      if (this.i++ === 2)
        this.dispatchEvent(new Event("body"))

      controller.enqueue(chunk)
    } catch (e: unknown) {
      controller.error(e)
    }
  }

  private async onWriteStart(controller: ReadableByteStreamController) {
    try {
      const { method, pathname, host, headers } = this.params

      let head = ``
      head += `${method} ${pathname} HTTP/1.1\r\n`
      head += `Host: ${host}\r\n`
      head += `Transfer-Encoding: chunked\r\n`
      head += `Accept-Encoding: gzip\r\n`
      headers?.forEach((v, k) => head += `${k}: ${v}\r\n`)
      head += `\r\n`

      controller.enqueue(Uint8Arrays.fromUtf8(head))
    } catch (e: unknown) {
      controller.error(e)
    }
  }

  private async onWrite(chunk: Uint8Array, controller: ReadableByteStreamController) {
    try {
      controller.enqueue(chunk)
    } catch (e: unknown) {
      controller.error(e)
    }
  }
}