/** Bounded Character Card JSON, PNG/APNG, and CHARX container parsing. */

import { createHash } from 'node:crypto'
import type { Readable } from 'node:stream'
import yauzl, { type Entry, type ZipFile } from 'yauzl'
import { parseCharacterCardJson, type CharacterCardImportDraft } from './character-card.js'

/** Maximum encoded upload accepted by the local Host API. */
export const MAX_CHARACTER_CARD_FILE_BYTES = 16 * 1024 * 1024
const MAX_CARD_JSON_BYTES = 2 * 1024 * 1024
const MAX_CHARX_ENTRIES = 256
const MAX_CHARX_EXPANDED_BYTES = 32 * 1024 * 1024
const MAX_CHARX_COMPRESSION_RATIO = 100
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

/** Supported physical Character Card source containers. */
export type CharacterCardContainer = 'json' | 'png' | 'charx'

/** Parsed card plus non-secret provenance needed by the owner preview. */
export interface CharacterCardFilePreview {
  source: {
    fileName: string
    container: CharacterCardContainer
    byteLength: number
    sha256: string
  }
  draft: CharacterCardImportDraft
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error(`${label} is not valid UTF-8`)
  }
}

function parseJsonBytes(bytes: Uint8Array, label: string): unknown {
  if (bytes.byteLength > MAX_CARD_JSON_BYTES) throw new Error(`${label} exceeds ${MAX_CARD_JSON_BYTES} bytes`)
  try {
    return JSON.parse(decodeUtf8(bytes, label)) as unknown
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} is not valid JSON: ${error.message}`)
    throw error
  }
}

function decodeStrictBase64(value: string, label: string): Buffer {
  if (value.length === 0 || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new Error(`${label} is not canonical base64`)
  }
  const decoded = Buffer.from(value, 'base64')
  if (decoded.toString('base64') !== value) throw new Error(`${label} is not canonical base64`)
  return decoded
}

/** Validate and decode a browser upload without accepting data-URL prefixes or whitespace. */
export function decodeCharacterCardUploadBase64(value: unknown): Buffer {
  if (typeof value !== 'string') throw new Error('character card contentBase64 must be a string')
  if (value.length > Math.ceil(MAX_CHARACTER_CARD_FILE_BYTES / 3) * 4) {
    throw new Error(`character card upload exceeds ${MAX_CHARACTER_CARD_FILE_BYTES} bytes`)
  }
  const decoded = decodeStrictBase64(value, 'character card upload')
  if (decoded.byteLength > MAX_CHARACTER_CARD_FILE_BYTES) {
    throw new Error(`character card upload exceeds ${MAX_CHARACTER_CARD_FILE_BYTES} bytes`)
  }
  return decoded
}

let crcTable: Uint32Array | undefined
function pngCrc32(bytes: Uint8Array): number {
  crcTable ??= Uint32Array.from({ length: 256 }, (_, index) => {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    return value >>> 0
  })
  let crc = 0xffffffff
  for (const byte of bytes) crc = (crc >>> 8) ^ (crcTable[(crc ^ byte) & 0xff] ?? 0)
  return (crc ^ 0xffffffff) >>> 0
}

function parsePngCard(buffer: Buffer): CharacterCardImportDraft {
  if (!buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) throw new Error('file is not a PNG or APNG')
  let offset = PNG_SIGNATURE.length
  let chunks = 0
  let chara: string | undefined
  let ccv3: string | undefined
  let ended = false
  let seenHeader = false
  while (offset < buffer.length) {
    chunks += 1
    if (chunks > 1024) throw new Error('PNG contains too many chunks')
    if (offset + 12 > buffer.length) throw new Error('PNG chunk header is truncated')
    const length = buffer.readUInt32BE(offset)
    const end = offset + 12 + length
    if (end > buffer.length) throw new Error('PNG chunk data is truncated')
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const typeAndData = buffer.subarray(offset + 4, offset + 8 + length)
    const expectedCrc = buffer.readUInt32BE(offset + 8 + length)
    if (pngCrc32(typeAndData) !== expectedCrc) throw new Error(`PNG chunk ${type} has an invalid CRC`)
    if (chunks === 1) {
      if (type !== 'IHDR' || length !== 13) throw new Error('PNG must begin with a 13-byte IHDR chunk')
      seenHeader = true
    } else if (type === 'IHDR') {
      throw new Error('PNG contains a duplicate IHDR chunk')
    }
    if (type === 'tEXt') {
      const data = buffer.subarray(offset + 8, offset + 8 + length)
      const separator = data.indexOf(0)
      if (separator < 1 || separator > 79) throw new Error('PNG tEXt chunk has an invalid keyword')
      const keyword = data.toString('latin1', 0, separator)
      if (keyword === 'chara' || keyword === 'ccv3') {
        const encoded = data.toString('latin1', separator + 1)
        if (keyword === 'ccv3') {
          if (ccv3 !== undefined) throw new Error('PNG contains duplicate ccv3 chunks')
          ccv3 = encoded
        } else {
          if (chara !== undefined) throw new Error('PNG contains duplicate chara chunks')
          chara = encoded
        }
      }
    }
    offset = end
    if (type === 'IEND') {
      if (length !== 0) throw new Error('PNG IEND chunk must be empty')
      ended = true
      break
    }
  }
  if (!seenHeader || !ended || offset !== buffer.length) throw new Error('PNG has an invalid IEND boundary')
  const selected = ccv3 ?? chara
  if (selected === undefined) throw new Error('PNG does not contain a ccv3 or chara Character Card chunk')
  const json = decodeStrictBase64(selected.trim(), ccv3 === undefined ? 'PNG chara chunk' : 'PNG ccv3 chunk')
  return parseCharacterCardJson(parseJsonBytes(json, 'embedded Character Card JSON'))
}

function openZip(buffer: Buffer): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, autoClose: false, validateEntrySizes: true }, (error, zip) => {
      if (error !== null) reject(error)
      else if (zip === undefined) reject(new Error('CHARX zip could not be opened'))
      else resolve(zip)
    })
  })
}

function validateZipPath(name: string): void {
  if (!/^[\x20-\x7e]+$/u.test(name)) throw new Error(`CHARX entry ${JSON.stringify(name)} must use printable ASCII`)
  if (name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/u.test(name)) {
    throw new Error(`CHARX entry ${JSON.stringify(name)} uses an absolute or non-portable path`)
  }
  const parts = name.split('/')
  if (parts.some(part => part === '..' || part === '.')) throw new Error(`CHARX entry ${JSON.stringify(name)} contains traversal segments`)
}

function scanZip(zip: ZipFile): Promise<Entry> {
  return new Promise((resolve, reject) => {
    const names = new Set<string>()
    let count = 0
    let total = 0
    let card: Entry | undefined
    const fail = (error: Error): void => {
      zip.close()
      reject(error)
    }
    zip.on('error', fail)
    zip.on('entry', (entry: Entry) => {
      try {
        count += 1
        if (count > MAX_CHARX_ENTRIES) throw new Error(`CHARX exceeds ${MAX_CHARX_ENTRIES} entries`)
        validateZipPath(entry.fileName)
        if (names.has(entry.fileName)) throw new Error(`CHARX contains duplicate entry ${JSON.stringify(entry.fileName)}`)
        names.add(entry.fileName)
        if ((entry.generalPurposeBitFlag & 1) !== 0) throw new Error(`CHARX entry ${JSON.stringify(entry.fileName)} is encrypted`)
        total += entry.uncompressedSize
        if (total > MAX_CHARX_EXPANDED_BYTES) throw new Error(`CHARX expands beyond ${MAX_CHARX_EXPANDED_BYTES} bytes`)
        if (entry.uncompressedSize > 0 && (entry.compressedSize === 0
          || entry.uncompressedSize / entry.compressedSize > MAX_CHARX_COMPRESSION_RATIO)) {
          throw new Error(`CHARX entry ${JSON.stringify(entry.fileName)} exceeds compression ratio ${MAX_CHARX_COMPRESSION_RATIO}`)
        }
        if (entry.fileName === 'card.json') card = entry
        zip.readEntry()
      } catch (error) {
        fail(error instanceof Error ? error : new Error('CHARX entry validation failed'))
      }
    })
    zip.once('end', () => {
      if (card === undefined) fail(new Error('CHARX does not contain root card.json'))
      else resolve(card)
    })
    zip.readEntry()
  })
}

function readZipEntry(zip: ZipFile, entry: Entry): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error !== null) {
        zip.close()
        reject(error)
        return
      }
      if (stream === undefined) {
        zip.close()
        reject(new Error('CHARX card.json stream is unavailable'))
        return
      }
      const parts: Buffer[] = []
      let size = 0
      const readable = stream as Readable
      readable.on('data', (part: Buffer) => {
        size += part.byteLength
        if (size > MAX_CARD_JSON_BYTES) readable.destroy(new Error(`CHARX card.json exceeds ${MAX_CARD_JSON_BYTES} bytes`))
        else parts.push(part)
      })
      readable.once('error', (streamError) => {
        zip.close()
        reject(streamError)
      })
      readable.once('end', () => {
        zip.close()
        resolve(Buffer.concat(parts, size))
      })
    })
  })
}

async function parseCharxCard(buffer: Buffer): Promise<CharacterCardImportDraft> {
  const zip = await openZip(buffer)
  const entry = await scanZip(zip)
  return parseCharacterCardJson(parseJsonBytes(await readZipEntry(zip, entry), 'CHARX card.json'))
}

/** Parse a bounded untrusted card file without executing or retaining assets. */
export async function parseCharacterCardFile(fileName: string, bytes: Uint8Array): Promise<CharacterCardFilePreview> {
  if (typeof fileName !== 'string' || fileName.trim() === '' || fileName.length > 255) {
    throw new Error('character card fileName must be 1 through 255 characters')
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_CHARACTER_CARD_FILE_BYTES) {
    throw new Error(`character card file must be 1 through ${MAX_CHARACTER_CARD_FILE_BYTES} bytes`)
  }
  const buffer = Buffer.from(bytes)
  let container: CharacterCardContainer
  let draft: CharacterCardImportDraft
  if (buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    container = 'png'
    draft = parsePngCard(buffer)
  } else if (buffer.subarray(0, 2).toString('ascii') === 'PK') {
    container = 'charx'
    draft = await parseCharxCard(buffer)
  } else {
    container = 'json'
    draft = parseCharacterCardJson(parseJsonBytes(buffer, 'Character Card JSON'))
  }
  return {
    source: {
      fileName,
      container,
      byteLength: buffer.byteLength,
      sha256: createHash('sha256').update(buffer).digest('hex'),
    },
    draft,
  }
}
