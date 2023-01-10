export type Bytes = Uint8Array

export namespace Bytes {

  /**
   * Zero-copy cast the buffer into Uint8Array
   * @param buffer 
   * @returns 
   */
  export function fromBuffer(buffer: ArrayBufferLike) {
    return new Uint8Array(buffer)
  }

  /**
   * Zero-copy cast the view into Uint8Array
   * @param view 
   * @returns 
   */
  export function fromView(view: ArrayBufferView) {
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
  }

  /**
   * Convert utf8 string to bytes using TextEncoder
   * @param text 
   * @returns 
   */
  export function fromUtf8(text: string) {
    return new TextEncoder().encode(text)
  }

  /**
   * Convert bytes to utf8 string using TextDecoder
   * @param text 
   * @returns 
   */
  export function toUtf8(array: Uint8Array) {
    return new TextDecoder().decode(array)
  }

}