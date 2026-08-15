import type { UserConfig } from 'tsdown'

const packageId = '@mistymoon/dsh'

const host: UserConfig = {
  name: `${packageId}/host`,
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  noExternal: id => id === '@mistymoon/dsh-foundation/persona-document'
    || id === '@mistymoon/dsh-memory/runtime-settings',
}

const client: UserConfig = {
  name: `${packageId}/client`,
  entry: { client: 'lib/types/client/index.js' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2023',
  dts: false,
  sourcemap: true,
  clean: false,
  external: ['react', 'react/jsx-runtime'],
  noExternal: id => id === 'react' || id === 'react/jsx-runtime' ? undefined : true,
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(packageId)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default [host, client]
