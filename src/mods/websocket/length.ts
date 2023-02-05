import { Binary } from "@hazae41/binary"
import { unpack } from "@hazae41/naberius"

export class Length {

  constructor(
    readonly value: number
  ) { }

  size() {
    if (this.value < 126)
      return 7
    if (this.value < 65535)
      return 7 + 16
    return 7 + 64
  }

  private write7(binary: Binary) {
    const lengthBytes = Binary.allocUnsafe(1)
    lengthBytes.writeUint8(this.value)
    const lengthBits = unpack(lengthBytes.bytes)
    console.log("length", lengthBits)
    binary.write(lengthBits.subarray(1)) // 8 - 1
  }

  private write16(binary: Binary) {
    const length = Binary.allocUnsafe(1 + 2)
    length.writeUint8(126)
    length.writeUint16(this.value)

    binary.write(unpack(length.bytes).subarray(1)) // (8 + 16) - 1
  }

  private write64(binary: Binary) {
    const length = Binary.allocUnsafe(1 + 8)
    length.writeUint8(127)
    length.writeUint64(BigInt(this.value))

    binary.write(unpack(length.bytes).subarray(1)) // (8 + 64) - 1
  }

  write(binary: Binary) {
    if (this.value < 126)
      return this.write7(binary)
    if (this.value < 65535)
      return this.write16(binary)
    return this.write64(binary)
  }

  static read(binary: Binary) {
    const header = binary.read(7).reduce((p, n) => (p << 1) | n)

    if (header < 126)
      return new this(header)
    if (header === 126)
      return new this(binary.read(16).reduce((p, n) => (p << 1) | n))
    return new this(binary.read(64).reduce((p, n) => (p << 1) | n))
  }
}