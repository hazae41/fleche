import { Future } from "libs/futures/future.js"
import { TransformController } from "libs/streams/streams.js"

export interface IHttpStream extends EventTarget {
  readable: ReadableStream<Uint8Array>
  writable: WritableStream<Uint8Array>
}

class Bufferizer implements Transformer<Uint8Array, Buffer> {
  transform(array: Uint8Array, controller: TransformController<Buffer>) {
    controller.enqueue(Buffer.from(array.buffer))
  }
}

/**
 * Fetch adapter for HTTP streams
 * Will wait for response to be available
 * @param stream new HttpStream(sub)
 * @param input "https://google.com"
 * @param init 
 * @returns 
 */
export async function fetch(stream: IHttpStream, input: RequestInfo, init?: RequestInit) {
  const request = new Request(input, init)
  const response = new Future<Response>()

  const { signal } = request

  function onBody(e: Event) {
    response.ok(new Response(stream.readable))
  }

  try {
    stream.addEventListener("body", onBody, { passive: true })
    signal.addEventListener("abort", response.err, { passive: true })

    response.promise.catch(() => { })

    if (request.body)
      await request.body.pipeTo(stream.writable, { signal })
    else
      await stream.writable.close()

    return await response.promise
  } finally {
    stream.removeEventListener("body", onBody)
    signal.removeEventListener("abort", response.err)
  }
}