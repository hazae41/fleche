import { Opaque, Writable } from "@hazae41/binary"
import { ResultableUnderlyingDefaultSource, ResultableUnderlyingSink, SuperReadableStream, SuperWritableStream } from "@hazae41/cascade"
import { Ok, Result } from "@hazae41/result"

export async function createWebSocketStream(url: string) {
  const websocket = new WebSocket(url)

  websocket.binaryType = "arraybuffer"

  await new Promise((ok, err) => {
    websocket.addEventListener("open", ok)
    websocket.addEventListener("error", err)
  })

  return new WebSocketStream(websocket)
}

async function tryClose(websocket: WebSocket) {
  await new Promise<void>((ok, err) => {
    const onClose = (e: CloseEvent) => {
      if (e.wasClean)
        ok()
      else
        err(e)
    }

    websocket.addEventListener("close", onClose, { passive: true, once: true })
  })
}

export type WebSocketStreamParams =
  & WebSocketSourceParams
  & WebSocketSinkParams

export class WebSocketStream {
  readonly reader: SuperReadableStream<Opaque>
  readonly writer: SuperWritableStream<Writable>

  readonly readable: ReadableStream<Opaque>
  readonly writable: WritableStream<Writable>

  /**
   * A WebSocket stream
   * @description https://streams.spec.whatwg.org/#example-both
   */
  constructor(
    readonly websocket: WebSocket,
    readonly params: WebSocketStreamParams = {}
  ) {
    if (websocket.readyState !== WebSocket.OPEN)
      throw new Error(`WebSocket is not open`)
    if (websocket.binaryType !== "arraybuffer")
      throw new Error(`WebSocket binaryType is not arraybuffer`)

    this.reader = new SuperReadableStream(new WebSocketSource(websocket, params))
    this.writer = new SuperWritableStream(new WebSocketSink(websocket, params))

    this.readable = this.reader.start()
    this.writable = this.writer.start()
  }
}

export interface WebSocketSourceParams {
  /**
   * Whether the socket should be closed when the stream is cancelled
   * @description You don't want to reuse the socket
   */
  shouldCloseOnCancel?: boolean
}

export class WebSocketSource implements ResultableUnderlyingDefaultSource<Opaque> {

  constructor(
    readonly websocket: WebSocket,
    readonly params: WebSocketSourceParams = {}
  ) { }

  #closed?: { reason?: unknown }

  #onMessage?: (e: MessageEvent<ArrayBuffer>) => void
  #onClose?: (e: CloseEvent) => void
  #onError?: (e: Event) => void

  #close(reason?: unknown) {
    this.#closed = { reason }

    this.websocket.removeEventListener("message", this.#onMessage!)
    this.websocket.removeEventListener("close", this.#onClose!)
    this.websocket.removeEventListener("error", this.#onError!)
  }

  async start(controller: ReadableStreamDefaultController<Opaque>) {

    this.#onMessage = (msgEvent: MessageEvent<ArrayBuffer>) => {
      if (this.#closed) return

      const bytes = new Uint8Array(msgEvent.data)
      console.debug("ws <-", bytes)
      controller.enqueue(new Opaque(bytes))
    }

    this.#onError = (event: Event) => {
      const error = new Error(`Errored`, { cause: event })
      controller.error(error)
      this.#close(error)
    }

    this.#onClose = (event: CloseEvent) => {
      controller.close()
      this.#close()
    }

    this.websocket.addEventListener("message", this.#onMessage, { passive: true })
    this.websocket.addEventListener("error", this.#onError, { passive: true })
    this.websocket.addEventListener("close", this.#onClose, { passive: true })

    return Ok.void()
  }

  async cancel() {
    if (this.params.shouldCloseOnCancel)
      this.websocket.close()

    this.#close()

    return Ok.void()
  }

}

export interface WebSocketSinkParams {
  /**
   * Whether the socket should be closed when the stream is closed
   * @description You don't want to reuse the socket
   * @description You're not using request-response
   */
  shouldCloseOnClose?: boolean

  /**
   * Whether the socket should be closed when the stream is aborted
   * @description You don't want to reuse the socket
   */
  shouldCloseOnAbort?: boolean
}

export class WebSocketSink implements ResultableUnderlyingSink<Writable> {

  constructor(
    readonly websocket: WebSocket,
    readonly params: WebSocketSinkParams = {}
  ) { }

  #closed?: { reason?: unknown }

  #onClose?: (e: CloseEvent) => void
  #onError?: (e: Event) => void

  #close(reason?: unknown) {
    this.#closed = { reason }

    this.websocket.removeEventListener("close", this.#onClose!)
    this.websocket.removeEventListener("error", this.#onError!)
  }

  async start(controller: WritableStreamDefaultController) {

    this.#onClose = (closeEvent: CloseEvent) => {
      const error = new Error(`Closed`, { cause: closeEvent })
      controller.error(error)
      this.#close(error)
    }

    this.#onError = (event: Event) => {
      const error = new Error(`Errored`, { cause: event })
      controller.error(error)
      this.#close(error)
    }

    this.websocket.addEventListener("error", this.#onError, { passive: true })
    this.websocket.addEventListener("close", this.#onClose, { passive: true })

    return Ok.void()
  }

  async write(chunk: Writable): Promise<Result<void, unknown>> {
    const bytes = Writable.tryWriteToBytes(chunk)

    if (bytes.isErr())
      return bytes

    console.debug("ws ->", bytes.inner)
    this.websocket.send(bytes.inner)

    return Ok.void()
  }

  async abort(reason?: unknown) {
    if (this.params.shouldCloseOnAbort)
      await tryClose(this.websocket)

    this.#close(reason)

    return Ok.void()
  }

  async close() {
    if (this.params.shouldCloseOnClose)
      await tryClose(this.websocket)

    this.#close()

    return Ok.void()
  }
}