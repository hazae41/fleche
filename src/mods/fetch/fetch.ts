import { Future } from "libs/futures/future.js"
import { HttpStream } from "mods/http/http.js"

export interface IHttpStream extends EventTarget {
  readable: ReadableStream<Uint8Array>
  writable: WritableStream<Uint8Array>
}

export interface FetchParams {
  stream: ReadableWritablePair<Uint8Array>
}

/**
 * Fetch adapter for HTTP streams
 * Will wait for response to be available
 * @param input "https://google.com"
 * @param init.stream Transport substream
 * @returns 
 */
export async function fetch(input: RequestInfo, init: RequestInit & FetchParams) {
  const { stream, ...init2 } = init

  const request = new Request(input, init2)
  const response = new Future<Response>()

  const { url, method, signal } = request
  const { host, pathname } = new URL(url)

  const http = new HttpStream(stream, { host, pathname, method, signal })

  function onBody(e: Event) {
    response.ok(new Response(http.readable))
  }

  try {
    http.addEventListener("body", onBody, { passive: true })
    signal.addEventListener("abort", response.err, { passive: true })

    response.promise.catch(() => { })

    if (request.body)
      await request.body.pipeTo(http.writable, { signal })
    else
      await http.writable.close()

    return await response.promise
  } finally {
    http.removeEventListener("body", onBody)
    signal.removeEventListener("abort", response.err)
  }
}