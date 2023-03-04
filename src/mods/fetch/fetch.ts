import { Opaque, Writable } from "@hazae41/binary"
import { Future } from "@hazae41/future"
import { AbortEvent } from "libs/events/abort.js"
import { HttpClientStream } from "mods/http/client.js"

export interface FetchParams {
  stream: ReadableWritablePair<Opaque, Writable>
}

/**
 * Fetch adapter for HTTP streams
 * Will wait for response to be available
 * @param input "https://google.com"
 * @param init.stream Transport substream
 * @returns 
 */
export async function fetch(input: RequestInfo | URL, init: RequestInit & FetchParams) {
  const { stream, ...initRest } = init

  const request = new Request(input, initRest)
  const future = new Future<Response>()

  const { url, method, signal } = request
  const { host, pathname } = new URL(url)
  const headers = new Headers(init.headers)

  if (!headers.has("Host"))
    headers.set("Host", host)
  if (!headers.has("Transfer-Encoding"))
    headers.set("Transfer-Encoding", "chunked")
  if (!headers.has("Accept-Encoding"))
    headers.set("Accept-Encoding", "gzip")

  const http = new HttpClientStream(stream, { pathname, method, headers, signal })

  const onHead = (event: Event) => {
    const msgEvent = event as MessageEvent<ResponseInit>
    const response = new Response(http.readable, msgEvent.data)
    future.resolve(response)
  }

  const onAbort = (event: Event) => {
    const abortEvent = event as AbortEvent
    const error = new Error(`Aborted`, { cause: abortEvent.target.reason })
    future.reject(error)
  }

  const onClose = (event: Event) => {
    const closeEvent = event as CloseEvent
    const error = new Error(`Closed`, { cause: closeEvent })
    future.reject(error)
  }

  const onError = (event: Event) => {
    const errorEvent = event as ErrorEvent
    const error = new Error(`Errored`, { cause: errorEvent })
    future.reject(error)
  }

  try {
    signal.addEventListener("abort", onAbort, { passive: true })
    http.reading.addEventListener("close", onClose, { passive: true })
    http.reading.addEventListener("error", onError, { passive: true })
    http.reading.addEventListener("head", onHead, { passive: true })

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
      body.pipeTo(http.writable, { signal }).catch(future.reject)
    else
      http.writable.close().catch(future.reject)

    return await future.promise
  } finally {
    signal.removeEventListener("abort", onAbort)
    http.reading.removeEventListener("close", onClose)
    http.reading.removeEventListener("error", onError)
    http.reading.removeEventListener("head", onHead)
  }
}