import { Disposer } from "@hazae41/disposer";
import { Future } from "@hazae41/future";

export namespace AbortSignals {

  export function rejectOnAbort(signal: AbortSignal) {
    const rejectOnAbort = new Future<never>()

    rejectOnAbort.promise.catch(() => { })

    const onAbort = () => rejectOnAbort.reject(new Error("Aborted"))
    const onClean = () => signal.removeEventListener("abort", onAbort)

    signal.addEventListener("abort", onAbort)
    rejectOnAbort.promise.finally(onClean)

    return new Disposer(rejectOnAbort.promise, onClean)
  }

}