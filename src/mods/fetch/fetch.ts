import { Future } from "libs/futures/future.js"
import { HttpStream } from "mods/http/http.js"

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
    const msg = e as MessageEvent<ResponseInit>
    response.ok(new Response(http.readable, msg.data))
  }

  try {
    signal.addEventListener("abort", response.err, { passive: true })
    http.read.addEventListener("close", response.err, { passive: true })
    http.read.addEventListener("error", response.err, { passive: true })
    http.addEventListener("body", onBody, { passive: true })

    if (request.body)
      request.body.pipeTo(http.writable, { signal }).catch(response.err)
    else
      http.writable.close().catch(response.err)

    return await response.promise
  } finally {
    signal.removeEventListener("abort", response.err)
    http.read.removeEventListener("close", response.err)
    http.read.removeEventListener("error", response.err)
    http.removeEventListener("body", onBody)
  }
}