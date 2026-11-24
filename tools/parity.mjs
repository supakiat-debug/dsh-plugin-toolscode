/**
 * Prove the two implementations of the wire shrink still agree, byte for byte.
 *
 * ``lib/wire.js`` and ``adapters/hermes/toolscode/toolscode_core.py`` are the
 * same program written twice, once for the JavaScript harnesses (dsh, pi) and
 * once for the Python one (Hermes). The shared fixture pins a handful of
 * truncated strings, which catches most drift; this catches the rest by running
 * every payload in the fixture through both shrinkers and comparing the whole
 * output — payload and report — as text, so a moved key, a different word
 * boundary, or a tool reported as shrunk on one side only is a failure.
 *
 * Each side reads the fixture itself; neither is handed the other's answer.
 *
 * Usage: ``node tools/parity.mjs [python]`` (or ``npm run test:parity``, which
 * passes ``PYTHON`` when you keep an interpreter off PATH). Exits 0 when the two
 * agree, 1 on a difference, 3 when Python is not installed at all — a missing
 * interpreter is a skipped check, not a broken build.
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { shrinkWirePayload } from '../lib/wire.js'

const repo = fileURLToPath(new URL('..', import.meta.url))
const fixture = JSON.parse(readFileSync(join(repo, 'test/fixtures/wire-payloads.json'), 'utf8'))

// The same config the JS and Python tests use. Duplicated on purpose: a shared
// config file would let one implementation's defaults leak into the other's.
const config = {
  ...fixture.caps,
  exclude: ['secret_*'],
  systemSections: { Personality: '' },
}

const jsOut = {}
for (const [name, payload] of Object.entries(fixture.payloads)) {
  const result = shrinkWirePayload(structuredClone(payload), config)
  jsOut[name] = { payload: result.payload, shape: result.shape, report: result.report }
}

const dir = mkdtempSync(join(tmpdir(), 'toolscode-parity-'))
const jsFile = join(dir, 'js.json')
const pyFile = join(dir, 'py.json')
writeFileSync(jsFile, JSON.stringify(jsOut, null, 2), 'utf8')

const candidates = process.argv[2] ? [process.argv[2]] : ['python', 'python3', 'py']
let ran = null
let result = null
for (const candidate of candidates) {
  const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' })
  if (probe.error) continue
  ran = candidate
  result = spawnSync(candidate, [join(repo, 'tools/parity.py'), pyFile], { encoding: 'utf8' })
  break
}
if (!ran) {
  console.log('toolscode parity: skipped — no Python interpreter found (looked for ' + candidates.join(', ') + ')')
  process.exit(3)
}
if (result.status !== 0) {
  console.error(`toolscode parity: ${ran} tools/parity.py failed with status ${result.status}`)
  console.error(result.stderr || result.stdout)
  process.exit(1)
}

const read = (path) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n').split('\n')
const js = read(jsFile)
const py = read(pyFile)
let diffs = 0
const limit = Math.max(js.length, py.length)
for (let i = 0; i < limit; i++) {
  if (js[i] === py[i]) continue
  if (diffs < 10) console.error(`line ${i + 1}\n  js: ${js[i]}\n  py: ${py[i]}`)
  diffs++
}
if (diffs === 0) {
  console.log(`toolscode parity: js and python agree on ${Object.keys(jsOut).length} payloads, ${limit} lines`)
  process.exit(0)
}
console.error(`toolscode parity: ${diffs} differing line(s) of ${limit}`)
process.exit(1)
