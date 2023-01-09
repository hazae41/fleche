
export interface ByteStreamParams {
  start?: (controller: ReadableByteStreamController) => Promise<void>
  write?: (chunk: Uint8Array, controller: ReadableByteStreamController) => void | Promise<void>
  close?: (controller: ReadableByteStreamController) => void | Promise<void>
}

export class ByteStream {
  readonly readable: ReadableStream<Uint8Array>
  readonly writable: WritableStream<Uint8Array>

  constructor(params: ByteStreamParams) {
    let reader: ReadableByteStreamController
    let writer: WritableStreamDefaultController

    this.readable = new ReadableStream({
      type: "bytes",
      async start(controller) {
        reader = controller

        await params.start?.(controller)
      },
      async cancel(reason) {
        writer.error(reason)
      }
    })

    this.writable = new WritableStream<Uint8Array>({
      async start(controller) {
        writer = controller
      },
      async write(chunk, controller) {
        await params.write?.(chunk, reader)
      },
      async abort(reason) {
        reader.error(reason)
      },
      async close() {
        await params.close?.(reader)
      }
    })
  }
}