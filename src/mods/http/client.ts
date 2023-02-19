import { Cursor } from "@hazae41/binary"
import { Bytes } from "@hazae41/bytes"
import { Foras, GzDecoder, GzEncoder } from "@hazae41/foras"
import { CloseEvent } from "libs/events/close.js"
import { ErrorEvent } from "libs/events/error.js"
import { AsyncEventTarget } from "libs/events/target.js"
import { Strings } from "libs/strings/strings.js"
import { HttpClientCompression, HttpHeadedState, HttpHeadingState, HttpServerCompression, HttpState, HttpTransfer, HttpUpgradingState } from "./state.js"

export interface HttpStreamParams {
  readonly pathname: string,
  readonly method: string,
  readonly headers: Headers,
  readonly signal?: AbortSignal
}

export class HttpClientStream extends AsyncEventTarget {
  readonly #class = HttpClientStream

  readonly reading = new AsyncEventTarget()
  readonly writing = new AsyncEventTarget()

  readonly readable: ReadableStream<Uint8Array>
  readonly writable: WritableStream<Uint8Array>

  readonly #reader: TransformStream<Uint8Array>
  readonly #writer: TransformStream<Uint8Array>
  readonly #piper: TransformStream<Uint8Array>

  #input?: TransformStreamDefaultController<Uint8Array>
  #output?: TransformStreamDefaultController<Uint8Array>

  #state: HttpState = { type: "none" }

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

    this.#reader = new TransformStream<Uint8Array>({
      start: this.#onReadStart.bind(this),
      transform: this.#onRead.bind(this),
    })

    this.#writer = new TransformStream<Uint8Array>({
      start: this.#onWriteStart.bind(this),
      transform: this.#onWrite.bind(this),
      flush: this.#onWriteFlush.bind(this),
    })

    this.#piper = new TransformStream<Uint8Array>()

    this.readable = this.#piper.readable
    this.writable = this.#writer.writable

    stream.readable
      .pipeTo(this.#reader.writable, { signal })
      .then(this.#onReadClose.bind(this))
      .catch(this.#onReadError.bind(this))

    this.#writer.readable
      .pipeTo(stream.writable, { signal })
      .then(this.#onWriteClose.bind(this))
      .catch(this.#onWriteError.bind(this))

    this.#reader.readable
      .pipeTo(this.#piper.writable)
      .then(() => { })
      .catch(() => { })
  }

  async #onReadClose() {
    // console.debug(`${this.#class.name}.onReadClose`)

    const closeEvent = new CloseEvent("close", {})
    if (!await this.reading.dispatchEvent(closeEvent)) return
  }

  async #onWriteClose() {
    // console.debug(`${this.#class.name}.onWriteClose`)

    const closeEvent = new CloseEvent("close", {})
    if (!await this.writing.dispatchEvent(closeEvent)) return
  }

  async #onReadError(error?: unknown) {
    // console.debug(`${this.#class.name}.onReadError`, error)

    try { this.#output!.error(error) } catch (e: unknown) { }

    const errorEvent = new ErrorEvent("error", { error })
    if (!await this.reading.dispatchEvent(errorEvent)) return
  }

  async #onWriteError(error?: unknown) {
    // console.debug(`${this.#class.name}.onWriteError`, error)

    try { this.#input!.error(error) } catch (e: unknown) { }

    const errorEvent = new ErrorEvent("error", { error })
    if (!await this.writing.dispatchEvent(errorEvent)) return
  }

  async #onReadStart(controller: TransformStreamDefaultController<Uint8Array>) {
    this.#input = controller
  }

  async #onRead(chunk: Uint8Array) {
    // console.debug(this.#class.name, "<-", chunk.length, Bytes.toUtf8(chunk))

    if (this.#state.type === "heading" || this.#state.type === "upgrading") {
      const result = await this.#onReadHead(chunk, this.#state)

      if (!result?.length)
        return
      chunk = result
    }

    if (this.#state.type === "upgraded")
      return this.#input!.enqueue(chunk)

    if (this.#state.type === "headed") {
      if (this.#state.server_transfer.type === "none")
        return await this.#onReadNoneBody(chunk, this.#state)
      if (this.#state.server_transfer.type === "lengthed")
        return await this.#onReadLenghtedBody(chunk, this.#state)
      if (this.#state.server_transfer.type === "chunked")
        return await this.#onReadChunkedBody(chunk, this.#state)
    }

    throw new Error(`Invalid state`)
  }

  #getTransferFromHeaders(headers: Headers): HttpTransfer {
    const type = headers.get("Transfer-Encoding")

    if (type === "chunked") {
      const buffer = Cursor.allocUnsafe(64 * 1024)
      return { type, buffer }
    }

    if (type === null) {
      const length = headers.get("Content-Length")

      if (length) {
        return { type: "lengthed", length: Number(length), offset: 0 }
      } else {
        return { type: "none" }
      }
    }

    throw new Error(`Unsupported transfer ${type}`)
  }

  async #getClientCompressionFromHeaders(headers: Headers) {
    const type = headers.get("Content-Encoding")

    if (type === null)
      return { type: "none" } as HttpClientCompression

    if (type === "gzip") {
      await Foras.initBundledOnce()
      const encoder = new GzEncoder()
      return { type, encoder } as HttpClientCompression
    }

    throw new Error(`Unsupported compression ${type}`)
  }

  async #getServerCompressionFromHeaders(headers: Headers) {
    const type = headers.get("Content-Encoding")

    if (type === null)
      return { type: "none" } as HttpServerCompression

    if (type === "gzip") {
      await Foras.initBundledOnce()
      const decoder = new GzDecoder()
      return { type, decoder } as HttpServerCompression
    }

    throw new Error(`Unsupported compression ${type}`)
  }

  async #onReadHead(chunk: Uint8Array, state: HttpHeadingState | HttpUpgradingState) {
    const { buffer } = state

    buffer.write(chunk)

    const split = buffer.buffer.indexOf("\r\n\r\n")

    if (split === -1) return

    const rawHead = buffer.buffer.subarray(0, split)
    const rawBody = buffer.buffer.subarray(split + "\r\n\r\n".length, buffer.offset)

    const [rawStatus, ...rawHeaders] = rawHead.toString().split("\r\n")
    const [version, statusString, statusText] = rawStatus.split(" ")

    const status = Number(statusString)
    const headers = new Headers(rawHeaders.map(it => Strings.splitOnFirst(it, ": ")))

    if (state.type === "upgrading") {
      this.#state = { ...state, type: "upgraded" }
    } else {
      const server_transfer = this.#getTransferFromHeaders(headers)
      const server_compression = await this.#getServerCompressionFromHeaders(headers)
      this.#state = { ...state, type: "headed", server_transfer, server_compression }
    }

    const msgEvent = new MessageEvent("head", { data: { headers, status, statusText } })
    await this.reading.dispatchEvent(msgEvent)

    return rawBody
  }

  async #onReadNoneBody(chunk: Uint8Array, state: HttpHeadedState) {
    if (state.server_transfer.type !== "none")
      throw new Error("Invalid state")

    const { server_compression } = state

    if (server_compression.type === "gzip") {
      server_compression.decoder.write(chunk)
      server_compression.decoder.flush()

      const dchunk = server_compression.decoder.read()
      this.#input!.enqueue(dchunk)
    } else {
      this.#input!.enqueue(chunk)
    }
  }

  async #onReadLenghtedBody(chunk: Uint8Array, state: HttpHeadedState) {
    if (state.server_transfer.type !== "lengthed")
      throw new Error("Invalid state")

    const { server_transfer, server_compression } = state

    server_transfer.offset += chunk.length

    if (server_transfer.offset > server_transfer.length)
      throw new Error(`Length > Content-Length`)

    if (server_compression.type === "gzip") {
      server_compression.decoder.write(chunk)
      server_compression.decoder.flush()

      const dchunk = server_compression.decoder.read()
      this.#input!.enqueue(dchunk)
    } else {
      this.#input!.enqueue(chunk)
    }

    if (server_transfer.offset === server_transfer.length) {

      if (server_compression.type === "gzip") {
        const fchunk = server_compression.decoder.finish()
        this.#input!.enqueue(fchunk)
      }

      this.#input!.terminate()
    }
  }

  async #onReadChunkedBody(chunk: Uint8Array, state: HttpHeadedState) {
    if (state.server_transfer.type !== "chunked")
      throw new Error("Invalid state")

    const { server_transfer, server_compression } = state
    const { buffer } = server_transfer

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

        if (server_compression.type === "gzip") {
          const fchunk = server_compression.decoder.finish()
          if (fchunk.length) this.#input!.enqueue(fchunk)
        }

        this.#input!.terminate()
        return
      }

      // len(...) < length + len(\r\n) => partial chunk => wait
      if (rest.length < length + 2) break

      // ([length]\r\n)[chunk]\r\n(...) => full chunk => split it
      const chunk2 = rest.subarray(0, length)
      const rest2 = rest.subarray(length + 2)

      if (server_compression.type === "gzip") {
        server_compression.decoder.write(chunk2)
        server_compression.decoder.flush()

        const dchunk2 = server_compression.decoder.read()
        if (dchunk2.length) this.#input!.enqueue(dchunk2)
      } else {
        this.#input!.enqueue(chunk2)
      }

      buffer.offset = 0
      buffer.write(rest2)

      slice = buffer.buffer.subarray(0, buffer.offset)
    }
  }

  async #onWriteStart(controller: TransformStreamDefaultController<Uint8Array>) {
    this.#output = controller

    const { method, pathname, headers } = this.params

    let head = `${method} ${pathname} HTTP/1.1\r\n`
    headers.forEach((v, k) => head += `${k}: ${v}\r\n`)
    head += `\r\n`

    // console.debug(this.#class.name, "->", head.length, head)
    controller.enqueue(Bytes.fromUtf8(head))

    const buffer = Cursor.allocUnsafe(64 * 1024)

    if (Strings.equalsIgnoreCase(headers.get("Connection"), "Upgrade")) {
      this.#state = { type: "upgrading", buffer }
    } else {
      const client_transfer = this.#getTransferFromHeaders(headers)
      const client_compression = await this.#getClientCompressionFromHeaders(headers)
      this.#state = { type: "heading", buffer, client_transfer, client_compression }
    }
  }

  async #onWrite(chunk: Uint8Array) {
    // console.debug(this.#class.name, "->", chunk)

    if (this.#state.type === "upgrading" || this.#state.type === "upgraded")
      return this.#output!.enqueue(chunk)

    if (this.#state.type === "heading" || this.#state.type === "headed") {
      if (this.#state.client_transfer.type === "none")
        return await this.#onWriteNone(chunk)
      if (this.#state.client_transfer.type === "chunked")
        return await this.#onWriteChunked(chunk)
    }

    throw new Error(`Invalid state`)
  }

  async #onWriteNone(chunk: Uint8Array) {
    this.#output!.enqueue(chunk)
  }

  async #onWriteChunked(chunk: Uint8Array) {
    const text = new TextDecoder().decode(chunk)
    const length = text.length.toString(16)
    const line = `${length}\r\n${text}\r\n`

    // console.debug(this.#class.name, "->", line.length, line)
    this.#output!.enqueue(Bytes.fromUtf8(line))
  }

  async #onWriteFlush() {
    if (this.#state.type !== "heading")
      return

    if (this.#state.client_transfer.type === "none")
      return this.#output!.enqueue(Bytes.fromUtf8(`\r\n`))
    if (this.#state.client_transfer.type === "chunked")
      return this.#output!.enqueue(Bytes.fromUtf8(`0\r\n\r\n`))
  }
}