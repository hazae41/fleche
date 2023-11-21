import { Opaque, Writable } from "@hazae41/binary"
import { Disposable, PromiseDisposer } from "@hazae41/cleaner"
import { Future } from "@hazae41/future"
import { None, Nullable } from "@hazae41/option"
import { AbortedError, ClosedError, ErroredError } from "@hazae41/plume"
import { Catched } from "@hazae41/result"
import { HttpClientDuplex } from "mods/http/client.js"

export interface FetchParams {
  stream: ReadableWritablePair<Opaque, Writable>
}

namespace Requests {

  export async function getBody(request: Request, init: RequestInit) {
    /**
     * Firefox fix
     */
    if (request.body == null && init.body != null) {
      if (init.body instanceof ReadableStream) {
        return init.body as ReadableStream<Uint8Array>
      } else {
        const blob = await request.blob()
        return blob.stream()
      }
    }

    return request.body
  }

}

export class PipeError extends Error {
  readonly #class = PipeError
  readonly name = this.#class.name

  constructor(options: ErrorOptions) {
    super(`Could not pipe`, options)
  }

  static from(cause: unknown) {
    return new PipeError({ cause })
  }

  static fromAndThrow(cause: unknown) {
    throw PipeError.from(cause)
  }

  static waitOrThrow(http: HttpClientDuplex, body: Nullable<ReadableStream<Uint8Array>>) {
    const controller = new AbortController()
    const future = new Future<never>()

    const { signal } = controller

    if (body != null)
      body.pipeTo(http.outer.writable, { signal }).catch(PipeError.fromAndThrow).catch(future.reject)
    else
      http.outer.writable.close().catch(PipeError.fromAndThrow).catch(future.reject)

    return new PromiseDisposer(future.promise, () => controller.abort())
  }

}


/**
 * Fetch adapter for HTTP streams
 * Will wait for response to be available
 * @param input "https://google.com"
 * @param init.stream Transport substream
 * @returns 
 */
export async function fetch(input: RequestInfo | URL, init: RequestInit & FetchParams & StreamPipeOptions): Promise<Response> {
  const { stream, preventAbort, preventCancel, preventClose, ...others } = init

  const request = new Request(input, others)
  const body = await Requests.getBody(request, others)

  const { url, method, signal } = request
  const { host, pathname, search } = new URL(url)

  const target = pathname + search
  const headers = new Headers(init.headers)

  if (!headers.has("Host"))
    headers.set("Host", host)
  if (!headers.has("Connection"))
    headers.set("Connection", "keep-alive")
  if (!headers.has("Transfer-Encoding") && !headers.has("Content-Length"))
    headers.set("Transfer-Encoding", "chunked")
  if (!headers.has("Accept-Encoding"))
    headers.set("Accept-Encoding", "gzip, deflate")

  const http = new HttpClientDuplex({ method, target, headers })

  stream.readable
    .pipeTo(http.inner.writable, { signal, preventCancel })
    .catch(Catched.throwOrErr)
    .then(r => r?.ignore())
    .catch(console.error)

  http.inner.readable
    .pipeTo(stream.writable, { signal, preventClose, preventAbort })
    .catch(Catched.throwOrErr)
    .then(r => r?.ignore())
    .catch(console.error)

  const abort = AbortedError.waitOrThrow(signal)
  const error = ErroredError.waitOrThrow(http.events.input)
  const close = ClosedError.waitOrThrow(http.events.input)
  const pipe = PipeError.waitOrThrow(http, body)

  const head = http.events.input.wait("head", (future: Future<Response>, init) => {
    future.resolve(new Response(http.outer.readable, init))
    return new None()
  })

  const response = await Disposable.race<Response>([abort, error, close, pipe, head])

  http.events.input.on("close", async () => {
    if (response.headers.get("Connection") !== "close")
      return new None()

    await stream.readable.cancel(new Error(`Response "Connection" header is "close"`))

    return new None()
  }, { once: true })

  return response
}