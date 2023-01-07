import { Binary } from "@hazae41/binary"
import { GzDecoder } from "@hazae41/foras"
import { Reader, Writer } from "libs/streams/types.js"

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
  private in = new TransformStream<Buffer, Buffer>()
  private out = new TransformStream<Buffer, Buffer>()

  private _state: HttpState = { type: "none", buffer: Binary.allocUnsafe(10 * 1024) }

  /**
   * Create a new HTTP 1.1 stream
   * @param sub substream
   */
  constructor(
    readonly sub: ReadableWritablePair<Buffer, Buffer>,
  ) { }

  get writable() {
    return this.in.writable
  }

  get readable() {
    return this.out.readable
  }

  async read() {
    const reader = this.sub.readable.getReader()
    const writer = this.out.writable.getWriter()

    try {
      await this._read(reader, writer)
    } catch (e: unknown) {
      await reader.cancel()
      await writer.abort()
    } finally {
      reader.releaseLock()
      writer.releaseLock()
    }
  }

  private async _read(reader: Reader<Buffer>, writer: Writer<Buffer>) {
    while (true) {
      const result = await reader.read()

      if (result.done)
        break
      await this._onRead(writer, result.value)
    }

    await writer.close()
  }

  private async _onRead(writer: Writer<Buffer>, value: Buffer) {
    writer.write(value)
  }

  async write() {
    const reader = this.in.readable.getReader()
    const writer = this.sub.writable.getWriter()

    try {
      await this._write(reader, writer)
    } catch (e: unknown) {
      await reader.cancel()
      await writer.abort()
    } finally {
      reader.releaseLock()
      writer.releaseLock()
    }
  }

  private async _write(reader: Reader<Buffer>, writer: Writer<Buffer>) {
    while (true) {
      const result = await reader.read()

      if (result.done)
        break
      await this._onWrite(writer, result.value)
    }

    await writer.close()
  }

  private async _onWrite(writer: Writer<Buffer>, value: Buffer) {
    writer.write(value)
  }
}