import { Future } from "libs/futures/future.js"

export namespace Signals {

  export async function wait(signal: AbortSignal) {
    const future = new Future<never, Event>()

    function onabort(e: Event) {
      console.log("aborted lol")
      future.err(e)
    }

    try {
      signal.addEventListener("abort", onabort)

      return await future.promise
    } finally {
      signal.removeEventListener("abort", onabort)
    }
  }

}