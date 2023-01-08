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