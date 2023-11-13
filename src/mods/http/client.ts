import { Opaque, Writable } from "@hazae41/binary"
import { Bytes } from "@hazae41/bytes"
import { SuperReadableStream, SuperTransformStream, SuperWritableStream } from "@hazae41/cascade"
import { Cursor } from "@hazae41/cursor"
import { None, Nullable, Option, Some } from "@hazae41/option"
import { CloseEvents, ErrorEvents, EventError, SuperEventTarget } from "@hazae41/plume"
import { Err, Ok, Result } from "@hazae41/result"
import { Strings } from "libs/strings/strings.js"
import { Console } from "mods/console/index.js"
import { ContentLengthOverflowError, HttpError, InvalidHttpStateError, UnsupportedContentEncoding, UnsupportedTransferEncoding } from "./errors.js"
import { HttpCompression, HttpHeadedState, HttpHeadingState, HttpState, HttpTransfer, HttpUpgradingState } from "./state.js"

export namespace Lines {
  export const rn = Bytes.fromUtf8("\r\n")
  export const rnrn = Bytes.fromUtf8("\r\n\r\n")
}

export interface HttpStreamParams {
  readonly method: string,
  readonly target: string,
  readonly headers: Headers
}

export type HttpClientStreamEvent = CloseEvents & ErrorEvents & {
  head: (res: ResponseInit) => Result<void, Error>
}

export class HttpClientDuplex {
  readonly #class = HttpClientDuplex

  readonly events = {
    input: new SuperEventTarget<HttpClientStreamEvent>(),
    output: new SuperEventTarget<CloseEvents & ErrorEvents>()
  } as const

  readonly inner: ReadableWritablePair<Writable, Opaque>
  readonly outer: ReadableWritablePair<Uint8Array, Uint8Array>

  readonly #input: SuperTransformStream<Opaque, Uint8Array>
  readonly #output: SuperTransformStream<Uint8Array, Writable>

  #state: HttpState = { type: "none" }

  /**
   * Create a new HTTP 1.1 stream
   * @param subduplex
   */
  constructor(
    readonly params: HttpStreamParams
  ) {
    /**
     * Input pipeline (outer <- inner) (client <- server)
     */
    this.#input = new SuperTransformStream({
      transform: this.#onInputTransform.bind(this),
    })

    /**
     * Output pipeline (outer -> inner) (client -> server)
     */
    this.#output = new SuperTransformStream({
      start: this.#onOutputStart.bind(this),
      transform: this.#onOutputTransform.bind(this),
      flush: this.#onOutputFlush.bind(this),
    })

    const preInputer = this.#input.start()
    const preOutputer = this.#output.start()

    const postInputer = new TransformStream<Uint8Array, Uint8Array>({})
    const postOutputer = new TransformStream<Writable, Writable>({})

    /**
     * Inner protocol (TCP? TLS?)
     */
    this.inner = {
      readable: postOutputer.readable,
      writable: preInputer.writable
    }

    /**
     * Outer protocol (App? WebSocket?)
     */
    this.outer = {
      readable: postInputer.readable,
      writable: preOutputer.writable
    }

    preInputer.readable
      .pipeTo(postInputer.writable)
      .then(() => this.#onInputClose())
      .catch(e => this.#onInputError(e))
      .catch(() => { })

    preOutputer.readable
      .pipeTo(postOutputer.writable)
      .then(() => this.#onOutputClose())
      .catch(e => this.#onOutputError(e))
      .catch(() => { })
  }

  async #onInputClose() {
    Console.debug(`${this.#class.name}.onReadClose`)

    this.#input.closed = {}

    await this.events.input.emit("close", [undefined])
  }

  async #onOutputClose() {
    Console.debug(`${this.#class.name}.onWriteClose`)

    this.#output.closed = {}

    await this.events.output.emit("close", [undefined])
  }

  async #onInputError(reason?: unknown) {
    Console.debug(`${this.#class.name}.onReadError`, { reason })

    this.#input.closed = { reason }
    this.#output.error(reason)

    await this.events.input.emit("error", [reason])
  }

  async #onOutputError(reason?: unknown) {
    Console.debug(`${this.#class.name}.onReadError`, { reason })

    this.#output.closed = { reason }
    this.#input.error(reason)

    await this.events.output.emit("error", [reason])
  }

  async #onInputTransform(chunk: Opaque): Promise<Result<void, Error>> {
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
        this.#input.enqueue(bytes)
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
      const buffer = new Cursor(Bytes.alloc(64 * 1024))
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

  async #getCompression(type: string): Promise<Nullable<CompressionStream>> {
    if (type === "gzip")
      return new CompressionStream("gzip")
    if (type === "deflate")
      return new CompressionStream("deflate")
    return null
  }

  async #getClientCompressionFromHeaders(headers: Headers): Promise<Result<Nullable<HttpCompression>, UnsupportedContentEncoding>> {
    const type = headers.get("Content-Encoding")

    if (type === null)
      return new Ok(undefined)

    const encoder = await this.#getCompression(type)

    if (encoder == null)
      return new Err(new UnsupportedContentEncoding(type))

    const sourcer = new SuperReadableStream<Uint8Array>({})

    const write = (c: Uint8Array) => this.#output.enqueue(new Opaque(c))
    const sinker = new SuperWritableStream<Uint8Array>({ write })

    sourcer.start()
      .pipeThrough(encoder)
      .pipeTo(sinker.start())
      .then(() => this.#output.terminate())
      .catch(e => this.#output.error(e))
      .catch(() => { })

    return new Ok({ type, sourcer })
  }

  async #getDecompression(type: string): Promise<Nullable<DecompressionStream>> {
    if (type === "gzip")
      return new DecompressionStream("gzip")
    if (type === "deflate")
      return new DecompressionStream("deflate")
    return null
  }

  async #getServerCompressionFromHeaders(headers: Headers): Promise<Result<Nullable<HttpCompression>, UnsupportedContentEncoding>> {
    const type = headers.get("Content-Encoding")

    if (type === null)
      return new Ok(undefined)

    const decoder = await this.#getDecompression(type)

    if (decoder == null)
      return new Err(new UnsupportedContentEncoding(type))

    const sourcer = new SuperReadableStream<Uint8Array>({})

    const write = (c: Uint8Array) => this.#input.enqueue(c)
    const sinker = new SuperWritableStream<Uint8Array>({ write })

    sourcer.start()
      .pipeThrough(decoder)
      .pipeTo(sinker.start())
      .then(() => this.#input.terminate())
      .catch(e => this.#input.error(e))
      .catch(() => { })

    return new Ok({ type, sourcer })
  }

  async #onReadHead(chunk: Uint8Array, state: HttpHeadingState | HttpUpgradingState): Promise<Result<Option<Uint8Array>, Error>> {
    return await Result.unthrow(async t => {
      const { buffer } = state

      buffer.tryWrite(chunk).throw(t)

      const split = Bytes.indexOf(buffer.before, Lines.rnrn)

      if (split === -1)
        return new Ok(new None())

      const rawHead = buffer.before.subarray(0, split)
      const rawBody = buffer.before.subarray(split + Lines.rnrn.length)

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

      const returned = await this.events.input.emit("head", [{ headers, status, statusText }])

      if (returned.isSome() && returned.inner.isErr())
        return returned.inner.mapErrSync(EventError.new)

      return new Ok(new Some(new Uint8Array(rawBody)))
    })
  }

  async #onReadNoneBody(chunk: Uint8Array, state: HttpHeadedState): Promise<Result<void, Error>> {
    return await Result.unthrow(async t => {
      if (state.server_transfer.type !== "none")
        return new Err(new InvalidHttpStateError())

      const { server_compression } = state

      if (server_compression == null) {
        this.#input.enqueue(chunk)
      } else {
        server_compression.sourcer.enqueue(chunk)
      }

      return Ok.void()
    })
  }

  async #onReadLenghtedBody(chunk: Uint8Array, state: HttpHeadedState): Promise<Result<void, Error>> {
    return await Result.unthrow(async t => {
      if (state.server_transfer.type !== "lengthed")
        return new Err(new InvalidHttpStateError())

      const { server_transfer, server_compression } = state

      server_transfer.offset += chunk.length

      if (server_transfer.offset > server_transfer.length)
        return new Err(new ContentLengthOverflowError(server_transfer.offset, server_transfer.length))

      if (server_compression == null) {
        this.#input.enqueue(chunk)
      } else {
        server_compression.sourcer.enqueue(chunk)
      }

      if (server_transfer.offset === server_transfer.length) {

        if (server_compression == null) {
          this.#input.terminate()
        } else {
          server_compression.sourcer.close()
        }
      }

      return Ok.void()
    })
  }

  async #onReadChunkedBody(chunk: Uint8Array, state: HttpHeadedState): Promise<Result<void, Error>> {
    return await Result.unthrow(async t => {
      if (state.server_transfer.type !== "chunked")
        return new Err(new InvalidHttpStateError())

      const { server_transfer, server_compression } = state
      const { buffer } = server_transfer

      buffer.tryWrite(chunk).throw(t)

      let slice = buffer.before

      while (slice.length) {
        const index = Bytes.indexOf(slice, Lines.rn)

        /**
         * no \r\n 
         *  => partial chunk header 
         *  => wait for more data
         */
        if (index === -1)
          return Ok.void()

        /**
         * [length]\r\n(rest) 
         *  => full chunk header 
         *  => extract length
         */

        const lengthBytes = slice.subarray(0, index)
        const lengthUtf8 = Bytes.toUtf8(lengthBytes)
        const length = parseInt(lengthUtf8, 16)

        let rest = slice.subarray(index + 2)

        /**
         * length === 0
         *  => end of chunks
         *  => close the stream
         */
        if (length === 0) {

          /**
           * Close the stream
           */
          if (server_compression == null) {
            this.#input.terminate()
          } else {
            server_compression.sourcer.close()
          }

          return Ok.void()
        }

        /**
         * len(rest) < length + len(\r\n)
         *  => partial chunk body
         *  => wait for more data
         */
        if (rest.length < length + Lines.rn.length)
          return Ok.void()

        /**
         * ([length]\r\n)[chunk]\r\n(rest)
         *  => full chunk body 
         *  => split body and rest
         */

        /**
         * Copy the body
         */
        const body = rest.slice(0, length)

        /**
         * Rest is at the end of the chunk + len(\r\n)
         */
        rest = rest.subarray(length + Lines.rn.length)

        /**
         * Enqueue the body
         */
        if (server_compression == null) {
          this.#input.enqueue(body)
        } else {
          server_compression.sourcer.enqueue(body)
        }

        /**
         * Overwrite the buffer with the rest
         */
        buffer.offset = 0
        buffer.tryWrite(rest).throw(t)

        /**
         * Search for other chunks in the rest
         */
        slice = buffer.before
      }

      return Ok.void()
    })
  }

  async #onOutputStart(): Promise<Result<void, Error>> {
    return await Result.unthrow(async t => {
      const { method, target, headers } = this.params

      let head = `${method} ${target} HTTP/1.1\r\n`
      headers.forEach((v, k) => head += `${k}: ${v}\r\n`)
      head += `\r\n`

      // Console.debug(this.#class.name, "->", head.length, head)
      this.#output.enqueue(new Opaque(Bytes.fromUtf8(head)))

      const buffer = new Cursor(Bytes.alloc(64 * 1024))

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

  async #onOutputTransform(chunk: Uint8Array): Promise<Result<void, HttpError>> {
    // Console.debug(this.#class.name, "->", Bytes.toUtf8(chunk))

    if (this.#state.type === "upgrading" || this.#state.type === "upgraded") {
      this.#output.enqueue(new Opaque(chunk))
      return Ok.void()
    }

    if (this.#state.type === "heading" || this.#state.type === "headed") {
      if (this.#state.client_transfer.type === "none")
        return await this.#onWriteNone(chunk, this.#state)
      if (this.#state.client_transfer.type === "lengthed")
        return await this.#onWriteLengthed(chunk, this.#state)
      if (this.#state.client_transfer.type === "chunked")
        return await this.#onWriteChunked(chunk, this.#state)
    }

    return new Err(new InvalidHttpStateError())
  }

  async #onWriteNone(chunk: Uint8Array, state: HttpHeadingState | HttpHeadedState): Promise<Result<void, never>> {
    const { client_compression } = state

    if (client_compression == null) {
      this.#output.enqueue(new Opaque(chunk))
    } else {
      client_compression.sourcer.enqueue(chunk)
    }

    return Ok.void()
  }

  async #onWriteLengthed(chunk: Uint8Array, state: HttpHeadingState | HttpHeadedState) {
    if (state.client_transfer.type !== "lengthed")
      return new Err(new InvalidHttpStateError())

    const { client_transfer, client_compression } = state

    client_transfer.offset += chunk.length

    if (client_transfer.offset > client_transfer.length)
      return new Err(new ContentLengthOverflowError(client_transfer.offset, client_transfer.length))

    if (client_compression == null) {
      this.#output.enqueue(new Opaque(chunk))
    } else {
      client_compression.sourcer.enqueue(chunk)
    }

    return Ok.void()
  }

  async #onWriteChunked(chunk: Uint8Array, state: HttpHeadingState | HttpHeadedState): Promise<Result<void, never>> {
    const text = new TextDecoder().decode(chunk)
    const length = text.length.toString(16)
    const line = `${length}\r\n${text}\r\n`

    // Console.debug(this.#class.name, "->", line.length, line)

    const { client_compression } = state

    if (client_compression == null) {
      this.#output.enqueue(new Opaque(Bytes.fromUtf8(line)))
    } else {
      client_compression.sourcer.enqueue(Bytes.fromUtf8(line))
    }

    return Ok.void()
  }

  async #onOutputFlush(): Promise<Result<void, never>> {
    if (this.#state.type === "heading") {

      if (this.#state.client_transfer.type === "none") {
        this.#output.enqueue(new Opaque(Bytes.fromUtf8(`\r\n`)))
        return Ok.void()
      }

      if (this.#state.client_transfer.type === "chunked") {
        this.#output.enqueue(new Opaque(Bytes.fromUtf8(`0\r\n\r\n`)))
        return Ok.void()
      }

    }

    return Ok.void()
  }

}