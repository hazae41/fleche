import { Promises } from "libs/promises/promises.js"
import { Signals } from "libs/signals/signals.js"

export type Stream<T> = ReadableWritablePair<T>

export type Reader<T> = ReadableStreamDefaultReader<T>
export type Writer<T> = WritableStreamDefaultWriter<T>

export type TransformController<T> = TransformStreamDefaultController<Buffer>

export namespace Streams {

  export async function* read<T>(reader: Reader<T>, signal: AbortSignal) {
    const psignal = Signals.wait(signal)

    while (true) {
      const result = await Promises.escape(reader.read(), psignal)

      if (result.done)
        break
      yield result.value
    }
  }

}

export interface ByteStreamParams {
  start?: (controller: ReadableByteStreamController) => Promise<void>
  write?: (chunk: Uint8Array, controller: ReadableByteStreamController) => void | Promise<void>
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
      cancel(reason) {
        writer.error(reason)
      }
    })

    this.writable = new WritableStream<Uint8Array>({
      start(controller) {
        writer = controller
      },
      async write(chunk, controller) {
        await params.write?.(chunk, reader)
      },
      abort(reason) {
        reader.error(reason)
      },
      close() {
        reader.close()
      }
    })
  }
}