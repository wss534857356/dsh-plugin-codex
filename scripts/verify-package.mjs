/** Verify release metadata and the exact npm pack surface without creating a tarball. */

import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const EXPECTED_NAME = 'dsh-llm-codex-app-server'
const EXPECTED_REPOSITORY = 'git+https://github.com/wss534857356/dsh-plugin-codex.git'
const EXPECTED_REGISTRY = 'https://registry.npmjs.org/'
const REQUIRED_FILES = [
  'LICENSE',
  'README.md',
  'README.zh.md',
  'cordis.patch.yml',
  'lib/client.js',
  'lib/client/index.d.ts',
  'lib/index.d.ts',
  'lib/index.js',
  'package.json',
]
const FORBIDDEN_PREFIXES = ['.github/', 'scripts/', 'src/', 'tests/']
const ROOT = fileURLToPath(new URL('..', import.meta.url))

function fail(message) {
  console.error(`release verification failed: ${message}`)
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const tag = process.argv[2] === '--' ? process.argv[3] : process.argv[2]

if (manifest.name !== EXPECTED_NAME) fail(`package name must be ${EXPECTED_NAME}`)
if (!/^\d+\.\d+\.\d+$/u.test(manifest.version)) {
  fail(`package version must be a stable x.y.z release: ${JSON.stringify(manifest.version)}`)
}
if (tag !== undefined && tag !== `v${manifest.version}`) {
  fail(`git tag ${JSON.stringify(tag)} does not match package version v${manifest.version}`)
}
if (manifest.private === true) fail('package.json must not set private=true')
if (manifest.repository?.url !== EXPECTED_REPOSITORY) {
  fail(`repository.url must be ${EXPECTED_REPOSITORY} for npm provenance`)
}
if (manifest.publishConfig?.registry !== EXPECTED_REGISTRY) {
  fail(`publishConfig.registry must be ${EXPECTED_REGISTRY}`)
}
if (manifest.publishConfig?.access !== 'public') fail('publishConfig.access must be public')
if (manifest.publishConfig?.provenance !== true) fail('publishConfig.provenance must be true')

const packArgs = ['pack', '--dry-run', '--json', '--ignore-scripts']
const windowsNpmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
if (process.platform === 'win32' && !existsSync(windowsNpmCli)) {
  fail(`cannot locate the npm CLI beside Node at ${windowsNpmCli}`)
}
const command = process.platform === 'win32' ? process.execPath : 'npm'
const args = process.platform === 'win32' ? [windowsNpmCli, ...packArgs] : packArgs
const output = execFileSync(command, args, {
  cwd: ROOT,
  encoding: 'utf8',
  env: {
    ...process.env,
    NO_COLOR: '1',
    npm_config_ignore_scripts: 'true',
    npm_config_loglevel: 'silent',
  },
})
// npm 10 can still forward prepare-script output before its JSON result even
// when ignore-scripts is requested. Anchor on the pack result instead of
// assuming stdout contains JSON alone; npm 11 emits the shorter form.
const jsonStart = output.search(/\[\s*\{\s*"id"/u)
if (jsonStart < 0) fail('npm pack did not emit a JSON package result')
const [packed] = JSON.parse(output.slice(jsonStart))
if (packed?.name !== manifest.name || packed?.version !== manifest.version) {
  fail('npm pack metadata does not match package.json')
}

const files = new Set(packed.files.map(file => file.path))
for (const required of REQUIRED_FILES) {
  if (!files.has(required)) fail(`packed artifact is missing ${required}`)
}
for (const file of files) {
  if (FORBIDDEN_PREFIXES.some(prefix => file.startsWith(prefix))) {
    fail(`packed artifact unexpectedly includes ${file}`)
  }
}

const tarball = `dist/${packed.filename}`
if (process.env.GITHUB_OUTPUT !== undefined) {
  appendFileSync(process.env.GITHUB_OUTPUT, `tarball=${tarball}\n`, 'utf8')
}
console.log(`verified ${packed.name}@${packed.version}: ${packed.entryCount} files, tarball ${tarball}`)
