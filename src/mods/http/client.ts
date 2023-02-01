import { Binary } from "@hazae41/binary"
import { Foras, GzDecoder } from "@hazae41/foras"
import { Bytes } from "libs/bytes/bytes.js"
import { CloseEvent } from "libs/events/close.js"
import { ErrorEvent } from "libs/events/error.js"
import { AsyncEventTarget } from "libs/events/target.js"
import { Strings } from "libs/strings/strings.js"

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
  | HttpUnlengthedTransfer
  | HttpLengthedTransfer
  | HttpChunkedTransfer

export interface HttpChunkedTransfer {
  type: "chunked",
  buffer: Binary
}

export interface HttpUnlengthedTransfer {
  type: "unlengthed"
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
  method: string,
  headers: Headers,
  signal?: AbortSignal
}

export class HttpClientStream extends AsyncEventTarget {
  readonly #class = HttpClientStream

  readonly read = new AsyncEventTarget()
  readonly write = new AsyncEventTarget()

  readonly readable: ReadableStream<Uint8Array>
  readonly writable: WritableStream<Uint8Array>

  private reader: TransformStream<Uint8Array>
  private writer: TransformStream<Uint8Array>
  private piper: TransformStream<Uint8Array>

  private input?: TransformStreamDefaultController<Uint8Array>
  private output?: TransformStreamDefaultController<Uint8Array>

  private state: HttpState = { type: "none", buffer: Binary.allocUnsafe(64 * 1024) }

  /**
   * Create a new HTTP 1.1 stream
   * @param stream substream
   */
  constructor(
    readonly stream: ReadableWritablePair<Uint8Array>,
    readonly params: HttpStreamParams
  ) {
    super()

    const { signal } = params

    this.reader = new TransformStream<Uint8Array>({
      start: this.onReadStart.bind(this),
      transform: this.onRead.bind(this),
    })

    this.writer = new TransformStream<Uint8Array>({
      start: this.onWriteStart.bind(this),
      transform: this.onWrite.bind(this),
      flush: this.onWriteFlush.bind(this),
    })

    this.piper = new TransformStream<Uint8Array>()

    this.readable = this.piper.readable
    this.writable = this.writer.writable

    stream.readable
      .pipeTo(this.reader.writable, { signal })
      .then(this.onReadClose.bind(this))
      .catch(this.onReadError.bind(this))

    this.writer.readable
      .pipeTo(stream.writable, { signal })
      .then(this.onWriteClose.bind(this))
      .catch(this.onWriteError.bind(this))

    this.reader.readable
      .pipeTo(this.piper.writable)
      .then(() => { })
      .catch(() => { })
  }

  private async onReadClose() {
    // console.debug(`${this.#class.name}.onReadClose`)

    const closeEvent = new CloseEvent("close", {})
    if (!await this.read.dispatchEvent(closeEvent)) return
  }

  private async onWriteClose() {
    // console.debug(`${this.#class.name}.onWriteClose`)

    const closeEvent = new CloseEvent("close", {})
    if (!await this.write.dispatchEvent(closeEvent)) return
  }

  private async onReadError(error?: unknown) {
    // console.debug(`${this.#class.name}.onReadError`, error)

    try { this.output!.error(error) } catch (e: unknown) { }

    const errorEvent = new ErrorEvent("error", { error })
    if (!await this.read.dispatchEvent(errorEvent)) return
  }

  private async onWriteError(error?: unknown) {
    // console.debug(`${this.#class.name}.onWriteError`, error)

    try { this.input!.error(error) } catch (e: unknown) { }

    const errorEvent = new ErrorEvent("error", { error })
    if (!await this.write.dispatchEvent(errorEvent)) return
  }

  private async onReadStart(controller: TransformStreamDefaultController<Uint8Array>) {
    this.input = controller
  }

  private async onRead(chunk: Uint8Array, controller: TransformStreamDefaultController) {
    // console.debug("<-", chunk.length, Bytes.toUtf8(chunk))

    if (this.state.type === "none") {
      const result = await this.onReadNone(chunk, controller)

      if (result === undefined)
        return
      chunk = result
    }

    if (this.state.type !== "headed")
      throw new Error("Invalid state")

    if (this.state.transfer.type === "unlengthed")
      return await this.onReadUnlenghted(chunk, controller)
    if (this.state.transfer.type === "lengthed")
      return await this.onReadLenghted(chunk, controller)
    if (this.state.transfer.type === "chunked")
      return await this.onReadChunked(chunk, controller)

    throw new Error(`Invalid state`)
  }

  private getTransferFromHeaders(headers: Headers): HttpTransfer {
    const type = headers.get("transfer-encoding")

    if (type === null) {
      const hlength = headers.get("content-length")

      if (hlength) {
        const length = Number(hlength)
        return { type: "lengthed", offset: 0, length }
      } else {
        return { type: "unlengthed" }
      }
    }

    if (type === "chunked") {
      const buffer = Binary.allocUnsafe(64 * 1024)
      return { type, buffer }
    }

    throw new Error(`Unsupported transfer ${type}`)
  }

  private async getCompressionFromHeaders(headers: Headers) {
    const type = headers.get("content-encoding")

    if (type === null)
      return { type: "none" } as HttpCompression

    if (type === "gzip") {
      await Foras.initBundledOnce()
      const decoder = new GzDecoder()
      return { type, decoder } as HttpCompression
    }

    throw new Error(`Unsupported compression ${type}`)
  }

  private async onReadNone(chunk: Uint8Array, controller: TransformStreamDefaultController<Uint8Array>) {
    if (this.state.type !== "none")
      throw new Error("Invalid state")

    const { buffer } = this.state

    buffer.write(chunk)

    const split = buffer.buffer.indexOf("\r\n\r\n")

    if (split === -1) return

    const head = buffer.buffer.subarray(0, split)
    const body = buffer.buffer.subarray(split + "\r\n\r\n".length, buffer.offset)

    const [info, ...rawHeaders] = head.toString().split("\r\n")
    const [version, statusString, statusText] = info.split(" ")

    const status = Number(statusString)
    const headers = new Headers(rawHeaders.map(it => Strings.splitOnFirst(it, ": ")))

    await this.dispatchEvent(new MessageEvent("body", { data: { headers, status, statusText } }))

    const transfer = this.getTransferFromHeaders(headers)
    const compression = await this.getCompressionFromHeaders(headers)

    this.state = { type: "headed", version, transfer, compression }

    return body
  }

  private async onReadUnlenghted(chunk: Uint8Array, controller: TransformStreamDefaultController<Uint8Array>) {
    if (this.state.type !== "headed")
      throw new Error("Invalid state")
    if (this.state.transfer.type !== "unlengthed")
      throw new Error("Invalid state")

    const { compression } = this.state

    if (compression.type === "none")
      controller.enqueue(chunk)

    if (compression.type === "gzip") {
      compression.decoder.write(chunk)
      compression.decoder.flush()

      const dchunk = compression.decoder.read()
      controller.enqueue(dchunk)
    }
  }

  private async onReadLenghted(chunk: Uint8Array, controller: TransformStreamDefaultController<Uint8Array>) {
    if (this.state.type !== "headed")
      throw new Error("Invalid state")
    if (this.state.transfer.type !== "lengthed")
      throw new Error("Invalid state")

    const { transfer, compression } = this.state

    transfer.offset += chunk.length

    if (transfer.offset > transfer.length)
      throw new Error(`Length > Content-Length`)

    if (compression.type === "none")
      controller.enqueue(chunk)

    if (compression.type === "gzip") {
      compression.decoder.write(chunk)
      compression.decoder.flush()

      const dchunk = compression.decoder.read()
      controller.enqueue(dchunk)
    }

    if (transfer.offset === transfer.length) {

      if (compression.type === "gzip") {
        const fchunk = compression.decoder.finish()
        controller.enqueue(fchunk)
      }

      controller.terminate()
    }
  }

  private async onReadChunked(chunk: Uint8Array, controller: TransformStreamDefaultController<Uint8Array>) {
    if (this.state.type !== "headed")
      throw new Error("Invalid state")
    if (this.state.transfer.type !== "chunked")
      throw new Error("Invalid state")

    const { transfer, compression } = this.state
    const { buffer } = transfer

    buffer.write(chunk)

    let slice = buffer.buffer.subarray(0, buffer.offset)

    while (slice.length) {
      const index = slice.indexOf("\r\n")

      // [...] => partial header => wait
      if (index === -1) return

      // [length]\r\n(...) => full header => split it
      const length = parseInt(slice.subarray(0, index).toString(), 16)
      const rest = slice.subarray(index + 2)

      if (length === 0) {

        if (compression.type === "gzip") {
          const fchunk = compression.decoder.finish()
          if (fchunk.length) controller.enqueue(fchunk)
        }

        controller.terminate()
        return
      }

      // len(...) < length + len(\r\n) => partial chunk => wait
      if (rest.length < length + 2) break

      // ([length]\r\n)[chunk]\r\n(...) => full chunk => split it
      const chunk2 = rest.subarray(0, length)
      const rest2 = rest.subarray(length + 2)

      if (compression.type === "none")
        controller.enqueue(chunk2)

      if (compression.type === "gzip") {
        compression.decoder.write(chunk2)
        compression.decoder.flush()

        const dchunk2 = compression.decoder.read()
        if (dchunk2.length) controller.enqueue(dchunk2)
      }

      buffer.offset = 0
      buffer.write(rest2)

      slice = buffer.buffer.subarray(0, buffer.offset)
    }
  }

  private async onWriteStart(controller: TransformStreamDefaultController<Uint8Array>) {
    this.output = controller

    const { method, pathname, headers } = this.params

    if (!headers.has("Transfer-Encoding"))
      headers.set("Transfer-Encoding", "chunked")
    if (!headers.has("Accept-Encoding"))
      headers.set("Accept-Encoding", "gzip")

    let head = ``
    head += `${method} ${pathname} HTTP/1.1\r\n`
    headers.forEach((v, k) => head += `${k}: ${v}\r\n`)
    head += `\r\n`

    // console.debug("->", head.length, head)
    controller.enqueue(Bytes.fromUtf8(head))
  }

  private async onWrite(chunk: Uint8Array, controller: TransformStreamDefaultController<Uint8Array>) {
    const text = new TextDecoder().decode(chunk)
    const length = text.length.toString(16)
    const line = `${length}\r\n${text}\r\n`

    // console.debug("->", line.length, line)
    controller.enqueue(Bytes.fromUtf8(line))
  }

  private async onWriteFlush(controller: TransformStreamDefaultController<Uint8Array>) {
    controller.enqueue(Bytes.fromUtf8(`0\r\n\r\n`))
  }
}