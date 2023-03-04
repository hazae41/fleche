import { Cursor, Opaque, Writable } from "@hazae41/binary"
import { Bytes } from "@hazae41/bytes"
import { Foras, GzDecoder, GzEncoder } from "@hazae41/foras"
import { CloseAndErrorEvents } from "libs/events/events.js"
import { AsyncEventTarget } from "libs/events/target.js"
import { SuperTransformStream } from "libs/streams/transform.js"
import { Strings } from "libs/strings/strings.js"
import { HttpClientCompression, HttpHeadedState, HttpHeadingState, HttpServerCompression, HttpState, HttpTransfer, HttpUpgradingState } from "./state.js"

export interface HttpStreamParams {
  readonly pathname: string,
  readonly method: string,
  readonly headers: Headers,
  readonly signal?: AbortSignal
}

export type HttpClientStreamEvent = CloseAndErrorEvents & {
  head: MessageEvent<ResponseInit>
}

export class HttpClientStream {
  readonly #class = HttpClientStream

  readonly reading = new AsyncEventTarget<HttpClientStreamEvent>()
  readonly writing = new AsyncEventTarget<CloseAndErrorEvents>()

  readonly readable: ReadableStream<Uint8Array>
  readonly writable: WritableStream<Uint8Array>

  readonly #reader: SuperTransformStream<Opaque, Uint8Array>
  readonly #writer: SuperTransformStream<Uint8Array, Writable>

  #state: HttpState = { type: "none" }

  /**
   * Create a new HTTP 1.1 stream
   * @param stream substream
   */
  constructor(
    readonly stream: ReadableWritablePair<Opaque, Writable>,
    readonly params: HttpStreamParams
  ) {
    const { signal } = params

    this.#reader = new SuperTransformStream({
      transform: this.#onRead.bind(this)
    })

    this.#writer = new SuperTransformStream({
      start: this.#onWriteStart.bind(this),
      transform: this.#onWrite.bind(this),
      flush: this.#onWriteFlush.bind(this)
    })

    const read = this.#reader.start()
    const write = this.#writer.start()
    const piper = new TransformStream()

    this.readable = piper.readable
    this.writable = write.writable

    stream.readable
      .pipeTo(read.writable, { signal })
      .then(this.#onReadClose.bind(this))
      .catch(this.#onReadError.bind(this))

    write.readable
      .pipeTo(stream.writable, { signal })
      .then(this.#onWriteClose.bind(this))
      .catch(this.#onWriteError.bind(this))

    read.readable
      .pipeTo(piper.writable)
      .then(() => { })
      .catch(() => { })
  }

  async #onReadClose() {
    console.debug(`${this.#class.name}.onReadClose`)

    this.#reader.closed = {}

    const closeEvent = new CloseEvent("close", {})
    await this.reading.dispatchEvent(closeEvent, "close")
  }

  async #onReadError(reason?: unknown) {
    console.debug(`${this.#class.name}.onReadError`, reason)

    this.#reader.closed = { reason }
    this.#writer.error(reason)

    const error = new Error(`Errored`, { cause: reason })
    const errorEvent = new ErrorEvent("error", { error })
    await this.reading.dispatchEvent(errorEvent, "error")
  }

  async #onWriteClose() {
    console.debug(`${this.#class.name}.onWriteClose`)

    this.#writer.closed = {}

    const closeEvent = new CloseEvent("close", {})
    await this.writing.dispatchEvent(closeEvent, "close")
  }

  async #onWriteError(reason?: unknown) {
    console.debug(`${this.#class.name}.onWriteError`, reason)

    this.#writer.closed = { reason }
    this.#reader.error(reason)

    const error = new Error(`Errored`, { cause: reason })
    const errorEvent = new ErrorEvent("error", { error })
    await this.writing.dispatchEvent(errorEvent, "error")
  }

  async #onRead(chunk: Opaque) {
    // console.debug(this.#class.name, "<-", chunk.length, Bytes.toUtf8(chunk))

    let bytes = chunk.bytes

    if (this.#state.type === "heading" || this.#state.type === "upgrading") {
      const result = await this.#onReadHead(bytes, this.#state)

      if (!result?.length)
        return
      bytes = result
    }

    if (this.#state.type === "upgraded")
      return this.#reader.enqueue(bytes)

    if (this.#state.type === "headed") {
      if (this.#state.server_transfer.type === "none")
        return await this.#onReadNoneBody(bytes, this.#state)
      if (this.#state.server_transfer.type === "lengthed")
        return await this.#onReadLenghtedBody(bytes, this.#state)
      if (this.#state.server_transfer.type === "chunked")
        return await this.#onReadChunkedBody(bytes, this.#state)
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
    await this.reading.dispatchEvent(msgEvent, "head")

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
      this.#reader.enqueue(dchunk)
    } else {
      this.#reader.enqueue(chunk)
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
      this.#reader.enqueue(dchunk)
    } else {
      this.#reader.enqueue(chunk)
    }

    if (server_transfer.offset === server_transfer.length) {

      if (server_compression.type === "gzip") {
        const fchunk = server_compression.decoder.finish()
        this.#reader.enqueue(fchunk)
      }

      this.#reader.terminate()
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
          if (fchunk.length) this.#reader.enqueue(fchunk)
        }

        this.#reader.terminate()
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
        if (dchunk2.length) this.#reader.enqueue(dchunk2)
      } else {
        this.#reader.enqueue(chunk2)
      }

      buffer.offset = 0
      buffer.write(rest2)

      slice = buffer.buffer.subarray(0, buffer.offset)
    }
  }

  async #onWriteStart() {
    const { method, pathname, headers } = this.params

    let head = `${method} ${pathname} HTTP/1.1\r\n`
    headers.forEach((v, k) => head += `${k}: ${v}\r\n`)
    head += `\r\n`

    // console.debug(this.#class.name, "->", head.length, head)
    this.#writer.enqueue(new Opaque(Bytes.fromUtf8(head)))

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
      return this.#writer.enqueue(new Opaque(chunk))

    if (this.#state.type === "heading" || this.#state.type === "headed") {
      if (this.#state.client_transfer.type === "none")
        return await this.#onWriteNone(chunk)
      if (this.#state.client_transfer.type === "chunked")
        return await this.#onWriteChunked(chunk)
    }

    throw new Error(`Invalid state`)
  }

  async #onWriteNone(chunk: Uint8Array) {
    this.#writer.enqueue(new Opaque(chunk))
  }

  async #onWriteChunked(chunk: Uint8Array) {
    const text = new TextDecoder().decode(chunk)
    const length = text.length.toString(16)
    const line = `${length}\r\n${text}\r\n`

    // console.debug(this.#class.name, "->", line.length, line)
    this.#writer.enqueue(new Opaque(Bytes.fromUtf8(line)))
  }

  async #onWriteFlush() {
    if (this.#state.type !== "heading")
      return

    if (this.#state.client_transfer.type === "none")
      return this.#writer.enqueue(new Opaque(Bytes.fromUtf8(`\r\n`)))
    if (this.#state.client_transfer.type === "chunked")
      return this.#writer.enqueue(new Opaque(Bytes.fromUtf8(`0\r\n\r\n`)))
  }
}