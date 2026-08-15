import { constants } from 'node:fs'
import { copyFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

/** Inputs for first-start persona initialization. */
export interface InitializePersonaOptions {
  /** User-owned MistyMoon data directory outside the published package tree. */
  privateHome: string
  /** Public neutral template distributed with the foundation plugin. */
  templatePath: string
}

/** Result of ensuring that the private persona exists. */
export interface PersonaInitialization {
  /** Absolute path of the user-owned persona document. */
  path: string
  /** Whether this call created the document. */
  created: boolean
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'EEXIST'
}

/**
 * Seed a private persona from the public template without overwriting owner edits.
 * @param options - Private home and public template locations.
 * @returns The private persona path and whether this call created it.
 */
export async function initializePersona(options: InitializePersonaOptions): Promise<PersonaInitialization> {
  const directory = join(options.privateHome, 'persona')
  const path = join(directory, 'persona.json')
  await mkdir(directory, { recursive: true })
  try {
    await copyFile(options.templatePath, path, constants.COPYFILE_EXCL)
    return { path, created: true }
  } catch (error) {
    if (isAlreadyExists(error)) return { path, created: false }
    throw error
  }
}
