import { Binary } from "@hazae41/binary"
import { Foras, GzDecoder } from "@hazae41/foras"
import { Bytes } from "libs/bytes/bytes.js"
import { CloseEvent } from "libs/events/close.js"
import { ErrorEvent } from "libs/events/error.js"
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
  host: string,
  method: string,
  headers?: Headers,
  signal?: AbortSignal
}

export class HttpStream extends EventTarget {
  readonly read = new EventTarget()
  readonly write = new EventTarget()

  private _state: HttpState = { type: "none", buffer: Binary.allocUnsafe(10 * 1024) }

  readonly readable: ReadableStream<Uint8Array>
  readonly writable: WritableStream<Uint8Array>

  private _input?: TransformStreamDefaultController<Uint8Array>
  private _output?: TransformStreamDefaultController<Uint8Array>

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

    const read = new TransformStream<Uint8Array>({
      start: this.onReadStart.bind(this),
      transform: this.onRead.bind(this),
    })

    const write = new TransformStream<Uint8Array>({
      start: this.onWriteStart.bind(this),
      transform: this.onWrite.bind(this),
      flush: this.onWriteFlush.bind(this),
    })

    const [readable, trashable] = read.readable.tee()

    this.readable = readable
    this.writable = write.writable

    stream.readable
      .pipeTo(read.writable, { signal })
      .then(this.onReadClose.bind(this))
      .catch(this.onReadError.bind(this))

    write.readable
      .pipeTo(stream.writable, { signal })
      .then(this.onWriteClose.bind(this))
      .catch(this.onWriteError.bind(this))

    const trash = new WritableStream()

    /**
     * Force call to read.readable.transform()
     */
    trashable
      .pipeTo(trash, { signal })
      .then(this.onReadClose.bind(this))
      .catch(this.onReadError.bind(this))

    const onError = this.onError.bind(this)

    this.read.addEventListener("error", onError, { passive: true })
    this.write.addEventListener("error", onError, { passive: true })
  }

  get input() {
    return this._input!
  }

  get output() {
    return this._output!
  }

  private async onReadClose() {
    const event = new CloseEvent("close", {})
    if (!this.read.dispatchEvent(event)) return
  }

  private async onWriteClose() {
    const event = new CloseEvent("close", {})
    if (!this.write.dispatchEvent(event)) return
  }

  private async onReadError(error?: unknown) {
    const event = new ErrorEvent("error", { error })
    if (!this.read.dispatchEvent(event)) return

    try { this.input.error(error) } catch (e: unknown) { }
    try { this.output.error(error) } catch (e: unknown) { }
  }

  private async onWriteError(error?: unknown) {
    const event = new ErrorEvent("error", { error })
    if (!this.write.dispatchEvent(event)) return

    try { this.input.error(error) } catch (e: unknown) { }
    try { this.output.error(error) } catch (e: unknown) { }
  }

  private async onError(error?: unknown) {
    const event = new ErrorEvent("error", { error })
    if (!this.dispatchEvent(event)) return
  }

  private async onReadStart(controller: TransformStreamDefaultController<Uint8Array>) {
    this._input = controller
  }

  private async onRead(chunk: Uint8Array, controller: TransformStreamDefaultController) {
    // console.debug("<-", chunk)

    if (this._state.type === "none") {
      const result = await this.onReadNone(chunk, controller)

      if (result === undefined)
        return
      chunk = result
    }

    if (this._state.type !== "headed")
      throw new Error("Invalid state")

    if (this._state.transfer.type === "unlengthed")
      return await this.onReadUnlenghted(chunk, controller)
    if (this._state.transfer.type === "lengthed")
      return await this.onReadLenghted(chunk, controller)
    if (this._state.transfer.type === "chunked")
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
      const buffer = Binary.allocUnsafe(10 * 1024)
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
    if (this._state.type !== "none")
      throw new Error("Invalid state")

    const { buffer } = this._state

    buffer.write(chunk)

    const split = buffer.buffer.indexOf("\r\n\r\n")

    if (split === -1) return

    const head = buffer.buffer.subarray(0, split)
    const body = buffer.buffer.subarray(split + "\r\n\r\n".length, buffer.offset)

    const [info, ...rawHeaders] = head.toString().split("\r\n")
    const [version, statusString, statusText] = info.split(" ")

    const status = Number(statusString)
    const headers = new Headers(rawHeaders.map(it => Strings.splitOnFirst(it, ": ")))
    this.dispatchEvent(new MessageEvent("body", { data: { headers, status, statusText } }))

    const transfer = this.getTransferFromHeaders(headers)
    const compression = await this.getCompressionFromHeaders(headers)

    this._state = { type: "headed", version, transfer, compression }

    if (transfer.type === "lengthed") {
      if (transfer.length === 0)
        controller.terminate()
    }

    return body
  }

  private async onReadUnlenghted(chunk: Uint8Array, controller: TransformStreamDefaultController<Uint8Array>) {
    if (this._state.type !== "headed")
      throw new Error("Invalid state")
    if (this._state.transfer.type !== "unlengthed")
      throw new Error("Invalid state")

    const { compression } = this._state

    if (compression.type === "none")
      controller.enqueue(chunk)

    if (compression.type === "gzip") {
      compression.decoder.write(chunk)
      compression.decoder.flush()

      const dchunk = compression.decoder.read()
      controller.enqueue(dchunk)
    }

    controller.terminate()
  }

  private async onReadLenghted(chunk: Uint8Array, controller: TransformStreamDefaultController<Uint8Array>) {
    if (this._state.type !== "headed")
      throw new Error("Invalid state")
    if (this._state.transfer.type !== "lengthed")
      throw new Error("Invalid state")

    const { transfer, compression } = this._state

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
    if (this._state.type !== "headed")
      throw new Error("Invalid state")
    if (this._state.transfer.type !== "chunked")
      throw new Error("Invalid state")

    const { transfer, compression } = this._state
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
    this._output = controller

    const { method, pathname, host, headers } = this.params

    let head = ``
    head += `${method} ${pathname} HTTP/1.1\r\n`
    head += `Host: ${host}\r\n`
    head += `Transfer-Encoding: chunked\r\n`
    head += `Accept-Encoding: gzip\r\n`
    headers?.forEach((v, k) => head += `${k}: ${v}\r\n`)
    head += `\r\n`

    controller.enqueue(Bytes.fromUtf8(head))
  }

  private async onWrite(chunk: Uint8Array, controller: TransformStreamDefaultController<Uint8Array>) {
    const text = new TextDecoder().decode(chunk)
    const length = text.length.toString(16)
    const line = `${length}\r\n${text}\r\n`

    controller.enqueue(Bytes.fromUtf8(line))
  }

  private async onWriteFlush(controller: TransformStreamDefaultController<Uint8Array>) {
    controller.enqueue(Bytes.fromUtf8(`0\r\n\r\n`))
  }
}