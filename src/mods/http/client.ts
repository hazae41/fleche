import { Opaque, Writable } from "@hazae41/binary"
import { Bytes } from "@hazae41/bytes"
import { SuperTransformStream } from "@hazae41/cascade"
import { Cursor, CursorWriteLengthOverflowError } from "@hazae41/cursor"
import { Foras, GzDecoder, GzEncoder } from "@hazae41/foras"
import { StreamEvents, SuperEventTarget } from "@hazae41/plume"
import { Ok, Result } from "@hazae41/result"
import { Strings } from "libs/strings/strings.js"
import { HttpClientCompression, HttpHeadedState, HttpHeadingState, HttpServerCompression, HttpState, HttpTransfer, HttpUpgradingState } from "./state.js"

export interface HttpStreamParams {
  readonly pathname: string,
  readonly method: string,
  readonly headers: Headers,
  readonly signal?: AbortSignal
}

export type HttpClientStreamEvent = StreamEvents & {
  head: ResponseInit
}

export class HttpClientDuplex {
  readonly #class = HttpClientDuplex

  readonly reading = new SuperEventTarget<HttpClientStreamEvent>()
  readonly writing = new SuperEventTarget<StreamEvents>()

  readonly readable: ReadableStream<Uint8Array>
  readonly writable: WritableStream<Uint8Array>

  readonly #reader: SuperTransformStream<Opaque, Uint8Array>
  readonly #writer: SuperTransformStream<Uint8Array, Writable>

  #state: HttpState = { type: "none" }

  /**
   * Create a new HTTP 1.1 stream
   * @param subduplex
   */
  constructor(
    readonly subduplex: ReadableWritablePair<Opaque, Writable>,
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

    subduplex.readable
      .pipeTo(read.writable, { signal })
      .then(this.#onReadClose.bind(this))
      .catch(this.#onReadError.bind(this))

    write.readable
      .pipeTo(subduplex.writable, { signal })
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

    await this.reading.tryEmit("close", undefined).then(r => r.unwrap())
  }

  async #onWriteClose() {
    console.debug(`${this.#class.name}.onWriteClose`)

    this.#writer.closed = {}

    await this.reading.tryEmit("close", undefined).then(r => r.unwrap())
  }

  async #onReadError(reason?: unknown) {
    console.debug(`${this.#class.name}.onReadError`, reason)

    this.#reader.closed = { reason }
    this.#writer.error(reason)

    await this.reading.tryEmit("error", reason).then(r => r.unwrap())
  }

  async #onWriteError(reason?: unknown) {
    console.debug(`${this.#class.name}.onWriteError`, reason)

    this.#writer.closed = { reason }
    this.#reader.error(reason)

    await this.reading.tryEmit("error", reason).then(r => r.unwrap())
  }

  async #onRead(chunk: Opaque) {
    // console.debug(this.#class.name, "<-", chunk.length, Bytes.toUtf8(chunk))

    let bytes = chunk.bytes

    if (this.#state.type === "heading" || this.#state.type === "upgrading") {
      const result = await this.#onReadHead(bytes, this.#state)

      if (result.isErr())
        return result

      if (!result.inner?.length)
        return Ok.void()

      bytes = result.inner
    }

    if (this.#state.type === "upgraded") {
      this.#reader.enqueue(bytes)
      return Ok.void()
    }

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

    const write = buffer.tryWrite(chunk)

    if (write.isErr())
      return write

    const split = buffer.buffer.indexOf("\r\n\r\n")

    if (split === -1) return Ok.void()

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

    const headEvent = await this.reading.tryEmit("head", { headers, status, statusText })

    if (headEvent.isErr())
      return headEvent

    return new Ok(rawBody)
  }

  async #onReadNoneBody(chunk: Uint8Array, state: HttpHeadedState): Promise<Result<void, never>> {
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

    return Ok.void()
  }

  async #onReadLenghtedBody(chunk: Uint8Array, state: HttpHeadedState): Promise<Result<void, never>> {
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

    return Ok.void()
  }

  async #onReadChunkedBody(chunk: Uint8Array, state: HttpHeadedState): Promise<Result<void, CursorWriteLengthOverflowError>> {
    if (state.server_transfer.type !== "chunked")
      throw new Error("Invalid state")

    const { server_transfer, server_compression } = state
    const { buffer } = server_transfer

    const write = buffer.tryWrite(chunk)

    if (write.isErr())
      return write

    let slice = buffer.buffer.subarray(0, buffer.offset)

    while (slice.length) {
      const index = slice.indexOf("\r\n")

      // [...] => partial header => wait
      if (index === -1) return Ok.void()

      // [length]\r\n(...) => full header => split it
      const length = parseInt(slice.subarray(0, index).toString(), 16)
      const rest = slice.subarray(index + 2)

      if (length === 0) {

        if (server_compression.type === "gzip") {
          const fchunk = server_compression.decoder.finish()
          if (fchunk.length) this.#reader.enqueue(fchunk)
        }

        this.#reader.terminate()
        return Ok.void()
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

      const write = buffer.tryWrite(rest2)

      if (write.isErr())
        return write

      slice = buffer.buffer.subarray(0, buffer.offset)
    }

    return Ok.void()
  }

  async #onWriteStart(): Promise<Result<void, never>> {
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

    return Ok.void()
  }

  async #onWrite(chunk: Uint8Array): Promise<Result<void, never>> {
    // console.debug(this.#class.name, "->", chunk)

    if (this.#state.type === "upgrading" || this.#state.type === "upgraded") {
      this.#writer.enqueue(new Opaque(chunk))
      return Ok.void()
    }

    if (this.#state.type === "heading" || this.#state.type === "headed") {
      if (this.#state.client_transfer.type === "none")
        return await this.#onWriteNone(chunk)
      if (this.#state.client_transfer.type === "chunked")
        return await this.#onWriteChunked(chunk)
    }

    throw new Error(`Invalid state`)
  }

  async #onWriteNone(chunk: Uint8Array): Promise<Result<void, never>> {
    this.#writer.enqueue(new Opaque(chunk))

    return Ok.void()
  }

  async #onWriteChunked(chunk: Uint8Array): Promise<Result<void, never>> {
    const text = new TextDecoder().decode(chunk)
    const length = text.length.toString(16)
    const line = `${length}\r\n${text}\r\n`

    // console.debug(this.#class.name, "->", line.length, line)
    this.#writer.enqueue(new Opaque(Bytes.fromUtf8(line)))

    return Ok.void()
  }

  async #onWriteFlush(): Promise<Result<void, never>> {
    if (this.#state.type === "heading") {

      if (this.#state.client_transfer.type === "none") {
        this.#writer.enqueue(new Opaque(Bytes.fromUtf8(`\r\n`)))
        return Ok.void()
      }

      if (this.#state.client_transfer.type === "chunked") {
        this.#writer.enqueue(new Opaque(Bytes.fromUtf8(`0\r\n\r\n`)))
        return Ok.void()
      }

    }

    return Ok.void()
  }
}