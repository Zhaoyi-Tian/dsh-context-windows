import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
const cli = join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js')
const base = resolve(process.env.CONTEXT_WINDOWS_TEST_ROOT ?? join(root, 'node_modules/.cache/dsh-context-windows'))
mkdirSync(base, { recursive: true })
const work = mkdtempSync(join(base, 'install-'))
const home = join(work, 'home')
const env = { ...process.env, DSH_HOME: home, TMPDIR: work, PATH: `${join(root, 'node_modules/.bin')}:${process.env.PATH}`, DSH_TOOLS_MODE: 'native' }
const tarball = process.env.CONTEXT_WINDOWS_TARBALL ?? join(root, `dsh-context-windows-${JSON.parse(readFileSync(join(root, 'package.json'))).version}.tgz`)
const manifestPath = join(home, 'profiles/headless/package.json')
const packageOptions = [
  ...process.env.CONTEXT_WINDOWS_PNPM_STORE ? [`--store-dir=${process.env.CONTEXT_WINDOWS_PNPM_STORE}`] : [],
  ...process.env.CONTEXT_WINDOWS_PNPM_CACHE ? [`--config.cacheDir=${process.env.CONTEXT_WINDOWS_PNPM_CACHE}`] : [],
]

function dsh(args) {
  try {
    return execFileSync(process.execPath, [cli, ...args], { cwd: work, env, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 })
  } catch (error) {
    throw new Error(`dsh ${args.join(' ')} failed\n${error.stdout ?? ''}\n${error.stderr ?? ''}`, { cause: error })
  }
}

function overlay(mode) {
  const path = join(work, `${mode}.yml`)
  const provider = pathToFileURL(join(root, 'tests/support/installed-model.mjs')).href
  writeFileSync(path, `- id: agent-default-model\n  config:\n    provider: dsh-context-windows-test\n    model: scripted\n- id: tools\n  config:\n    mode: native\n- id: session-title-llm\n  disabled: true\n- id: spill-policy\n  config:\n    maxInlineTokens: 1024\n- insert:\n    - id: dsh-context-windows-test-model\n      name: ${JSON.stringify(provider)}\n      config:\n        mode: ${mode}\n`)
  return path
}

function run(mode, task, sessionId) {
  const args = ['--profile', 'headless', '--patch', overlay(mode), '--json']
  if (sessionId) args.push('--session-id', sessionId)
  args.push(task)
  const events = dsh(args).trim().split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line))
  assert.equal(events.find(event => event.type === 'final')?.text, `CONTEXT_WINDOWS_${mode === 'resume' ? 'RESUMED' : mode === 'disabled' ? 'DISABLED' : 'RECOVERED'}`)
  return events.find(event => event.type === 'session')?.sessionId
}

function entry(dump, id) {
  const row = dump.split(/(?=^- id: )/m).find(row => row.startsWith(`- id: ${id}\n`))
  assert.ok(row, `profile contains ${id}`)
  return row
}

try {
  dsh(['plugin', '--profile', 'headless', 'add', tarball, ...packageOptions])
  const manifest = JSON.parse(readFileSync(manifestPath))
  assert.deepEqual(Object.keys(manifest.dependencies), ['dsh-context-windows'])
  assert.equal(manifest.dsh.profile.bundles.filter(name => name === 'dsh-context-windows').length, 1)
  const installed = join(home, 'profiles/headless/node_modules/dsh-context-windows')
  assert.ok(readFileSync(join(installed, 'dist/index.js'), 'utf8').includes('dsh-context-windows'))
  const dump = dsh(['--profile', 'headless', '--dump-config'])
  assert.match(entry(dump, 'dsh-context-windows'), /name: dsh-context-windows/)
  for (const id of ['compaction-basic', 'command-compact']) assert.match(entry(dump, id), /^  disabled: true$/m)
  console.log('PASS: one-command package installation and profile activation')

  dsh(['plugin', '--profile', 'web', 'add', tarball, ...packageOptions])
  const web = dsh(['--profile', 'web', '--dump-config'])
  const preset = entry(web, 'preset-dsh-context-windows')
  assert.match(preset, /id: dsh-context-windows/)
  assert.match(preset, /name: dsh-context-windows/)
  assert.match(preset, /dsh-tool-bash-persistent/)
  assert.doesNotMatch(preset, /dsh-compaction-basic|dsh-command-compact|dsh-compaction-tool-result-pruner/)
  assert.match(entry(web, 'dsh-context-windows'), /disabled:[\s\S]*startedBundles/)
  for (const id of ['preset-standard', 'preset-ptc', 'preset-cordis']) {
    assert.match(entry(web, id), /dsh-compaction-basic/)
    assert.match(entry(web, id), /dsh-command-compact/)
  }
  console.log('PASS: independent Web preset without default compaction; builtin presets retain their own composition')

  const sessionId = run('recover', 'RECOVERY_NEEDLE: use the installed context windows plugin.\n' + 'historical context '.repeat(4000))
  assert.ok(sessionId)
  run('resume', 'Resume from the saved checkpoint.', sessionId)
  console.log('PASS: installed tools, context switch, history recovery, host spill, and cross-process session resume')

  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(name => name !== 'dsh-context-windows')
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  run('disabled', 'Check disabled plugin.')
  const disabled = dsh(['--profile', 'headless', '--dump-config'])
  assert.doesNotMatch(disabled, /id: dsh-context-windows/)
  for (const id of ['compaction-basic', 'command-compact']) assert.doesNotMatch(entry(disabled, id), /^  disabled: true$/m)
  console.log('PASS: disabling the bundle removes its tools and restores default compaction')

  manifest.dsh.profile.bundles.push('dsh-context-windows')
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  run('resume', 'Read the checkpoint after re-enabling the bundle.', sessionId)
  console.log('PASS: re-enabling preserves existing notes')

  dsh(['plugin', '--profile', 'headless', 'remove', 'dsh-context-windows', ...packageOptions])
  assert.ok(!JSON.parse(readFileSync(manifestPath)).dependencies?.['dsh-context-windows'])
  console.log('PASS: uninstall')
} finally {
  rmSync(work, { recursive: true, force: true })
}
