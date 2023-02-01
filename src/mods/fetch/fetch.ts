import { AbortEvent } from "libs/events/abort.js"
import { Future } from "libs/futures/future.js"
import { HttpClientStream } from "mods/http/client.js"

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
  const future = new Future<Response, Error>()

  const { url, method, signal } = request
  const { host, pathname } = new URL(url)
  const headers = new Headers(init.headers)

  if (!headers.has("Host"))
    headers.set("Host", host)

  const http = new HttpClientStream(stream, { pathname, method, headers, signal })

  const onHead = (event: Event) => {
    const msgEvent = event as MessageEvent<ResponseInit>
    const response = new Response(http.readable, msgEvent.data)
    future.ok(response)
  }

  const onAbort = (event: Event) => {
    const abortEvent = event as AbortEvent
    const error = new Error(`Aborted`, { cause: abortEvent.target.reason })
    future.err(error)
  }

  const onClose = (event: Event) => {
    const closeEvent = event as CloseEvent
    const error = new Error(`Closed`, { cause: closeEvent })
    future.err(error)
  }

  const onError = (event: Event) => {
    const errorEvent = event as ErrorEvent
    const error = new Error(`Errored`, { cause: errorEvent })
    future.err(error)
  }

  try {
    signal.addEventListener("abort", onAbort, { passive: true })
    http.read.addEventListener("close", onClose, { passive: true })
    http.read.addEventListener("error", onError, { passive: true })
    http.read.addEventListener("head", onHead, { passive: true })

    let body = request.body

    /**
     * Firefox fix
     */
    if (body === undefined && init.body !== undefined) {
      if (init.body instanceof ReadableStream) {
        body = init.body
      } else {
        const blob = await request.blob()
        body = blob.stream()
      }
    }

    if (body)
      body.pipeTo(http.writable, { signal }).catch(future.err)
    else
      http.writable.close().catch(future.err)

    return await future.promise
  } finally {
    signal.removeEventListener("abort", onAbort)
    http.read.removeEventListener("close", onClose)
    http.read.removeEventListener("error", onError)
    http.read.removeEventListener("head", onHead)
  }
}