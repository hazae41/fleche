import { Opaque, Writable } from "@hazae41/binary"
import { Cleaner } from "@hazae41/cleaner"
import { Future } from "@hazae41/future"
import { Some } from "@hazae41/option"
import { AbortedError, ClosedError, ErroredError } from "@hazae41/plume"
import { Err, Ok, Result } from "@hazae41/result"
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
    super(undefined, options)
  }

  static wait(http: HttpClientDuplex, body?: ReadableStream<Uint8Array> | null) {
    const controller = new AbortController()
    const future = new Future<Err<PipeError>>()

    const { signal } = controller

    if (body != null)
      body.pipeTo(http.writable, { signal }).catch(e => future.resolve(new Err(new PipeError({ cause: e }))))
    else
      http.writable.close().catch(e => future.resolve(new Err(new PipeError({ cause: e }))))

    return new Cleaner(future.promise, () => controller.abort())
  }

}

/**
 * Fetch adapter for HTTP streams
 * Will wait for response to be available
 * @param input "https://google.com"
 * @param init.stream Transport substream
 * @returns 
 */
export async function fetch(input: RequestInfo | URL, init: RequestInit & FetchParams) {
  return await tryFetch(input, init).then(r => r.unwrap())
}

/**
 * Fetch adapter for HTTP streams
 * Will wait for response to be available
 * @param input "https://google.com"
 * @param init.stream Transport substream
 * @returns 
 */
export async function tryFetch(input: RequestInfo | URL, init: RequestInit & FetchParams): Promise<Result<Response, AbortedError | ErroredError | ClosedError | PipeError>> {
  const { stream, ...initRest } = init

  const request = new Request(input, initRest)
  const body = await Requests.getBody(request, initRest)

  const { url, method, signal } = request
  const { host, pathname } = new URL(url)
  const headers = new Headers(init.headers)

  if (!headers.has("Host"))
    headers.set("Host", host)
  if (!headers.has("Transfer-Encoding"))
    headers.set("Transfer-Encoding", "chunked")
  if (!headers.has("Accept-Encoding"))
    headers.set("Accept-Encoding", "gzip")

  const http = new HttpClientDuplex(stream, { pathname, method, headers, signal })

  const abort = AbortedError.wait(signal)
  const error = ErroredError.wait(http.reading)
  const close = ClosedError.wait(http.reading)
  const pipe = PipeError.wait(http, body)

  const head = http.reading.wait("head", init => new Some(new Ok(new Response(http.readable, init))))

  return await Cleaner.race<Promise<Result<Response, AbortedError | ErroredError | ClosedError | PipeError>>>([abort, error, close, pipe, head])
}