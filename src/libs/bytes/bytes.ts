import { Buffers } from "libs/buffers/buffers.js"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export namespace Bytes {

  export function allocUnsafe(length: number) {
    return fromView(Buffer.allocUnsafe(length))
  }

  export function fromView(view: ArrayBufferView) {
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
  }

  export function fromUtf8(text: string) {
    return encoder.encode(text)
  }

  export function toUtf8(bytes: Uint8Array) {
    return decoder.decode(bytes)
  }

  export function fromHex(text: string) {
    return fromView(Buffer.from(text, "hex"))
  }

  export function toHex(bytes: Uint8Array) {
    return Buffers.fromView(bytes).toString("hex")
  }

  export function fromBase64(text: string) {
    return fromView(Buffer.from(text, "base64"))
  }

  export function toBase64(bytes: Uint8Array) {
    return Buffers.fromView(bytes).toString("base64")
  }

  export function fromAscii(text: string) {
    return fromView(Buffer.from(text, "ascii"))
  }

  export function toAscii(bytes: Uint8Array) {
    return Buffers.fromView(bytes).toString("ascii")
  }

  export function random(length: number) {
    const buffer = Buffer.allocUnsafe(length)
    crypto.getRandomValues(buffer)
    return fromView(buffer)
  }

  export function concat(list: Uint8Array[]) {
    return fromView(Buffer.concat(list))
  }

  export function mask(bytes: Uint8Array, mask: Uint8Array, mod: number) {
    return bytes.map((x, i) => x ^ mask[i % mod])
  }


  function toBit(value: number, index: number, result: Uint8Array) {

  }

  /**
   * Expand each byte into 8 one-or-zero bytes
   * @param bytes 
   */
  export function toBits(bytes: Uint8Array) {
    const bits = new Uint8Array(bytes.length * 8)
    bytes.reduce((p, x) => p + x.toString(2).padStart(8, "0"), "")

  }

  /**
   * Shrink each 8 one-or-zero bytes into 1 byte
   * @param bytes 
   */
  export function fromBits(bytes: Uint8Array) {

  }
}