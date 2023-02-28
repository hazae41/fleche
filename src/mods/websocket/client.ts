import { Cursor, Opaque, Readable, Writable } from "@hazae41/binary";
import { Bytes } from "@hazae41/bytes";
import { Naberius, pack_right, unpack } from "@hazae41/naberius";
import { CloseEvent } from "libs/events/close.js";
import { ErrorEvent } from "libs/events/error.js";
import { AsyncEventTarget } from "libs/events/target.js";
import { Iterables } from "libs/iterables/iterables.js";
import { SuperReadableStream } from "libs/streams/readable.js";
import { SuperWritableStream } from "libs/streams/writable.js";
import { Strings } from "libs/strings/strings.js";
import { HttpClientStream } from "mods/http/client.js";
import { WebSocketClose } from "./close.js";
import { WebSocketFrame } from "./frame.js";

const ACCEPT_SUFFIX = Bytes.fromUtf8("258EAFA5-E914-47DA-95CA-C5AB0DC85B11")

export interface WebSocketParams {
  readonly stream: ReadableWritablePair<Opaque, Writable>
  readonly signal?: AbortSignal
}

export class WebSocketClient extends EventTarget implements WebSocket {
  readonly #class = WebSocketClient

  readonly reading = new AsyncEventTarget()
  readonly writing = new AsyncEventTarget()

  readonly #reader: SuperWritableStream<Uint8Array>
  readonly #writer: SuperReadableStream<Uint8Array>

  readonly #frame = Cursor.allocUnsafe(16 * 1024 * 1024 * 8)

  readonly #current = new class {
    opcode?: number

    readonly buffer = Cursor.allocUnsafe(16 * 1024 * 1024)
  }

  readonly #key = Bytes.toBase64(Bytes.random(16))

  #readyState = WebSocket.CLOSED

  binaryType: BinaryType = "blob"

  onclose: ((this: WebSocket, ev: CloseEvent) => any) | null = null
  onerror: ((this: WebSocket, ev: Event) => any) | null = null
  onmessage: ((this: WebSocket, ev: MessageEvent<any>) => any) | null = null
  onopen: ((this: WebSocket, ev: Event) => any) | null = null

  readonly url: string
  readonly extensions = ""
  readonly protocol = ""

  constructor(
    url: string | URL,
    protocols: string | string[] | undefined,
    params: WebSocketParams
  ) {
    super()

    const { host, pathname, href } = new URL(url)
    const { stream, signal } = params

    this.url = href

    const headers = new Headers()

    if (!headers.has("Host"))
      headers.set("Host", host)

    headers.set("Connection", "Upgrade")
    headers.set("Upgrade", "websocket")
    headers.set("Sec-WebSocket-Key", this.#key)
    headers.set("Sec-WebSocket-Version", "13")

    const http = new HttpClientStream(stream, { pathname, method: "GET", headers })

    this.#reader = new SuperWritableStream({
      start: this.#onReadStart.bind(this),
      write: this.#onRead.bind(this)
    })

    this.#writer = new SuperReadableStream<Uint8Array>({})

    const reader = this.#reader.start()
    const writer = this.#writer.start()

    http.readable
      .pipeTo(reader, { signal })
      .then(this.#onReadClose.bind(this))
      .catch(this.#onReadError.bind(this))

    writer
      .pipeTo(http.writable, { signal })
      .then(this.#onWriteClose.bind(this))
      .catch(this.#onWriteError.bind(this))

    http.reading.addEventListener("head", this.#onHead.bind(this), { passive: true })

    this.addEventListener("close", (e) => this.onclose?.(e))
    this.addEventListener("error", (e) => this.onerror?.(e))
    this.addEventListener("message", (e) => this.onmessage?.(e))
    this.addEventListener("open", (e) => this.onopen?.(e))
  }

  addEventListener<K extends keyof WebSocketEventMap>(type: K, listener: (this: WebSocket, ev: WebSocketEventMap[K]) => any, options?: boolean | AddEventListenerOptions): void;

  addEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions | undefined) {
    super.addEventListener(type, callback, options)
  }

  get CLOSED() {
    return WebSocket.CLOSED
  }

  get CLOSING() {
    return WebSocket.CLOSING
  }

  get CONNECTING() {
    return WebSocket.CONNECTING
  }

  get OPEN() {
    return WebSocket.OPEN
  }

  get readyState() {
    return this.#readyState
  }

  get bufferedAmount() {
    return 0
  }

  #write(frame: WebSocketFrame) {
    const bits = Writable.toBytes(frame)
    const bytes = pack_right(bits)
    this.#writer.enqueue(bytes)
  }

  #split(opcode: number, data: Uint8Array) {
    const chunks = new Cursor(data).split(32768)
    const peeker = Iterables.peek(chunks)

    const first = peeker.next()
    if (first.done) return

    const { current, next } = first.value
    console.debug(this.#class.name, "->", current.length)
    const frame = new WebSocketFrame(Boolean(next.done), opcode, current, Bytes.random(4))
    this.#write(frame.prepare())

    for (const { current, next } of peeker) {
      console.debug(this.#class.name, "-> (continuation)", current.length)
      const frame = new WebSocketFrame(Boolean(next.done), WebSocketFrame.opcodes.continuation, current, Bytes.random(4))
      this.#write(frame.prepare())
    }
  }

  send(data: string | Uint8Array) {
    if (typeof data === "string")
      return this.#split(WebSocketFrame.opcodes.text, Bytes.fromUtf8(data))
    else
      return this.#split(WebSocketFrame.opcodes.binary, data)
  }

  close(code = 1000, reason?: string): void {
    const payload = Writable.toBytes(new WebSocketClose(code, reason))
    const frame = new WebSocketFrame(true, WebSocketFrame.opcodes.close, payload, Bytes.random(4))
    this.#write(frame.prepare())
    this.#readyState = this.CLOSING
    this.#reader.error(reason)
    this.#writer.close()
  }

  async #onHead(event: Event) {
    const msgEvent = event as MessageEvent<ResponseInit>
    const { headers, status } = msgEvent.data

    if (status !== 101)
      throw new Error(`Invalid HTTP status code ${status}`)

    const headers2 = new Headers(headers)

    if (!Strings.equalsIgnoreCase(headers2.get("Connection"), "Upgrade"))
      throw new Error(`Invalid Connection header value`)
    if (!Strings.equalsIgnoreCase(headers2.get("Upgrade"), "websocket"))
      throw new Error(`Invalid Upgrade header value`)

    const prehash = Bytes.concat([Bytes.fromUtf8(this.#key), ACCEPT_SUFFIX])
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-1", prehash))

    if (headers2.get("Sec-WebSocket-Accept") !== Bytes.toBase64(hash))
      throw new Error(`Invalid Sec-WebSocket-Accept header value`)

    const openEvent = new Event("open")
    this.dispatchEvent(openEvent)
  }

  async #onReadClose() {
    console.debug(`${this.#class.name}.onReadClose`)

    this.#reader.closed = {}

    const closeEvent = new CloseEvent("close", {})
    if (!await this.reading.dispatchEvent(closeEvent)) return
  }

  async #onWriteClose() {
    console.debug(`${this.#class.name}.onWriteClose`)

    this.#writer.closed = {}

    const closeEvent = new CloseEvent("close", {})
    if (!await this.writing.dispatchEvent(closeEvent)) return
  }

  async #onReadError(reason?: unknown) {
    console.debug(`${this.#class.name}.onReadError`, reason)

    this.#reader.closed = { reason }
    this.#writer.error(reason)

    const error = new Error(`Errored`, { cause: reason })
    const errorEvent = new ErrorEvent("error", { error })
    if (!await this.reading.dispatchEvent(errorEvent)) return

    await this.#onError(reason)
  }

  async #onWriteError(reason?: unknown) {
    console.debug(`${this.#class.name}.onWriteError`, reason)

    this.#writer.closed = { reason }
    this.#reader.error(reason)

    const error = new Error(`Errored`, { cause: reason })
    const errorEvent = new ErrorEvent("error", { error })
    if (!await this.writing.dispatchEvent(errorEvent)) return

    await this.#onError(reason)
  }

  async #onError(reason?: unknown) {
    const error = new Error(`Errored`, { cause: reason })
    const errorEvent = new ErrorEvent("error", { error })
    this.dispatchEvent(errorEvent)

    const closeEvent = new CloseEvent("close", { wasClean: false })
    this.dispatchEvent(closeEvent)
  }

  async #onReadStart() {
    await Naberius.initBundledOnce()
  }

  async #onRead(chunk: Uint8Array) {
    // console.debug(this.#class.name, "<-", chunk.length)

    const bits = unpack(chunk)

    if (this.#frame.offset)
      await this.#onReadBuffered(bits)
    else
      await this.#onReadDirect(bits)
  }

  async #onReadBuffered(chunk: Uint8Array) {
    this.#frame.write(chunk)
    const full = this.#frame.before

    this.#frame.offset = 0
    await this.#onReadDirect(full)
  }

  async #onReadDirect(chunk: Uint8Array) {
    const cursor = new Cursor(chunk)

    while (cursor.remaining) {
      let frame = Readable.tryRead(WebSocketFrame, cursor)

      if (!frame) {
        this.#frame.write(cursor.after)
        break
      }

      await this.#onFrame(frame)
    }
  }

  async #onFrame(frame: WebSocketFrame) {
    // console.log("<-", frame)

    if (!frame.final)
      return await this.#onNonfinalFrame(frame)

    if (frame.opcode === WebSocketFrame.opcodes.continuation)
      return await this.#onContinuationFrame(frame)
    if (frame.opcode === WebSocketFrame.opcodes.ping)
      return await this.#onPingFrame(frame)
    if (frame.opcode === WebSocketFrame.opcodes.binary)
      return await this.#onBinaryFrame(frame)
    if (frame.opcode === WebSocketFrame.opcodes.text)
      return await this.#onTextFrame(frame)
    if (frame.opcode === WebSocketFrame.opcodes.close)
      return await this.#onCloseFrame(frame)
  }

  async #onNonfinalFrame(frame: WebSocketFrame) {
    if (frame.opcode !== WebSocketFrame.opcodes.continuation) {
      if (this.#current.opcode !== undefined)
        throw new Error(`Already received a start frame`)
      this.#current.opcode = frame.opcode
    }

    this.#current.buffer.write(frame.payload)
  }

  async #onPingFrame(frame: WebSocketFrame) {
    const pong = new WebSocketFrame(true, WebSocketFrame.opcodes.pong, frame.payload, Bytes.random(4))
    this.#write(pong.prepare())
  }

  async #onBinaryFrame(frame: WebSocketFrame) {
    this.dispatchEvent(new MessageEvent("message", { data: frame.payload.buffer }))
  }

  async #onTextFrame(frame: WebSocketFrame) {
    this.dispatchEvent(new MessageEvent("message", { data: Bytes.toUtf8(frame.payload) }))
  }

  async #onCloseFrame(frame: WebSocketFrame) {
    if (this.readyState === this.OPEN) {
      const echo = new WebSocketFrame(true, WebSocketFrame.opcodes.close, frame.payload, Bytes.random(4))
      this.#write(echo.prepare())
    }

    this.#readyState = this.CLOSED

    if (frame.payload) {
      const close = Readable.fromBytes(WebSocketClose, frame.payload)
      this.#reader.error(close.reason)
      this.#writer.close()
    } else {
      this.#reader.error()
      this.#writer.close()
    }
  }

  async #onContinuationFrame(frame: WebSocketFrame) {
    this.#current.buffer.write(frame.payload)

    if (this.#current.opcode === undefined)
      throw new Error(`Received early continuation frame`)

    const payload = new Uint8Array(this.#current.buffer.bytes)
    const full = new WebSocketFrame(true, this.#current.opcode, payload)
    this.#current.opcode = undefined
    this.#current.buffer.offset = 0
    await this.#onFrame(full)
  }

}