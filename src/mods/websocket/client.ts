import { Base64 } from "@hazae41/base64";
import { Readable, Writable } from "@hazae41/binary";
import { Bytes } from "@hazae41/bytes";
import { HalfDuplex } from "@hazae41/cascade";
import { Cursor } from "@hazae41/cursor";
import { Future } from "@hazae41/future";
import { Naberius, pack_right, unpack } from "@hazae41/naberius";
import { None } from "@hazae41/option";
import { CloseEvents, ErrorEvents, Plume, SuperEventTarget } from "@hazae41/plume";
import { Iterators } from "libs/iterables/iterators.js";
import { Resizer } from "libs/resizer/resizer.js";
import { Strings } from "libs/strings/strings.js";
import { Console } from "mods/console/index.js";
import { HttpClientDuplex } from "mods/http/client.js";
import { WebSocketClose } from "./close.js";
import { ExpectedContinuationFrameError, InvalidHttpHeaderValue, InvalidHttpStatusCode, UnexpectedContinuationFrameError } from "./errors.js";
import { WebSocketFrame } from "./frame.js";

const ACCEPT_SUFFIX = Bytes.fromUtf8("258EAFA5-E914-47DA-95CA-C5AB0DC85B11")

export class WebSocketMessageState {

  readonly buffer = new Cursor(Bytes.alloc(64 * 1024))

  opcode?: number

}

export type WebSocketClientDuplexEvents =
  & CloseEvents
  & ErrorEvents
  & { pong: () => void }

export class WebSocketClientDuplex extends EventTarget implements WebSocket {
  readonly #class = WebSocketClientDuplex

  readonly http: HttpClientDuplex

  readonly duplex = new HalfDuplex<Uint8Array, Uint8Array>()
  readonly events = new SuperEventTarget<WebSocketClientDuplexEvents>()

  readonly #buffer = new Resizer()

  readonly #current = new WebSocketMessageState()

  readonly #keyBytes = Bytes.random(16)
  readonly #keyBase64 = Base64.get().encodePaddedOrThrow(this.#keyBytes)

  #readyState: number = WebSocket.CONNECTING

  binaryType: BinaryType = "blob"

  onclose: ((this: WebSocket, ev: CloseEvent) => any) | null = null
  onerror: ((this: WebSocket, ev: Event) => any) | null = null
  onmessage: ((this: WebSocket, ev: MessageEvent<any>) => any) | null = null
  onopen: ((this: WebSocket, ev: Event) => any) | null = null

  readonly url: string
  readonly extensions = ""
  readonly protocol = ""

  constructor(url: string | URL, protocols?: string | string[]) {
    super()

    this.addEventListener("close", (e) => this.onclose?.(e))
    this.addEventListener("error", (e) => this.onerror?.(e))
    this.addEventListener("message", (e) => this.onmessage?.(e))
    this.addEventListener("open", (e) => this.onopen?.(e))

    const { host, pathname, search, href } = new URL(url)

    this.url = href

    const target = pathname + search
    const headers = new Headers()

    if (!headers.has("Host"))
      headers.set("Host", host)

    headers.set("Connection", "Upgrade")
    headers.set("Upgrade", "websocket")
    headers.set("Sec-WebSocket-Key", this.#keyBase64)
    headers.set("Sec-WebSocket-Version", "13")

    this.http = new HttpClientDuplex({ target, method: "GET", headers })

    this.duplex.events.on("close", async () => {
      await this.#onDuplexClose()
      return new None()
    })

    this.duplex.events.on("error", async (e) => {
      await this.#onDuplexError(e)
      return new None()
    })

    this.duplex.input.events.on("open", async () => {
      await this.#onInputStart()
      return new None()
    })

    this.duplex.input.events.on("message", async chunk => {
      await this.#onInputMessage(chunk)
      return new None()
    })

    this.http.events.on("head", this.#onHead.bind(this), { passive: true })

    this.http.outer.readable.pipeTo(this.duplex.inner.writable).catch(() => { })
    this.duplex.inner.readable.pipeTo(this.http.outer.writable).catch(() => { })
  }

  [Symbol.dispose]() {
    this.duplex.close().catch(console.error)
  }

  async [Symbol.asyncDispose]() {
    await this.duplex.close()
  }

  get inner() {
    return this.http.inner
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

  static get CLOSED() {
    return WebSocket.CLOSED
  }

  static get CLOSING() {
    return WebSocket.CLOSING
  }

  static get CONNECTING() {
    return WebSocket.CONNECTING
  }

  static get OPEN() {
    return WebSocket.OPEN
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

  async send(data: string | ArrayBufferLike | ArrayBufferView | Blob) {
    if (typeof data === "string")
      return this.#splitOrThrow(WebSocketFrame.opcodes.text, Bytes.fromUtf8(data))
    else if (data instanceof Blob)
      return this.#splitOrThrow(WebSocketFrame.opcodes.text, new Uint8Array(await data.arrayBuffer()))
    else if ("buffer" in data)
      return this.#splitOrThrow(WebSocketFrame.opcodes.binary, Bytes.fromView(data))
    else
      return this.#splitOrThrow(WebSocketFrame.opcodes.text, new Uint8Array(data))
  }

  close(code = 1000, reason?: string) {
    const final = true
    const opcode = WebSocketFrame.opcodes.close
    const close = WebSocketClose.from(code, reason)
    const payload = Writable.writeToBytesOrThrow(close)

    const mask = Bytes.random(4)

    const frame = WebSocketFrame.from({ final, opcode, payload, mask })

    this.#writeOrThrow(frame)
    this.#readyState = this.CLOSING
  }

  async #onDuplexClose() {
    const closeEvent = new CloseEvent("close", { wasClean: false })
    this.dispatchEvent(closeEvent)

    this.#readyState = this.CLOSED
  }

  async #onDuplexError(reason?: unknown) {
    const errorEvent = new ErrorEvent("error", { error: reason })
    this.dispatchEvent(errorEvent)

    const closeEvent = new CloseEvent("close", { wasClean: false })
    this.dispatchEvent(closeEvent)

    this.#readyState = this.CLOSED
  }

  async #onHead(init: ResponseInit) {
    const headers = new Headers(init.headers)

    if (init.status !== 101)
      throw new InvalidHttpStatusCode(init.status)

    if (!Strings.equalsIgnoreCase(headers.get("Connection"), "Upgrade"))
      throw new InvalidHttpHeaderValue("Connection")
    if (!Strings.equalsIgnoreCase(headers.get("Upgrade"), "websocket"))
      throw new InvalidHttpHeaderValue("Upgrade")

    const prehash = Bytes.concat([Bytes.fromUtf8(this.#keyBase64), ACCEPT_SUFFIX])
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-1", prehash))

    const hashBase64 = Base64.get().encodePaddedOrThrow(hash)

    if (headers.get("Sec-WebSocket-Accept") !== hashBase64)
      throw new InvalidHttpHeaderValue("Sec-WebSocket-Accept")

    this.#readyState = this.OPEN

    const openEvent = new Event("open")
    this.dispatchEvent(openEvent)

    this.#startPingLoop().catch(console.warn)

    return new None()
  }

  async #startPingLoop() {
    while (this.readyState === this.OPEN) {
      await new Promise(ok => setTimeout(ok, 10_000))

      try {
        await this.#pingOrThrow()
      } catch (e) {
        if (this.readyState === this.OPEN)
          this.close()
        return
      }
    }
  }

  async #pingOrThrow() {
    const final = true
    const opcode = WebSocketFrame.opcodes.ping
    const payload = Bytes.empty()
    const mask = Bytes.random(4)

    const ping = WebSocketFrame.from({ final, opcode, payload, mask })

    this.#writeOrThrow(ping)

    await Plume.waitOrCloseOrErrorOrSignal(this.events, "pong", (future: Future<void>) => {
      future.resolve()
      return new None()
    }, AbortSignal.timeout(10_000))
  }

  async #onInputStart() {
    await Naberius.initBundledOnce()
  }

  async #onInputMessage(chunk: Uint8Array) {
    // Console.debug(this.#class.name, "<-", chunk.length)

    using bytesMemory = new Naberius.Memory(chunk)
    using bitsMemory = unpack(bytesMemory)

    if (this.#buffer.inner.offset)
      return await this.#onReadBuffered(bitsMemory.bytes)

    return await this.#onReadDirect(bitsMemory.bytes)
  }

  async #onReadBuffered(chunk: Uint8Array) {
    this.#buffer.writeOrThrow(chunk)
    const full = new Uint8Array(this.#buffer.inner.before)

    this.#buffer.inner.offset = 0
    return await this.#onReadDirect(full)
  }

  async #onReadDirect(chunk: Uint8Array) {
    const cursor = new Cursor(chunk)

    while (cursor.remaining) {
      let frame: WebSocketFrame

      try {
        frame = Readable.readOrRollbackAndThrow(WebSocketFrame, cursor)
      } catch (e: unknown) {
        this.#buffer.writeOrThrow(cursor.after)
        break
      }

      await this.#onFrame(frame)
    }
  }

  async #onFrame(frame: WebSocketFrame) {
    // Console.debug("<-", frame)

    if (frame.final)
      return await this.#onFinalFrame(frame)
    else
      return await this.#onStartFrame(frame)
  }

  async #onFinalFrame(frame: WebSocketFrame) {
    if (frame.opcode === WebSocketFrame.opcodes.continuation)
      return await this.#onContinuationFrame(frame)
    if (frame.opcode === WebSocketFrame.opcodes.ping)
      return await this.#onPingFrame(frame)
    if (frame.opcode === WebSocketFrame.opcodes.pong)
      return await this.#onPongFrame(frame)
    if (frame.opcode === WebSocketFrame.opcodes.binary)
      return await this.#onBinaryFrame(frame)
    if (frame.opcode === WebSocketFrame.opcodes.text)
      return await this.#onTextFrame(frame)
    if (frame.opcode === WebSocketFrame.opcodes.close)
      return await this.#onCloseFrame(frame)

    console.warn(`Unknown opcode`)
  }

  async #onPingFrame(frame: WebSocketFrame) {
    const final = true
    const opcode = WebSocketFrame.opcodes.pong
    const payload = frame.payload
    const mask = Bytes.random(4)

    const pong = WebSocketFrame.from({ final, opcode, payload, mask })

    this.#writeOrThrow(pong)
  }

  async #onPongFrame(frame: WebSocketFrame) {
    await this.events.emit("pong")
  }

  async #onBinaryFrame(frame: WebSocketFrame) {
    if (this.binaryType === "blob")
      this.dispatchEvent(new MessageEvent("message", { data: new Blob([frame.payload]) }))
    else
      this.dispatchEvent(new MessageEvent("message", { data: frame.payload.buffer }))
  }

  async #onTextFrame(frame: WebSocketFrame) {
    this.dispatchEvent(new MessageEvent("message", { data: Bytes.toUtf8(frame.payload) }))
  }

  async #onCloseFrame(frame: WebSocketFrame) {
    if (this.readyState === this.OPEN) {
      const final = true
      const opcode = WebSocketFrame.opcodes.close
      const payload = frame.payload
      const mask = Bytes.random(4)

      const echo = WebSocketFrame.from({ final, opcode, payload, mask })

      this.#writeOrThrow(echo)
      return
    }

    if (frame.payload.length) {
      const close = Readable.readFromBytesOrThrow(WebSocketClose, frame.payload)
      const reason = close.reason == null ? undefined : Bytes.toUtf8(close.reason)

      Console.debug("Close frame received", close.code, reason)

      await this.duplex.close()
      return
    }

    await this.duplex.close()
  }

  async #onStartFrame(frame: WebSocketFrame) {
    if (frame.opcode !== WebSocketFrame.opcodes.continuation) {

      if (this.#current.opcode !== undefined)
        throw new ExpectedContinuationFrameError()

      this.#current.opcode = frame.opcode
    }

    return this.#current.buffer.writeOrThrow(frame.payload)
  }

  async #onContinuationFrame(frame: WebSocketFrame) {
    this.#current.buffer.writeOrThrow(frame.payload)

    if (this.#current.opcode === undefined)
      throw new UnexpectedContinuationFrameError()

    const final = true
    const opcode = this.#current.opcode
    const payload = new Uint8Array(this.#current.buffer.before)
    const full = WebSocketFrame.from({ final, opcode, payload })

    this.#current.opcode = undefined
    this.#current.buffer.offset = 0

    await this.#onFinalFrame(full)
  }

  #writeOrThrow(frame: WebSocketFrame) {
    const bits = Writable.writeToBytesOrThrow(frame)

    using bitsMemory = new Naberius.Memory(bits)
    const bytesBytes = pack_right(bitsMemory).copyAndDispose()

    this.duplex.output.enqueue(bytesBytes)
  }

  #splitOrThrow(opcode: number, data: Uint8Array) {
    const chunks = new Cursor(data).splitOrThrow(32_768)
    const peeker = Iterators.peek(chunks)

    const first = peeker.next()

    if (first.done)
      return

    const { current, next } = first.value
    const final = Boolean(next.done)
    const mask = Bytes.random(4)

    const frame = WebSocketFrame.from({ final, opcode, payload: current, mask })

    // Console.debug(this.#class.name, "->", current.length)
    this.#writeOrThrow(frame)

    let result = peeker.next()

    for (; !result.done; result = peeker.next()) {
      const { current, next } = result.value

      const final = Boolean(next.done)
      const opcode = WebSocketFrame.opcodes.continuation
      const mask = Bytes.random(4)

      const frame = WebSocketFrame.from({ final, opcode, payload: current, mask })

      // Console.debug(this.#class.name, "-> (continuation)", current.length)
      this.#writeOrThrow(frame)
    }
  }

}