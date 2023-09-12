import { Base64 } from "@hazae41/base64";
import { BinaryError, BinaryWriteError, Opaque, Readable, Writable } from "@hazae41/binary";
import { Box } from "@hazae41/box";
import { Bytes } from "@hazae41/bytes";
import { ControllerError, SuperReadableStream, SuperWritableStream } from "@hazae41/cascade";
import { Cursor } from "@hazae41/cursor";
import { Naberius, pack_right, unpack } from "@hazae41/naberius";
import { Some } from "@hazae41/option";
import { CloseEvents, ErrorEvents, SuperEventTarget } from "@hazae41/plume";
import { Catched, Err, Ok, Result } from "@hazae41/result";
import { Iterators } from "libs/iterables/iterators.js";
import { Strings } from "libs/strings/strings.js";
import { HttpClientDuplex } from "mods/http/client.js";
import { WebSocketClose } from "./close.js";
import { ExpectedContinuationFrameError, InvalidHttpHeaderValue, InvalidHttpStatusCode, UnexpectedContinuationFrameError, WebSocketFrameError, WebSocketHttpError } from "./errors.js";
import { WebSocketFrame } from "./frame.js";

const ACCEPT_SUFFIX = Bytes.fromUtf8("258EAFA5-E914-47DA-95CA-C5AB0DC85B11")

export interface WebSocketClientDuplexParams {
  readonly subduplex: ReadableWritablePair<Opaque, Writable>
  readonly signal?: AbortSignal
}

export class WebSocketMessageState {

  readonly buffer = new Cursor(Bytes.tryAllocUnsafe(64 * 1024).unwrap())

  opcode?: number

}

export class WebSocketClientDuplex extends EventTarget implements WebSocket {
  readonly #class = WebSocketClientDuplex

  readonly reading = new SuperEventTarget<CloseEvents & ErrorEvents>()
  readonly writing = new SuperEventTarget<CloseEvents & ErrorEvents>()

  readonly #reader: SuperWritableStream<Uint8Array>
  readonly #writer: SuperReadableStream<Uint8Array>

  readonly #frame = new Cursor(Bytes.tryAllocUnsafe(128 * 1024 * 8).unwrap())

  readonly #current = new WebSocketMessageState()

  readonly #key = Base64.get().tryEncodePadded(Bytes.tryRandom(16).unwrap()).unwrap()

  #readyState: number = WebSocket.CONNECTING

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
    params: WebSocketClientDuplexParams
  ) {
    super()

    const { host, pathname, search, href } = new URL(url)
    const { subduplex: stream, signal } = params

    this.url = href

    const target = pathname + search
    const headers = new Headers()

    if (!headers.has("Host"))
      headers.set("Host", host)

    headers.set("Connection", "Upgrade")
    headers.set("Upgrade", "websocket")
    headers.set("Sec-WebSocket-Key", this.#key)
    headers.set("Sec-WebSocket-Version", "13")

    const http = new HttpClientDuplex(stream, { target, method: "GET", headers })

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
      .then(r => r.ignore())
      .catch(console.error)

    writer
      .pipeTo(http.writable, { signal })
      .then(this.#onWriteClose.bind(this))
      .catch(this.#onWriteError.bind(this))
      .then(r => r.ignore())
      .catch(console.error)

    http.reading.on("head", this.#onHead.bind(this), { passive: true })

    this.addEventListener("close", (e) => this.onclose?.(e))
    this.addEventListener("error", (e) => this.onerror?.(e))
    this.addEventListener("message", (e) => this.onmessage?.(e))
    this.addEventListener("open", (e) => this.onopen?.(e))
  }

  addEventListener<K extends keyof WebSocketEventMap>(type: K, listener: (this: WebSocket, ev: WebSocketEventMap[K]) => any, options?: boolean | AddEventListenerOptions): void;

  addEventListener(type: string, callback: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void

  addEventListener(type: string, callback: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void {
    super.addEventListener(type, callback, options)
  }

  removeEventListener<K extends keyof WebSocketEventMap>(type: K, listener: (this: WebSocket, ev: WebSocketEventMap[K]) => any, options?: boolean | EventListenerOptions): void;

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions): void

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions): void {
    super.removeEventListener(type, listener, options)
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

  send(data: string | ArrayBufferLike | ArrayBufferView | Blob) {
    Result
      .runAndUnwrap(async () => await this.trySend(data))
      .catch(e => console.debug(`${this.#class.name}.send`, { e }))
  }

  async trySend(data: string | ArrayBufferLike | ArrayBufferView | Blob): Promise<Result<void, BinaryError | ControllerError>> {
    if (typeof data === "string")
      return this.#trySplit(WebSocketFrame.opcodes.text, Bytes.fromUtf8(data))
    else if (data instanceof Blob)
      return this.#trySplit(WebSocketFrame.opcodes.text, new Uint8Array(await data.arrayBuffer()))
    else if ("buffer" in data)
      return this.#trySplit(WebSocketFrame.opcodes.binary, Bytes.fromView(data))
    else
      return this.#trySplit(WebSocketFrame.opcodes.text, new Uint8Array(data))
  }

  close(code = 1000, reason?: string): void {
    Result
      .runAndUnwrap(async () => this.tryClose(code, reason))
      .catch(e => console.debug(`${this.#class.name}.close`, { e }))
  }

  tryClose(code = 1000, reason?: string): Result<void, BinaryWriteError | ControllerError> {
    return Result.unthrowSync(t => {
      const final = true
      const opcode = WebSocketFrame.opcodes.close
      const close = WebSocketClose.tryNew(code, reason)
      const payload = Writable.tryWriteToBytes(close.get()).throw(t)

      const mask = Bytes.random(4)

      const frame = WebSocketFrame.tryNew({ final, opcode, payload, mask })

      this.#tryWrite(frame.get()).throw(t)
      this.#readyState = this.CLOSING

      return Ok.void()
    })
  }

  async #onReadClose() {
    console.debug(`${this.#class.name}.onReadClose`)

    this.#reader.closed = {}

    await this.reading.emit("close", [undefined])

    return Ok.void()
  }

  async #onWriteClose() {
    console.debug(`${this.#class.name}.onWriteClose`)

    this.#writer.closed = {}

    await this.writing.emit("close", [undefined])

    return Ok.void()
  }

  async #onReadError(reason?: unknown) {
    console.debug(`${this.#class.name}.onReadError`, { reason })

    this.#reader.closed = { reason }
    this.#writer.error(reason)

    await this.reading.emit("error", [reason])

    await this.#onError(reason)

    return Catched.throwOrErr(reason)
  }

  async #onWriteError(reason?: unknown) {
    console.debug(`${this.#class.name}.onWriteError`, { reason })

    this.#writer.closed = { reason }
    this.#reader.error(reason)

    await this.writing.emit("error", [reason])

    await this.#onError(reason)

    return Catched.throwOrErr(reason)
  }

  async #onError(error?: unknown) {
    const errorEvent = new ErrorEvent("error", { error })
    this.dispatchEvent(errorEvent)

    const closeEvent = new CloseEvent("close", { wasClean: false })
    this.dispatchEvent(closeEvent)
  }

  async #onHead(init: ResponseInit): Promise<Some<Result<void, WebSocketHttpError>>> {
    const headers = new Headers(init.headers)

    if (init.status !== 101)
      return new Some(new Err(new InvalidHttpStatusCode(init.status)))

    if (!Strings.equalsIgnoreCase(headers.get("Connection"), "Upgrade"))
      return new Some(new Err(new InvalidHttpHeaderValue("Connection")))
    if (!Strings.equalsIgnoreCase(headers.get("Upgrade"), "websocket"))
      return new Some(new Err(new InvalidHttpHeaderValue("Upgrade")))

    const prehash = Bytes.concat([Bytes.fromUtf8(this.#key), ACCEPT_SUFFIX])
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-1", prehash))

    const hashBase64 = Base64.get().tryEncodePadded(hash).unwrap()

    if (headers.get("Sec-WebSocket-Accept") !== hashBase64)
      return new Some(new Err(new InvalidHttpHeaderValue("Sec-WebSocket-Accept")))

    this.#readyState = this.OPEN

    const openEvent = new Event("open")
    this.dispatchEvent(openEvent)

    return new Some(Ok.void())
  }

  async #onReadStart(): Promise<Result<void, never>> {
    await Naberius.initBundledOnce()

    return Ok.void()
  }

  async #onRead(chunk: Uint8Array): Promise<Result<void, WebSocketFrameError | BinaryError | ControllerError>> {
    // console.debug(this.#class.name, "<-", chunk.length)

    using bits = new Box(unpack(chunk))

    if (this.#frame.offset)
      return await this.#onReadBuffered(bits)
    else
      return await this.#onReadDirect(bits.copyAndDispose())
  }

  async #onReadBuffered(bits: Box<Naberius.Slice>): Promise<Result<void, WebSocketFrameError | BinaryError | ControllerError>> {
    return await Result.unthrow(async t => {
      using bits2 = bits.moveIfNotMoved()

      this.#frame.tryWrite(bits2.inner.bytes).throw(t)
      const full = new Uint8Array(this.#frame.before)

      this.#frame.offset = 0
      return await this.#onReadDirect(full)
    })
  }

  async #onReadDirect(chunk: Uint8Array): Promise<Result<void, WebSocketFrameError | BinaryError | ControllerError>> {
    return await Result.unthrow(async t => {
      const cursor = new Cursor(chunk)

      while (cursor.remaining) {
        const frame = Readable.tryReadOrRollback(WebSocketFrame, cursor).ignore()

        if (frame.isErr()) {
          this.#frame.tryWrite(cursor.after).throw(t)
          break
        }

        await this.#onFrame(frame.get()).then(r => r.throw(t))
      }

      return Ok.void()
    })
  }

  async #onFrame(frame: WebSocketFrame) {
    // console.debug("<-", frame)

    if (frame.final)
      return await this.#onFinalFrame(frame)
    else
      return await this.#onStartFrame(frame)
  }

  async #onFinalFrame(frame: WebSocketFrame): Promise<Result<void, WebSocketFrameError | BinaryError | ControllerError>> {
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

    console.warn(`Unknown opcode`)
    return Ok.void()
  }

  async #onPingFrame(frame: WebSocketFrame): Promise<Result<void, BinaryWriteError | ControllerError>> {
    return await Result.unthrow(async t => {
      const final = true
      const opcode = WebSocketFrame.opcodes.pong
      const payload = frame.payload
      const mask = Bytes.tryRandom(4).throw(t)

      const pong = WebSocketFrame.tryNew({ final, opcode, payload, mask })

      return this.#tryWrite(pong.get())
    })
  }

  async #onBinaryFrame(frame: WebSocketFrame): Promise<Result<void, never>> {
    if (this.binaryType === "blob")
      this.dispatchEvent(new MessageEvent("message", { data: new Blob([frame.payload]) }))
    else
      this.dispatchEvent(new MessageEvent("message", { data: frame.payload.buffer }))

    return Ok.void()
  }

  async #onTextFrame(frame: WebSocketFrame): Promise<Result<void, never>> {
    this.dispatchEvent(new MessageEvent("message", { data: Bytes.toUtf8(frame.payload) }))

    return Ok.void()
  }

  async #onCloseFrame(frame: WebSocketFrame): Promise<Result<void, BinaryError | ControllerError>> {
    return await Result.unthrow(async t => {
      if (this.readyState === this.OPEN) {
        const final = true
        const opcode = WebSocketFrame.opcodes.close
        const payload = frame.payload
        const mask = Bytes.random(4)

        const echo = WebSocketFrame.tryNew({ final, opcode, payload, mask })

        return this.#tryWrite(echo.get())
      }

      this.#readyState = this.CLOSED

      if (frame.payload.length) {
        const close = Readable.tryReadFromBytes(WebSocketClose, frame.payload).throw(t)

        const reason = close.reason.mapSync(Bytes.toUtf8)

        this.#reader.tryError(reason.get()).inspectErrSync(console.warn).ignore()
        this.#writer.tryClose().inspectErrSync(console.warn).ignore()
      } else {
        this.#reader.tryError().inspectErrSync(console.warn).ignore()
        this.#writer.tryClose().inspectErrSync(console.warn).ignore()
      }

      return Ok.void()
    })
  }

  async #onStartFrame(frame: WebSocketFrame): Promise<Result<void, WebSocketFrameError | BinaryWriteError>> {
    if (frame.opcode !== WebSocketFrame.opcodes.continuation) {

      if (this.#current.opcode !== undefined)
        return new Err(new ExpectedContinuationFrameError())

      this.#current.opcode = frame.opcode
    }

    return this.#current.buffer.tryWrite(frame.payload)
  }

  async #onContinuationFrame(frame: WebSocketFrame): Promise<Result<void, WebSocketFrameError | BinaryError | ControllerError>> {
    return await Result.unthrow(async t => {
      this.#current.buffer.tryWrite(frame.payload).throw(t)

      if (this.#current.opcode === undefined)
        return new Err(new UnexpectedContinuationFrameError())

      const final = true
      const opcode = this.#current.opcode
      const payload = new Uint8Array(this.#current.buffer.before)
      const full = WebSocketFrame.tryNew({ final, opcode, payload })

      this.#current.opcode = undefined
      this.#current.buffer.offset = 0

      return await this.#onFinalFrame(full.get())
    })
  }

  #tryWrite(frame: WebSocketFrame): Result<void, BinaryWriteError | ControllerError> {
    return Result.unthrowSync(t => {
      const bits = Writable.tryWriteToBytes(frame).throw(t)
      using bytes = pack_right(bits)

      this.#writer.tryEnqueue(bytes.bytes).throw(t)

      return Ok.void()
    })
  }

  #trySplit(opcode: number, data: Uint8Array): Result<void, BinaryError | ControllerError> {
    return Result.unthrowSync(t => {
      const chunks = new Cursor(data).trySplit(32_768)
      const peeker = Iterators.peek(chunks)

      const first = peeker.next()

      if (first.done)
        return Ok.void()

      const { current, next } = first.value
      const final = Boolean(next.done)
      const mask = Bytes.tryRandom(4).throw(t)

      const frame = WebSocketFrame.tryNew({ final, opcode, payload: current, mask })

      // console.debug(this.#class.name, "->", current.length)
      this.#tryWrite(frame.get()).throw(t)

      let result = peeker.next()

      for (; !result.done; result = peeker.next()) {
        const { current, next } = result.value

        const final = Boolean(next.done)
        const opcode = WebSocketFrame.opcodes.continuation
        const mask = Bytes.random(4)

        const frame = WebSocketFrame.tryNew({ final, opcode, payload: current, mask })

        // console.debug(this.#class.name, "-> (continuation)", current.length)
        this.#tryWrite(frame.get()).throw(t)
      }

      return result.value
    })
  }

}