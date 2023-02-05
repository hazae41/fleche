import { Binary } from "@hazae41/binary"
import { pack_left, unpack, xor_mod } from "@hazae41/naberius"
import { Length } from "mods/websocket/length.js"

export class Frame {

  static readonly opcodes = {
    continuation: 0,
    text: 1,
    binary: 2,

    /**
     * Control
     */
    close: 8,
    ping: 9,
    pong: 10
  } as const

  constructor(
    readonly final: boolean,
    readonly opcode: number,
    readonly payload: Uint8Array,
    readonly mask?: Uint8Array,
  ) { }

  private length?: Length

  prepare() {
    this.length = new Length(this.payload.length)
  }

  /**
   * Size as bits
   * @returns bits
   */
  size() {
    this.prepare()

    return 0
      + 1 // FIN
      + 3 // RSV
      + 4 // opcode
      + 1 // MASK
      + this.length!.size()
      + (this.mask?.length ?? 0) * 8
      + this.payload.length * 8
  }

  /**
   * Write as bits
   * @param binary bits
   */
  write(binary: Binary) {
    const FIN = this.final
      ? 1
      : 0
    binary.writeUint8(FIN)

    /**
     * RSV
     */
    binary.writeUint8(0)
    binary.writeUint8(0)
    binary.writeUint8(0)

    const opcodeBytes = Binary.allocUnsafe(1)
    opcodeBytes.writeUint8(this.opcode)
    const opcodeBits = unpack(opcodeBytes.bytes)
    binary.write(opcodeBits.subarray(4)) // 8 - 4

    const MASK = this.mask
      ? 1
      : 0
    binary.writeUint8(MASK)

    this.length!.write(binary)
    console.log(this.length)

    if (this.mask) {
      binary.write(unpack(this.mask))
      xor_mod(this.payload, this.mask)
    }

    binary.write(unpack(this.payload))
  }

  /**
   * Read from bits
   * @param binary bits
   * @returns 
   */
  static read(binary: Binary) {
    /**
     * FIN
     */
    const final = Boolean(binary.readUint8())

    /**
     * RSV
     */
    binary.offset += 3

    const opcode = binary.read(4).reduce((p, n) => (p << 1) | n)

    /**
     * MASK
     */
    const masked = Boolean(binary.readUint8())

    const length = Length.read(binary)

    if (masked) {
      const mask = pack_left(binary.read(4 * 8))
      const payload = pack_left(binary.read(length.value * 8))
      xor_mod(payload, mask)

      return new this(final, opcode, payload, mask)
    } else {
      const payload = pack_left(binary.read(length.value * 8))
      return new this(final, opcode, payload)
    }
  }

  /**
   * Bits as Uint8Array
   * @returns bits
   */
  export() {
    const bits = Binary.allocUnsafe(this.size())
    this.write(bits)
    return bits.bytes
  }
}