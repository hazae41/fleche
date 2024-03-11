import { Opaque, Writable } from "@hazae41/binary"
import { Bytes } from "@hazae41/bytes"
import { CloseEvents, ErrorEvents, FullDuplex, SuperReadableStream, SuperWritableStream } from "@hazae41/cascade"
import { None, Nullable } from "@hazae41/option"
import { SuperEventTarget } from "@hazae41/plume"
import { Resizer } from "libs/resizer/resizer.js"
import { Strings } from "libs/strings/strings.js"
import { ContentLengthOverflowError, InvalidHttpStateError, UnsupportedContentEncoding, UnsupportedTransferEncoding } from "./errors.js"
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

export type HttpClientDuplexEvent =
  & CloseEvents
  & ErrorEvents
  & { head: (res: ResponseInit) => void }

export class HttpClientDuplex {

  readonly duplex = new FullDuplex<Opaque, Writable, Uint8Array, Uint8Array>()
  readonly events = new SuperEventTarget<HttpClientDuplexEvent>()

  #state: HttpState = { type: "none" }

  /**
   * Create a new HTTP 1.1 stream
   * @param subduplex
   */
  constructor(
    readonly params: HttpStreamParams
  ) {
    this.duplex.input.events.on("message", async chunk => {
      await this.#onInputMessage(chunk)
      return new None()
    })

    this.duplex.output.events.on("open", async () => {
      await this.#onOutputStart()
      return new None()
    })

    this.duplex.output.events.on("message", async chunk => {
      await this.#onOutputTransform(chunk)
      return new None()
    })

    this.duplex.output.events.on("flush", async () => {
      await this.#onOutputFlush()
      return new None()
    })
  }

  [Symbol.dispose]() {
    this.close().catch(console.error)
  }

  async [Symbol.asyncDispose]() {
    await this.close()
  }

  get inner() {
    return this.duplex.inner
  }

  get outer() {
    return this.duplex.outer
  }

  get input() {
    return this.duplex.input
  }

  get output() {
    return this.duplex.output
  }

  get closing() {
    return this.duplex.closing
  }

  get closed() {
    return this.duplex.closed
  }

  async error(reason?: unknown) {
    await this.duplex.error(reason)
  }

  async close() {
    await this.duplex.close()
  }

  async #onInputMessage(chunk: Opaque) {
    // Console.debug(this.#class.name, "<-", chunk.bytes.length, Bytes.toUtf8(chunk.bytes))

    let bytes = chunk.bytes

    if (this.#state.type === "heading" || this.#state.type === "upgrading") {
      const body = await this.#onReadHead(bytes, this.#state)

      if (!body?.length)
        return

      bytes = body
    }

    if (this.#state.type === "upgraded") {
      await this.duplex.input.enqueue(bytes)
      return
    }

    if (this.#state.type === "headed") {
      if (this.#state.server_transfer.type === "none")
        return await this.#onReadNoneBody(bytes, this.#state)
      if (this.#state.server_transfer.type === "lengthed")
        return await this.#onReadLenghtedBody(bytes, this.#state)
      if (this.#state.server_transfer.type === "chunked")
        return await this.#onReadChunkedBody(bytes, this.#state)
    }

    throw new InvalidHttpStateError()
  }

  #getTransferOrThrow(headers: Headers): HttpTransfer {
    const type = headers.get("Transfer-Encoding")

    if (type === "chunked") {
      const buffer = new Resizer()
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

    throw new UnsupportedTransferEncoding(type)
  }

  async #getCompressionStreamOrNull(type: string): Promise<Nullable<CompressionStream>> {
    if (type === "gzip")
      return new CompressionStream("gzip")
    if (type === "deflate")
      return new CompressionStream("deflate")
    return null
  }

  async #getCompressionOrNullOrThrow(headers: Headers): Promise<Nullable<HttpCompression>> {
    const type = headers.get("Content-Encoding")

    if (type === null)
      return undefined

    const encoder = await this.#getCompressionStreamOrNull(type)

    if (encoder == null)
      throw new UnsupportedContentEncoding(type)

    const sourcer = new SuperReadableStream<Uint8Array>({})

    const write = (c: Uint8Array) => this.duplex.output.enqueue(new Opaque(c))
    const sinker = new SuperWritableStream<Uint8Array>({ write })

    sourcer.substream
      .pipeThrough(encoder)
      .pipeTo(sinker.substream)
      .then(() => this.duplex.output.close())
      .catch(e => this.duplex.output.error(e))
      .catch(() => { })

    return { sourcer }
  }

  async #getDecompressionStreamOrNull(type: string): Promise<Nullable<DecompressionStream>> {
    if (type === "gzip")
      return new DecompressionStream("gzip")
    if (type === "deflate")
      return new DecompressionStream("deflate")
    return null
  }

  async #getDecompressionOrNullOrThrow(headers: Headers): Promise<Nullable<HttpCompression>> {
    const type = headers.get("Content-Encoding")

    if (type === null)
      return undefined

    const decoder = await this.#getDecompressionStreamOrNull(type)

    if (decoder == null)
      throw new UnsupportedContentEncoding(type)

    const sourcer = new SuperReadableStream<Uint8Array>({})

    const write = (c: Uint8Array) => this.duplex.input.enqueue(c)
    const sinker = new SuperWritableStream<Uint8Array>({ write })

    sourcer.substream
      .pipeThrough(decoder)
      .pipeTo(sinker.substream)
      .then(() => this.duplex.input.close())
      .catch(e => this.duplex.input.error(e))
      .catch(() => { })

    return { sourcer }
  }

  async #onReadHead(chunk: Uint8Array, state: HttpHeadingState | HttpUpgradingState): Promise<Nullable<Uint8Array>> {
    const { buffer } = state

    buffer.writeOrThrow(chunk)

    const split = Bytes.indexOf(buffer.inner.before, Lines.rnrn)

    if (split === -1)
      return undefined

    const rawHead = buffer.inner.before.subarray(0, split)
    const rawBody = buffer.inner.before.subarray(split + Lines.rnrn.length)

    const [rawStatus, ...rawHeaders] = Bytes.toUtf8(rawHead).split("\r\n")
    const [version, statusString, statusText] = rawStatus.split(" ")

    const status = Number(statusString)
    const headers = new Headers(rawHeaders.map(it => Strings.splitOnFirst(it, ": ")))

    if (state.type === "upgrading") {
      this.#state = { ...state, type: "upgraded" }
    } else {
      const server_transfer = this.#getTransferOrThrow(headers)
      const server_compression = await this.#getDecompressionOrNullOrThrow(headers)
      this.#state = { ...state, type: "headed", server_transfer, server_compression }
    }

    await this.events.emit("head", { headers, status, statusText })

    return new Uint8Array(rawBody)
  }

  async #onReadNoneBody(chunk: Uint8Array, state: HttpHeadedState) {
    if (state.server_transfer.type !== "none")
      throw new InvalidHttpStateError()

    const { server_compression } = state

    if (server_compression == null) {
      await this.duplex.input.enqueue(chunk)
    } else {
      await server_compression.sourcer.enqueue(chunk)
    }
  }

  async #onReadLenghtedBody(chunk: Uint8Array, state: HttpHeadedState) {
    if (state.server_transfer.type !== "lengthed")
      throw new InvalidHttpStateError()

    const { server_transfer, server_compression } = state

    server_transfer.offset += chunk.length

    if (server_transfer.offset > server_transfer.length)
      throw new ContentLengthOverflowError(server_transfer.offset, server_transfer.length)

    if (server_compression == null) {
      await this.duplex.input.enqueue(chunk)
    } else {
      await server_compression.sourcer.enqueue(chunk)
    }

    if (server_transfer.offset === server_transfer.length) {

      if (server_compression == null) {
        await this.duplex.input.close()
      } else {
        await server_compression.sourcer.close()
      }
    }
  }

  async #onReadChunkedBody(chunk: Uint8Array, state: HttpHeadedState) {
    if (state.server_transfer.type !== "chunked")
      throw new InvalidHttpStateError()

    const { server_transfer, server_compression } = state
    const { buffer } = server_transfer

    buffer.writeOrThrow(chunk)

    let slice = buffer.inner.before

    while (slice.length) {
      const index = Bytes.indexOf(slice, Lines.rn)

      /**
       * no \r\n 
       *  => partial chunk header 
       *  => wait for more data
       */
      if (index === -1)
        return

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
          await this.duplex.input.close()
        } else {
          await server_compression.sourcer.close()
        }

        return
      }

      /**
       * len(rest) < length + len(\r\n)
       *  => partial chunk body
       *  => wait for more data
       */
      if (rest.length < length + Lines.rn.length)
        return

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
        await this.duplex.input.enqueue(body)
      } else {
        await server_compression.sourcer.enqueue(body)
      }

      /**
       * Overwrite the buffer with the rest
       */
      buffer.inner.offset = 0
      buffer.writeOrThrow(rest)

      /**
       * Search for other chunks in the rest
       */
      slice = buffer.inner.before
    }
  }

  async #onOutputStart() {
    const { method, target, headers } = this.params

    let head = `${method} ${target} HTTP/1.1\r\n`
    headers.forEach((v, k) => head += `${k}: ${v}\r\n`)
    head += `\r\n`

    // Console.debug(this.#class.name, "->", head.length, head)
    await this.duplex.output.enqueue(new Opaque(Bytes.fromUtf8(head)))

    const buffer = new Resizer()

    if (Strings.equalsIgnoreCase(headers.get("Connection"), "Upgrade")) {
      this.#state = { type: "upgrading", buffer }
    } else {
      const client_transfer = this.#getTransferOrThrow(headers)
      const client_compression = await this.#getCompressionOrNullOrThrow(headers)
      this.#state = { type: "heading", buffer, client_transfer, client_compression }
    }
  }

  async #onOutputTransform(chunk: Uint8Array) {
    // Console.debug(this.#class.name, "->", Bytes.toUtf8(chunk))

    if (this.#state.type === "upgrading" || this.#state.type === "upgraded") {
      await this.duplex.output.enqueue(new Opaque(chunk))
      return
    }

    if (this.#state.type === "heading" || this.#state.type === "headed") {
      if (this.#state.client_transfer.type === "none")
        return await this.#onWriteNone(chunk, this.#state)
      if (this.#state.client_transfer.type === "lengthed")
        return await this.#onWriteLengthed(chunk, this.#state)
      if (this.#state.client_transfer.type === "chunked")
        return await this.#onWriteChunked(chunk, this.#state)
    }

    throw new InvalidHttpStateError()
  }

  async #onWriteNone(chunk: Uint8Array, state: HttpHeadingState | HttpHeadedState) {
    const { client_compression } = state

    if (client_compression == null) {
      await this.duplex.output.enqueue(new Opaque(chunk))
    } else {
      await client_compression.sourcer.enqueue(chunk)
    }
  }

  async #onWriteLengthed(chunk: Uint8Array, state: HttpHeadingState | HttpHeadedState) {
    if (state.client_transfer.type !== "lengthed")
      throw new InvalidHttpStateError()

    const { client_transfer, client_compression } = state

    client_transfer.offset += chunk.length

    if (client_transfer.offset > client_transfer.length)
      throw new ContentLengthOverflowError(client_transfer.offset, client_transfer.length)

    if (client_compression == null) {
      await this.duplex.output.enqueue(new Opaque(chunk))
    } else {
      await client_compression.sourcer.enqueue(chunk)
    }
  }

  async #onWriteChunked(chunk: Uint8Array, state: HttpHeadingState | HttpHeadedState) {
    const text = new TextDecoder().decode(chunk)
    const length = text.length.toString(16)
    const line = `${length}\r\n${text}\r\n`

    // Console.debug(this.#class.name, "->", line.length, line)

    const { client_compression } = state

    if (client_compression == null) {
      await this.duplex.output.enqueue(new Opaque(Bytes.fromUtf8(line)))
    } else {
      await client_compression.sourcer.enqueue(Bytes.fromUtf8(line))
    }
  }

  async #onOutputFlush() {
    if (this.#state.type === "heading") {

      if (this.#state.client_transfer.type === "none") {
        await this.duplex.output.enqueue(new Opaque(Bytes.fromUtf8(`\r\n`)))
        return
      }

      if (this.#state.client_transfer.type === "chunked") {
        await this.duplex.output.enqueue(new Opaque(Bytes.fromUtf8(`0\r\n\r\n`)))
        return
      }

    }
  }

}