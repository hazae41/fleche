import { BinaryWriteError, Opaque, Writable } from "@hazae41/binary"
import { Bytes, BytesError } from "@hazae41/bytes"
import { SuperTransformStream } from "@hazae41/cascade"
import { Cursor } from "@hazae41/cursor"
import { Foras, GzDecoder, GzEncoder } from "@hazae41/foras"
import { None, Option, Some } from "@hazae41/option"
import { CloseEvents, ErrorEvents, EventError, SuperEventTarget } from "@hazae41/plume"
import { Catched, Err, Ok, Result } from "@hazae41/result"
import { Strings } from "libs/strings/strings.js"
import { Console } from "mods/console/index.js"
import { ContentLengthOverflowError, HttpError, InvalidHttpStateError, UnsupportedContentEncoding, UnsupportedTransferEncoding } from "./errors.js"
import { HttpClientCompression, HttpHeadedState, HttpHeadingState, HttpServerCompression, HttpState, HttpTransfer, HttpUpgradingState } from "./state.js"

export interface HttpStreamParams {
  readonly method: string,
  readonly target: string,
  readonly headers: Headers,
  readonly signal?: AbortSignal
}

export type HttpClientStreamEvent = CloseEvents & ErrorEvents & {
  head: (res: ResponseInit) => Result<void, Error>
}

export class HttpClientDuplex {
  readonly #class = HttpClientDuplex

  readonly reading = new SuperEventTarget<HttpClientStreamEvent>()
  readonly writing = new SuperEventTarget<CloseEvents & ErrorEvents>()

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
      .then(r => r.ignore())
      .catch(console.error)

    write.readable
      .pipeTo(subduplex.writable, { signal })
      .then(this.#onWriteClose.bind(this))
      .catch(this.#onWriteError.bind(this))
      .then(r => r.ignore())
      .catch(console.error)

    read.readable
      .pipeTo(piper.writable)
      .catch(() => { })
  }

  async #onReadClose() {
    Console.debug(`${this.#class.name}.onReadClose`)

    this.#reader.closed = {}

    await this.reading.emit("close", [undefined])

    return Ok.void()
  }

  async #onWriteClose() {
    Console.debug(`${this.#class.name}.onWriteClose`)

    this.#writer.closed = {}

    await this.writing.emit("close", [undefined])

    return Ok.void()
  }

  async #onReadError(reason?: unknown) {
    Console.debug(`${this.#class.name}.onReadError`, { reason })

    this.#reader.closed = { reason }
    this.#writer.error(reason)

    await this.reading.emit("error", [reason])

    return Catched.throwOrErr(reason)
  }

  async #onWriteError(reason?: unknown) {
    Console.debug(`${this.#class.name}.onReadError`, { reason })

    this.#writer.closed = { reason }
    this.#reader.error(reason)

    await this.writing.emit("error", [reason])

    return Catched.throwOrErr(reason)
  }

  async #onRead(chunk: Opaque): Promise<Result<void, HttpError | BinaryWriteError | EventError>> {
    return await Result.unthrow(async t => {
      // Console.debug(this.#class.name, "<-", chunk.bytes.length, Bytes.toUtf8(chunk.bytes))

      let bytes = chunk.bytes

      if (this.#state.type === "heading" || this.#state.type === "upgrading") {
        const option = await this.#onReadHead(bytes, this.#state).then(r => r.throw(t))

        if (!option.inner?.length)
          return Ok.void()

        bytes = option.inner
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

      return new Err(new InvalidHttpStateError())
    })
  }

  #getTransferFromHeaders(headers: Headers): Result<HttpTransfer, UnsupportedTransferEncoding> {
    const type = headers.get("Transfer-Encoding")

    if (type === "chunked") {
      const buffer = new Cursor(Bytes.tryAllocUnsafe(64 * 1024).unwrap())
      return new Ok({ type, buffer })
    }

    if (type === null) {
      const length = headers.get("Content-Length")

      if (length) {
        return new Ok({ type: "lengthed", length: Number(length), offset: 0 })
      } else {
        return new Ok({ type: "none" })
      }
    }

    return new Err(new UnsupportedTransferEncoding(type))
  }

  async #getClientCompressionFromHeaders(headers: Headers): Promise<Result<HttpClientCompression, UnsupportedContentEncoding>> {
    const type = headers.get("Content-Encoding")

    if (type === null)
      return new Ok({ type: "none" })

    if (type === "gzip") {
      await Foras.initBundledOnce()
      const encoder = new GzEncoder()
      return new Ok({ type, encoder })
    }

    return new Err(new UnsupportedContentEncoding(type))
  }

  async #getServerCompressionFromHeaders(headers: Headers): Promise<Result<HttpServerCompression, UnsupportedContentEncoding>> {
    const type = headers.get("Content-Encoding")

    if (type === null)
      return new Ok({ type: "none" })

    if (type === "gzip") {
      await Foras.initBundledOnce()
      const decoder = new GzDecoder()
      return new Ok({ type, decoder })
    }

    return new Err(new UnsupportedContentEncoding(type))
  }

  async #onReadHead(chunk: Uint8Array, state: HttpHeadingState | HttpUpgradingState): Promise<Result<Option<Bytes>, HttpError | BinaryWriteError | EventError>> {
    return await Result.unthrow(async t => {
      const { buffer } = state

      buffer.tryWrite(chunk).throw(t)

      const split = buffer.buffer.indexOf("\r\n\r\n")

      if (split === -1)
        return new Ok(new None())

      const rawHead = buffer.bytes.subarray(0, split)
      const rawBody = buffer.bytes.subarray(split + "\r\n\r\n".length, buffer.offset)

      const [rawStatus, ...rawHeaders] = Bytes.toUtf8(rawHead).split("\r\n")
      const [version, statusString, statusText] = rawStatus.split(" ")

      const status = Number(statusString)
      const headers = new Headers(rawHeaders.map(it => Strings.splitOnFirst(it, ": ")))

      if (state.type === "upgrading") {
        this.#state = { ...state, type: "upgraded" }
      } else {
        const server_transfer = this.#getTransferFromHeaders(headers).throw(t)
        const server_compression = await this.#getServerCompressionFromHeaders(headers).then(r => r.throw(t))
        this.#state = { ...state, type: "headed", server_transfer, server_compression }
      }

      const returned = await this.reading.emit("head", [{ headers, status, statusText }])

      if (returned.isSome() && returned.inner.isErr())
        return returned.inner.mapErrSync(EventError.new)

      return new Ok(new Some(rawBody))
    })
  }

  async #onReadNoneBody(chunk: Uint8Array, state: HttpHeadedState): Promise<Result<void, HttpError>> {
    if (state.server_transfer.type !== "none")
      return new Err(new InvalidHttpStateError())

    const { server_compression } = state

    if (server_compression.type === "gzip") {
      server_compression.decoder.write(chunk)
      server_compression.decoder.flush()

      const dchunk = server_compression.decoder.read().copyAndDispose()
      this.#reader.enqueue(dchunk)
    } else {
      this.#reader.enqueue(chunk)
    }

    return Ok.void()
  }

  async #onReadLenghtedBody(chunk: Uint8Array, state: HttpHeadedState): Promise<Result<void, HttpError>> {
    if (state.server_transfer.type !== "lengthed")
      return new Err(new InvalidHttpStateError())

    const { server_transfer, server_compression } = state

    server_transfer.offset += chunk.length

    if (server_transfer.offset > server_transfer.length)
      return new Err(new ContentLengthOverflowError(server_transfer.offset, server_transfer.length))

    if (server_compression.type === "gzip") {
      server_compression.decoder.write(chunk)
      server_compression.decoder.flush()

      const dchunk = server_compression.decoder.read().copyAndDispose()
      this.#reader.enqueue(dchunk)
    } else {
      this.#reader.enqueue(chunk)
    }

    if (server_transfer.offset === server_transfer.length) {

      if (server_compression.type === "gzip") {
        const fchunk = server_compression.decoder.finish().copyAndDispose()
        this.#reader.enqueue(fchunk)
      }

      this.#reader.terminate()
    }

    return Ok.void()
  }

  async #onReadChunkedBody(chunk: Uint8Array, state: HttpHeadedState): Promise<Result<void, HttpError | BinaryWriteError>> {
    return await Result.unthrow(async t => {
      if (state.server_transfer.type !== "chunked")
        return new Err(new InvalidHttpStateError())

      const { server_transfer, server_compression } = state
      const { buffer } = server_transfer

      buffer.tryWrite(chunk).throw(t)

      let slice = buffer.buffer.subarray(0, buffer.offset)

      while (slice.length) {
        const index = slice.indexOf("\r\n")

        // [...] => partial header => wait
        if (index === -1) return Ok.void()

        // [length]\r\n(...) => full header => split it
        const length = parseInt(Bytes.toUtf8(slice.subarray(0, index)), 16)
        const rest = slice.subarray(index + 2)

        if (length === 0) {

          if (server_compression.type === "gzip") {
            const fchunk = server_compression.decoder.finish().copyAndDispose()
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

          const dchunk2 = server_compression.decoder.read().copyAndDispose()
          if (dchunk2.length) this.#reader.enqueue(dchunk2)
        } else {
          this.#reader.enqueue(chunk2)
        }

        buffer.offset = 0

        buffer.tryWrite(rest2).throw(t)

        slice = buffer.buffer.subarray(0, buffer.offset)
      }

      return Ok.void()
    })
  }

  async #onWriteStart(): Promise<Result<void, HttpError | BytesError>> {
    return await Result.unthrow(async t => {
      const { method, target, headers } = this.params

      let head = `${method} ${target} HTTP/1.1\r\n`
      headers.forEach((v, k) => head += `${k}: ${v}\r\n`)
      head += `\r\n`

      // Console.debug(this.#class.name, "->", head.length, head)
      this.#writer.enqueue(new Opaque(Bytes.fromUtf8(head)))

      const buffer = new Cursor(Bytes.tryAllocUnsafe(64 * 1024).throw(t))

      if (Strings.equalsIgnoreCase(headers.get("Connection"), "Upgrade")) {
        this.#state = { type: "upgrading", buffer }
      } else {
        const client_transfer = this.#getTransferFromHeaders(headers).throw(t)
        const client_compression = await this.#getClientCompressionFromHeaders(headers).then(r => r.throw(t))
        this.#state = { type: "heading", buffer, client_transfer, client_compression }
      }

      return Ok.void()
    })
  }

  async #onWrite(chunk: Uint8Array): Promise<Result<void, HttpError>> {
    // Console.debug(this.#class.name, "->", Bytes.toUtf8(chunk))

    if (this.#state.type === "upgrading" || this.#state.type === "upgraded") {
      this.#writer.enqueue(new Opaque(chunk))
      return Ok.void()
    }

    if (this.#state.type === "heading" || this.#state.type === "headed") {
      if (this.#state.client_transfer.type === "none")
        return await this.#onWriteNone(chunk)
      if (this.#state.client_transfer.type === "lengthed")
        return await this.#onWriteLengthed(chunk, this.#state)
      if (this.#state.client_transfer.type === "chunked")
        return await this.#onWriteChunked(chunk)
    }

    return new Err(new InvalidHttpStateError())
  }

  async #onWriteNone(chunk: Uint8Array): Promise<Result<void, never>> {
    this.#writer.enqueue(new Opaque(chunk))

    return Ok.void()
  }

  async #onWriteLengthed(chunk: Uint8Array, state: HttpHeadingState | HttpHeadedState) {
    if (state.client_transfer.type !== "lengthed")
      return new Err(new InvalidHttpStateError())

    const { client_transfer } = state

    if (client_transfer.offset + chunk.length > client_transfer.length)
      return new Err(new ContentLengthOverflowError(client_transfer.offset, client_transfer.length))

    this.#writer.enqueue(new Opaque(chunk))
    client_transfer.offset += chunk.length

    return Ok.void()
  }

  async #onWriteChunked(chunk: Uint8Array): Promise<Result<void, never>> {
    const text = new TextDecoder().decode(chunk)
    const length = text.length.toString(16)
    const line = `${length}\r\n${text}\r\n`

    // Console.debug(this.#class.name, "->", line.length, line)
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