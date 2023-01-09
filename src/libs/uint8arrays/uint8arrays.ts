
export namespace Uint8Arrays {

  export function zero(view: ArrayBufferView) {
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
  }

  export function intoUtf8(array: Uint8Array) {
    return new TextDecoder().decode(array)
  }

  export function fromUtf8(text: string) {
    return new TextEncoder().encode(text)
  }

}