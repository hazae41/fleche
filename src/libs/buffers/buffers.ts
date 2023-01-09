export namespace Buffers {

  /**
   * Create a zero-copy Buffer from the given view
   * @param view A view, can be a TypedArray (Uint8Array) or a raw view (buffer + offset + length)
   * @returns zero-copy Buffer from the given view
   */
  export function zero(view: ArrayBufferView) {
    return Buffer.from(view.buffer, view.byteOffset, view.byteLength)
  }

}