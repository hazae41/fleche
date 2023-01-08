import { Binary } from "@hazae41/binary"
import { GzDecoder } from "@hazae41/foras"
import { Stream, Streams, Writer } from "libs/streams/streams.js"

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

export class Http {
  private input = new TransformStream<Buffer, Buffer>()
  private output = new TransformStream<Buffer, Buffer>()

  private _state: HttpState = { type: "none", buffer: Binary.allocUnsafe(10 * 1024) }

  readonly reading: Promise<void>
  readonly writing: Promise<void>

  /**
   * Create a new HTTP 1.1 stream
   * @param substream substream
   */
  constructor(
    readonly substream: Stream<Buffer>,
    readonly signal: AbortSignal
  ) {
    this.reading = this.read()
    this.writing = this.write()
  }

  get writable() {
    return this.input.writable
  }

  get readable() {
    return this.output.readable
  }

  async read() {
    const reader = this.substream.readable.getReader()
    const writer = this.output.writable.getWriter()

    try {
      for await (const value of Streams.read(reader, this.signal))
        await this.onRead(writer, value)
      await writer.close()
    } catch (e: unknown) {
      await reader.cancel(e)
      await writer.abort(e)
    } finally {
      reader.releaseLock()
      writer.releaseLock()
    }
  }

  private async onRead(writer: Writer<Buffer>, value: Buffer) {
    await writer.write(value)
    await new Promise(ok => setTimeout(ok, 100))
  }

  async write() {
    const reader = this.input.readable.getReader()
    const writer = this.substream.writable.getWriter()

    try {
      for await (const value of Streams.read(reader, this.signal))
        await this.onWrite(writer, value)
      await writer.close()
    } catch (e: unknown) {
      await reader.cancel(e)
      await writer.abort(e)
    } finally {
      reader.releaseLock()
      writer.releaseLock()
    }
  }

  private async onWrite(writer: Writer<Buffer>, value: Buffer) {
    await writer.write(value)
    await new Promise(ok => setTimeout(ok, 100))
  }
}