import { Future } from "libs/futures/future.js"

export class WebSocketStream {
  readonly readable: ReadableStream<Uint8Array>
  readonly writable: WritableStream<Uint8Array>

  constructor(
    readonly websocket: WebSocket
  ) {
    websocket.binaryType = "arraybuffer"

    this.readable = new ReadableStream({
      type: "bytes",
      start: this.onReadStart.bind(this),
      cancel: this.onReadCancel.bind(this)
    })

    this.writable = new WritableStream({
      start: this.onWriteStart.bind(this),
      write: this.onWrite.bind(this),
      abort: this.onWriteAbort.bind(this),
    })
  }

  private async onReadStart(controller: ReadableByteStreamController) {
    const onMessage = (e: MessageEvent) => {
      const chunk = new Uint8Array(e.data as ArrayBuffer)
      try { controller.enqueue(chunk) } catch (e: unknown) { }
    }

    const onError = (e: Event) => {
      this.websocket.removeEventListener("message", onMessage)
      this.websocket.removeEventListener("close", onClose)
      try { controller.error(e) } catch (e: unknown) { }
    }

    const onClose = (e: CloseEvent) => {
      this.websocket.removeEventListener("message", onMessage)
      this.websocket.removeEventListener("error", onError)
      try { controller.close() } catch (e: unknown) { }
    }

    this.websocket.addEventListener("message", onMessage, { passive: true })
    this.websocket.addEventListener("error", onError, { passive: true })
    this.websocket.addEventListener("close", onClose, { passive: true })
  }

  private async onReadCancel() {
    await this.close()
  }

  private async onWriteStart(controller: WritableStreamDefaultController) {
    const onError = (e: Event) => {
      this.websocket.removeEventListener("close", onClose)
      try { controller.error(e) } catch (e: unknown) { }
    }

    const onClose = (e: CloseEvent) => {
      this.websocket.removeEventListener("error", onError)
      try { controller.error() } catch (e: unknown) { }
    }

    this.websocket.addEventListener("error", onError, { passive: true })
    this.websocket.addEventListener("close", onClose, { passive: true })
  }

  private async onWrite(chunk: Uint8Array) {
    this.websocket.send(chunk)
  }

  private async onWriteAbort() {
    await this.close()
  }

  private async close() {
    const close = new Future<void>()

    function onClose(e: CloseEvent) {
      if (e.wasClean)
        close.ok()
      else
        close.err(e)
    }

    try {
      this.websocket.addEventListener("close", onClose, { passive: true })

      await close.promise
    } finally {
      this.websocket.removeEventListener("close", onClose)
    }
  }
}