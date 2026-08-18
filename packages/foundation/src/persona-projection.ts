import { createHash } from 'node:crypto'
import { loadPersona, parsePersona, renderPersona } from './persona-document.js'

/** Immutable published Persona snapshot consumed by RP Host prompt assembly. */
export interface PublishedPersonaSnapshot {
  readonly schemaVersion: 1
  readonly personaVersion: number
  readonly fingerprint: string
  readonly text: string
}

function freezeSnapshot(personaVersion: number, text: string): PublishedPersonaSnapshot {
  return Object.freeze({
    schemaVersion: 1,
    personaVersion,
    fingerprint: createHash('sha256').update(text, 'utf8').digest('hex'),
    text,
  })
}

/**
 * Owns the validated, synchronously readable Persona snapshot used by RP Host.
 *
 * File I/O and schema validation happen only in {@link load} and
 * {@link refresh}; prompt assembly receives an immutable snapshot and never
 * reads private storage synchronously. A failed refresh leaves the last valid
 * published snapshot active.
 */
export class PublishedPersonaProjection {
  private snapshot: PublishedPersonaSnapshot

  private constructor(
    readonly path: string,
    initial: PublishedPersonaSnapshot,
  ) {
    this.snapshot = initial
  }

  /** Load the first valid published Persona snapshot. */
  static async load(path: string): Promise<PublishedPersonaProjection> {
    const persona = await loadPersona(path)
    return new PublishedPersonaProjection(
      path,
      freezeSnapshot(persona.schemaVersion, renderPersona(persona)),
    )
  }

  /** Return the exact immutable snapshot used by the next RP Host assembly. */
  current(): PublishedPersonaSnapshot {
    return this.snapshot
  }

  /** Atomically replace the cached snapshot after validating the active file. */
  async refresh(): Promise<PublishedPersonaSnapshot> {
    const persona = await loadPersona(this.path)
    return this.replace(persona)
  }

  /** Replace the cached snapshot from one already-published, validated value. */
  replace(value: unknown): PublishedPersonaSnapshot {
    const persona = parsePersona(value)
    const next = freezeSnapshot(persona.schemaVersion, renderPersona(persona))
    this.snapshot = next
    return next
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Validated active Persona cache shared with the RP Host preset layer. */
    mistymoonPersonaProjection: PublishedPersonaProjection
  }
}
