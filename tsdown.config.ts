import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { defineConfig } from 'tsdown'
import { transform } from 'lightningcss'

const PACKAGE_ID = 'dsh-llm-codex-app-server'
const CSS_PREFIX = '\0codex-app-server-css:'
const CSS_SUFFIX = '.mjs'

const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
] as const

export default defineConfig([
  {
    name: PACKAGE_ID,
    entry: ['src/index.ts'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    dts: false,
    clean: true,
    fixedExtension: false,
    deps: {
      neverBundle: [
        '@deepseek-ai/cordis',
        '@deepseek-ai/dsh-llm',
        '@deepseek-ai/dsh-subprocess',
        '@deepseek-ai/schemastery',
        '@openai/codex',
      ],
    },
  },
  {
    name: `${PACKAGE_ID}/client`,
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    dts: false,
    clean: false,
    sourcemap: true,
    deps: {
      neverBundle: [...CLIENT_EXTERNALS],
      alwaysBundle: id => CLIENT_EXTERNALS.includes(id as typeof CLIENT_EXTERNALS[number]) ? undefined : true,
    },
    plugins: [{
      name: 'codex-app-server-css-modules',
      resolveId(source: string, importer: string | undefined) {
        if (!source.endsWith('.module.css') || importer === undefined) return null
        return `${CSS_PREFIX}${resolve(dirname(importer), source)}${CSS_SUFFIX}`
      },
      async load(id: string) {
        if (!id.startsWith(CSS_PREFIX)) return null
        const path = id.slice(CSS_PREFIX.length, -CSS_SUFFIX.length)
        this.addWatchFile(path)
        const source = await readFile(path)
        const result = transform({
          filename: path,
          code: source,
          cssModules: { pattern: '[hash]_[local]' },
          minify: true,
        })
        const classes: Record<string, string> = {}
        for (const [local, value] of Object.entries(result.exports ?? {})) classes[local] = value.name
        const tagId = `${PACKAGE_ID}/${basename(path)}`
        return [
          `const css = ${JSON.stringify(result.code.toString())};`,
          `const tagId = ${JSON.stringify(tagId)};`,
          'if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {',
          '  const tag = document.createElement("style");',
          `  tag.dataset.plugin = ${JSON.stringify(PACKAGE_ID)};`,
          '  tag.dataset.pluginCss = tagId;',
          '  tag.textContent = css;',
          '  document.head.appendChild(tag);',
          '}',
          `export default ${JSON.stringify(classes)};`,
        ].join('\n')
      },
    }],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
