import { Future } from "libs/futures/future.js"

export type AbortEvent = Event & { target: AbortSignal }


export namespace Signals {

  export async function wait(signal: AbortSignal) {
    const future = new Future<never, Event>()

    try {
      signal.addEventListener("abort", future.err, { passive: true })

      return await future.promise
    } finally {
      signal.removeEventListener("abort", future.err)
    }
  }

}