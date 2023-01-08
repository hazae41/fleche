export namespace Promises {

  export async function escape<T>(promise: Promise<T>, rejecter: Promise<never>) {
    return await Promise.race([rejecter, promise]) as Awaited<T>
  }

  export async function escape2<T>(promise: Promise<T>, rejecter: Promise<never>, rejecter2: Promise<never>) {
    const rejecter3 = await escape(rejecter, rejecter2)
    return await escape(promise, rejecter3)
  }

}