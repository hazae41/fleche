import { Base64 } from "@hazae41/base64";
import { Opaque, Readable, Writable } from "@hazae41/binary";
import { Bytes } from "@hazae41/bytes";
import { SuperReadableStream, SuperWritableStream } from "@hazae41/cascade";
import { Cursor } from "@hazae41/cursor";
import { Future } from "@hazae41/future";
import { Naberius, pack_right, unpack } from "@hazae41/naberius";
import { None } from "@hazae41/option";
import { CloseEvents, ErrorEvents, Plume, SuperEventTarget } from "@hazae41/plume";
import { Iterators } from "libs/iterables/iterators.js";
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

export class WebSocketClientDuplex extends EventTarget implements WebSocket {
  readonly #class = WebSocketClientDuplex

  readonly events = {
    reading: new SuperEventTarget<CloseEvents & ErrorEvents & { pong: () => void }>(),
    writing: new SuperEventTarget<CloseEvents & ErrorEvents>()
  } as const

  readonly inner: ReadableWritablePair<Writable, Opaque>

  readonly #input: SuperWritableStream<Uint8Array>
  readonly #output: SuperReadableStream<Uint8Array>

  readonly #buffer = new Cursor(Bytes.alloc(65535))

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

    const http = new HttpClientDuplex({ target, method: "GET", headers })

    /**
     * Input pipeline (inner -> outer) (server -> client)
     */
    this.#input = new SuperWritableStream({
      start: this.#onInputStart.bind(this),
      write: this.#onInputWrite.bind(this)
    })

    /**
     * Output pipeline (outer -> inner) (client -> server)
     */
    this.#output = new SuperReadableStream<Uint8Array>({})

    const inputer = this.#input.start()
    const outputer = this.#output.start()

    /**
     * Inner protocol (TLS? TCP?)
     */
    this.inner = http.inner

    http.outer.readable
      .pipeTo(inputer)
      .then(() => this.#onInputClose())
      .catch(e => this.#onInputError(e))
      .catch(() => { })

    outputer
      .pipeTo(http.outer.writable)
      .then(() => this.#onOutputClose())
      .catch(e => this.#onOutputError(e))
      .catch(() => { })

    http.events.input.on("head", this.#onHead.bind(this), { passive: true })

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

  #onClose(reason?: unknown) {
    if (!this.#input.closed) {
      this.#input.error(reason)
      this.#input.closed = { reason }
    }

    if (!this.#output.closed) {
      this.#output.close()
      this.#output.closed = { reason }
    }

    const closeEvent = new CloseEvent("close", { wasClean: false })
    this.dispatchEvent(closeEvent)

    this.#readyState = this.CLOSED

    // this.#onClean()
  }

  #onError(reason?: unknown) {
    if (!this.#input.closed) {
      this.#input.error(reason)
      this.#input.closed = { reason }
    }

    if (!this.#output.closed) {
      this.#output.error(reason)
      this.#output.closed = { reason }
    }

    const errorEvent = new ErrorEvent("error", { error: reason })
    this.dispatchEvent(errorEvent)

    const closeEvent = new CloseEvent("close", { wasClean: false })
    this.dispatchEvent(closeEvent)

    this.#readyState = this.CLOSED

    // this.#onClean()
  }

  async #onInputClose() {
    Console.debug(`${this.#class.name}.onReadClose`)

    this.#input.closed = {}
    this.#output.close()

    await this.events.reading.emit("close", [undefined])

    this.#onClose()
  }

  async #onOutputClose() {
    Console.debug(`${this.#class.name}.onWriteClose`)

    this.#output.closed = {}
    this.#input.error()

    await this.events.writing.emit("close", [undefined])

    this.#onClose()
  }

  async #onInputError(reason?: unknown) {
    Console.debug(`${this.#class.name}.onReadError`, { reason })

    this.#input.closed = { reason }
    this.#output.error(reason)

    await this.events.reading.emit("error", [reason])

    this.#onError(reason)
  }

  async #onOutputError(reason?: unknown) {
    Console.debug(`${this.#class.name}.onWriteError`, { reason })

    this.#output.closed = { reason }
    this.#input.error(reason)

    await this.events.writing.emit("error", [reason])

    this.#onError(reason)
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

    await Plume.waitOrCloseOrErrorOrSignal(this.events.reading, "pong", (future: Future<void>) => {
      future.resolve()
      return new None()
    }, AbortSignal.timeout(10_000))
  }

  async #onInputStart() {
    await Naberius.initBundledOnce()
  }

  async #onInputWrite(chunk: Uint8Array) {
    // Console.debug(this.#class.name, "<-", chunk.length)

    using bytesMemory = new Naberius.Memory(chunk)
    using bitsMemory = unpack(bytesMemory)

    if (this.#buffer.offset)
      return await this.#onReadBuffered(bitsMemory.bytes)

    return await this.#onReadDirect(bitsMemory.bytes)
  }

  async #onReadBuffered(chunk: Uint8Array) {
    this.#buffer.writeOrThrow(chunk)
    const full = new Uint8Array(this.#buffer.before)

    this.#buffer.offset = 0
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
    await this.events.reading.emit("pong", [])
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

      this.#onClose(reason)
      return
    }

    this.#onClose()
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

    this.#output.enqueue(bytesBytes)
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