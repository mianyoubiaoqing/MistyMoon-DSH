import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'

/** Hash one installer-owned artifact without interpreting its contents. */
export function fingerprintInstallerArtifact(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}
