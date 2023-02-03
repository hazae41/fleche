import { Binary } from "@hazae41/binary";
import { Naberius, pack_right, unpack } from "@hazae41/naberius";
import { Bytes } from "libs/bytes/bytes.js";
import { CloseEvent } from "libs/events/close.js";
import { ErrorEvent } from "libs/events/error.js";
import { AsyncEventTarget } from "libs/events/target.js";
import { Strings } from "libs/strings/strings.js";
import { HttpClientStream } from "mods/http/client.js";
import { Frame } from "./frame.js";

const ACCEPT_SUFFIX = Bytes.fromUtf8("258EAFA5-E914-47DA-95CA-C5AB0DC85B11")

export interface WebSocketParams {
  readonly stream: ReadableWritablePair<Uint8Array>
  readonly signal?: AbortSignal
}

export class WebSocket extends EventTarget {
  readonly #class = WebSocket

  public readonly reading = new AsyncEventTarget()
  public readonly writing = new AsyncEventTarget()

  public readonly readable: ReadableStream<Uint8Array>
  public readonly writable: WritableStream<Uint8Array>

  private readonly reader: TransformStream<Uint8Array>
  private readonly writer: TransformStream<Uint8Array>
  private readonly piper: TransformStream<Uint8Array>

  private input?: TransformStreamDefaultController<Uint8Array>
  private output?: TransformStreamDefaultController<Uint8Array>

  private readonly key = Bytes.toBase64(Bytes.random(16))

  constructor(
    readonly url: string | URL,
    readonly protocols: string | string[] | undefined,
    readonly params: WebSocketParams
  ) {
    super()

    const { host, pathname } = new URL(url)
    const { stream, signal } = params

    const headers = new Headers()

    if (!headers.has("Host"))
      headers.set("Host", host)
    headers.set("Connection", "Upgrade")
    headers.set("Upgrade", "websocket")
    headers.set("Sec-WebSocket-Key", this.key)
    headers.set("Sec-WebSocket-Version", "13")

    const http = new HttpClientStream(stream, { pathname, method: "GET", headers })

    this.reader = new TransformStream({
      start: this.onReadStart.bind(this),
      transform: this.onRead.bind(this)
    })

    this.writer = new TransformStream<Uint8Array>({
      start: this.onWriteStart.bind(this),
      transform: this.onWrite.bind(this),
    })

    this.piper = new TransformStream<Uint8Array>()

    this.readable = this.piper.readable
    this.writable = this.writer.writable

    http.readable
      .pipeTo(this.reader.writable, { signal })
      .then(this.onReadClose.bind(this))
      .catch(this.onReadError.bind(this))

    this.writer.readable
      .pipeTo(http.writable, { signal })
      .then(this.onWriteClose.bind(this))
      .catch(this.onWriteError.bind(this))

    this.reader.readable
      .pipeTo(this.piper.writable)
      .then(() => { })
      .catch(() => { })

    http.reading.addEventListener("head", this.onHead.bind(this), { passive: true })
    http.flush()
  }

  public write(chunk: Uint8Array) {
    console.debug(this.#class.name, "->", chunk)

    const frame = new Frame(true, Frame.opcodes.binary, chunk, Bytes.random(4))
    const bytes = pack_right(frame.export())
    console.debug(this.#class.name, "->2", bytes)
    this.output!.enqueue(bytes)
  }

  private async onHead(event: Event) {
    const msgEvent = event as MessageEvent<ResponseInit>
    const { headers, status } = msgEvent.data

    if (status !== 101)
      throw new Error(`Invalid HTTP status code ${status}`)

    const headers2 = new Headers(headers)

    if (!Strings.equalsIgnoreCase(headers2.get("Connection"), "Upgrade"))
      throw new Error(`Invalid Connection header value`)
    if (!Strings.equalsIgnoreCase(headers2.get("Upgrade"), "websocket"))
      throw new Error(`Invalid Upgrade header value`)

    const prehash = Bytes.concat([Bytes.fromUtf8(this.key), ACCEPT_SUFFIX])
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-1", prehash))

    if (headers2.get("Sec-WebSocket-Accept") !== Bytes.toBase64(hash))
      throw new Error(`Invalid Sec-WebSocket-Accept header value`)

    const openEvent = new Event("open")
    this.dispatchEvent(openEvent)
  }

  private async onReadClose() {
    // console.debug(`${this.#class.name}.onReadClose`)

    const closeEvent = new CloseEvent("close", {})
    if (!await this.reading.dispatchEvent(closeEvent)) return
  }

  private async onWriteClose() {
    // console.debug(`${this.#class.name}.onWriteClose`)

    const closeEvent = new CloseEvent("close", {})
    if (!await this.writing.dispatchEvent(closeEvent)) return
  }

  private async onReadError(error?: unknown) {
    // console.debug(`${this.#class.name}.onReadError`, error)

    try { this.output!.error(error) } catch (e: unknown) { }

    const errorEvent = new ErrorEvent("error", { error })
    if (!await this.reading.dispatchEvent(errorEvent)) return

    await this.onError(error)
  }

  private async onWriteError(error?: unknown) {
    // console.debug(`${this.#class.name}.onWriteError`, error)

    try { this.input!.error(error) } catch (e: unknown) { }

    const errorEvent = new ErrorEvent("error", { error })
    if (!await this.writing.dispatchEvent(errorEvent)) return
  }

  private async onError(error?: unknown) {
    const errorEvent = new ErrorEvent("error", { error })
    this.dispatchEvent(errorEvent)

    const closeEvent = new CloseEvent("close", { wasClean: false })
    this.dispatchEvent(closeEvent)
  }

  private async onReadStart(controller: TransformStreamDefaultController<Uint8Array>) {
    await Naberius.initBundledOnce()

    this.input = controller
  }

  private async onRead(chunk: Uint8Array) {
    console.debug(this.#class.name, "<-", chunk)
    const bits = new Binary(unpack(chunk))
    const frame = Frame.read(bits)
    console.log(frame)
  }

  private async onWriteStart(controller: TransformStreamDefaultController<Uint8Array>) {
    this.output = controller
  }

  private async onWrite(chunk: Uint8Array) {
    this.write(chunk)
  }
}