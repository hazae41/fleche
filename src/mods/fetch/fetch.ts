import { Future } from "libs/futures/future.js"
import { TransformController } from "libs/streams/streams.js"

export interface IHttpStream extends EventTarget {
  aborter: AbortController

  readable: ReadableStream<Buffer>
  writable: WritableStream<Buffer>
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

  function onAbort(e: Event) {
    stream.aborter.abort(e)
  }

  function onBody(e: Event) {
    console.log("onbody")
    response.ok(new Response(stream.readable))
  }

  function onAborted(e: Event) {
    response.err(e)
  }

  try {
    request.signal.addEventListener("abort", onAbort, { passive: true })

    stream.addEventListener("body", onBody, { passive: true })
    stream.aborter.signal.addEventListener("abort", onAborted, { passive: true })

    const bufferizer = new TransformStream(new Bufferizer())

    if (request.body)
      await request.body.pipeThrough(bufferizer).pipeTo(stream.writable)
    else
      await stream.writable.close()

    return await response.promise
  } catch (e: unknown) {
    console.log("error")
  } finally {
    request.signal.removeEventListener("abort", onAbort)

    stream.removeEventListener("body", onBody)
    stream.aborter.signal.removeEventListener("abort", onAborted)
  }
}