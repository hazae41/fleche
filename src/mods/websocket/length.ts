import { BinaryReadError, BinaryWriteError } from "@hazae41/binary"
import { Bytes } from "@hazae41/bytes"
import { Cursor } from "@hazae41/cursor"
import { Naberius, unpack } from "@hazae41/naberius"
import { Ok, Result } from "@hazae41/result"

export class Length {

  constructor(
    readonly value: number
  ) { }

  trySize(): Result<number, never> {
    if (this.value < 126)
      return new Ok(7)
    if (this.value < 65_535)
      return new Ok(7 + 16)
    return new Ok(7 + 64)
  }

  #tryWrite7(binary: Cursor): Result<void, BinaryWriteError> {
    return Result.unthrowSync(t => {
      const lengthBytesBytes = new Uint8Array([this.value])

      using lengthBytesMemory = new Naberius.Memory(lengthBytesBytes)
      using lengthBitsMemory = unpack(lengthBytesMemory)

      binary.tryWrite(lengthBitsMemory.bytes.subarray(1)).throw(t) // 8 - 1

      return Ok.void()
    })
  }

  #tryWrite16(binary: Cursor): Result<void, BinaryWriteError> {
    return Result.unthrowSync(t => {
      const lengthBytesCursor = new Cursor(Bytes.tryAllocUnsafe(1 + 2).throw(t))
      lengthBytesCursor.tryWriteUint8(126).throw(t)
      lengthBytesCursor.tryWriteUint16(this.value).throw(t)

      using lengthBytesMemory = new Naberius.Memory(lengthBytesCursor.bytes)
      using lengthBitsMemory = unpack(lengthBytesMemory)

      binary.tryWrite(lengthBitsMemory.bytes.subarray(1)).throw(t) // (8 + 16) - 1

      return Ok.void()
    })
  }

  #tryWrite64(binary: Cursor): Result<void, BinaryWriteError> {
    return Result.unthrowSync(t => {
      const lengthBytesCursor = new Cursor(Bytes.tryAllocUnsafe(1 + 8).throw(t))
      lengthBytesCursor.tryWriteUint8(127).throw(t)
      lengthBytesCursor.tryWriteUint64(BigInt(this.value)).throw(t)

      using lengthBytesMemory = new Naberius.Memory(lengthBytesCursor.bytes)
      using lengthBitsMemory = unpack(lengthBytesMemory)

      binary.tryWrite(lengthBitsMemory.bytes.subarray(1)).throw(t) // (8 + 64) - 1

      return Ok.void()
    })
  }

  tryWrite(binary: Cursor): Result<void, BinaryWriteError> {
    if (this.value < 126)
      return this.#tryWrite7(binary)
    if (this.value < 65_535)
      return this.#tryWrite16(binary)
    return this.#tryWrite64(binary)
  }

  static tryRead(binary: Cursor): Result<Length, BinaryReadError> {
    return Result.unthrowSync(t => {
      const header = binary.tryRead(7).throw(t).reduce((p, n) => (p << 1) | n)

      if (header < 126)
        return new Ok(new Length(header))
      if (header === 126)
        return new Ok(new Length(binary.tryRead(16).throw(t).reduce((p, n) => (p << 1) | n)))
      return new Ok(new Length(binary.tryRead(64).throw(t).reduce((p, n) => (p << 1) | n)))
    })
  }

}