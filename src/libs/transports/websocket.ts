import { ByteStream } from "libs/streams/streams.js"

export class WebSocketStream {

  readonly readable: ReadableStream<Uint8Array>
  readonly writable: WritableStream<Uint8Array>

  constructor(
    readonly websocket: WebSocket
  ) {
    websocket.binaryType = "arraybuffer"

    const stream = new ByteStream({
      start: this.onStart.bind(this),
      write: this.onWrite.bind(this)
    })

    this.readable = stream.readable
    this.writable = stream.writable
  }

  private async onStart(controller: ReadableByteStreamController) {
    this.websocket.addEventListener("message", e => controller.enqueue(e.data))
    this.websocket.addEventListener("close", e => controller.close())
    this.websocket.addEventListener("error", e => controller.error(e))
  }

  private async onWrite(chunk: Uint8Array, controller: ReadableByteStreamController) {
    this.websocket.send(chunk)
  }
}