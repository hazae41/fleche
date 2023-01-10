import { Bytes } from "libs/bytes/bytes.js"
import { ByteStreamPipe } from "libs/streams/bytes.js"
import { CloseEvent, ErrorEvent, MessageEvent, WebSocket } from "ws"

export class WebSocketStream {

  readonly readable: ReadableStream<Uint8Array>
  readonly writable: WritableStream<Uint8Array>

  constructor(
    readonly websocket: WebSocket
  ) {
    websocket.binaryType = "arraybuffer"

    const stream = new ByteStreamPipe({
      start: this.onStart.bind(this),
      write: this.onWrite.bind(this)
    })

    this.readable = stream.readable
    this.writable = stream.writable
  }

  private async onStart(controller: ReadableByteStreamController) {
    const onMessage = (e: MessageEvent) => {
      controller.enqueue(Bytes.fromBuffer(e.data as ArrayBuffer))
    }

    const onError = (e: ErrorEvent) => {
      this.websocket.removeEventListener("message", onMessage)
      this.websocket.removeEventListener("close", onClose)
      controller.error(e)
    }

    const onClose = (e: CloseEvent) => {
      this.websocket.removeEventListener("message", onMessage)
      this.websocket.removeEventListener("error", onError)
      controller.close()
    }

    this.websocket.addEventListener("message", onMessage)
    this.websocket.addEventListener("error", onError)
    this.websocket.addEventListener("close", onClose)
  }

  private async onWrite(chunk: Uint8Array) {
    this.websocket.send(chunk)
  }
}