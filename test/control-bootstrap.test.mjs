import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURE_TOKEN = 'persistent-login-fixture'

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-bootstrap-')))
  for (const directory of ['scripts', 'packages/pi-agents/src', 'apps/control-plane/src']) {
    fs.cpSync(path.join(ROOT, directory), path.join(root, directory), { recursive: true })
  }
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(root, 'node_modules'), 'dir')
  fs.mkdirSync(path.join(root, 'config'))
  fs.mkdirSync(path.join(root, 'apps/web/dist'), { recursive: true })
  fs.writeFileSync(path.join(root, 'apps/web/dist/index.html'), '<!doctype html><title>Local fixture</title>')
  const tokenFile = path.join(root, 'config/control-plane.token')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return { root, tokenFile }
}

function start(t, root, { script } = {}) {
  const args = script ? ['--input-type=module', '-e', script] : [path.join(root, 'scripts/tyche-control-plane.mjs'), '--port', '0']
  // Deliberately start outside the fixture project with no inherited secrets.
  const child = spawn(process.execPath, args, { cwd: os.tmpdir(), env: { PATH: path.dirname(process.execPath) }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  let settleReady
  let rejectReady
  const ready = new Promise((resolve, reject) => { settleReady = resolve; rejectReady = reject })
  const closed = new Promise((resolve) => child.once('close', (code) => {
    rejectReady(new Error(`Control-plane child exited ${code}: ${stderr}`))
    resolve({ code, stdout, stderr })
  }))
  child.once('error', rejectReady)
  child.stdout.on('data', (chunk) => {
    stdout += chunk
    if (stdout.includes('\n')) {
      try { settleReady(JSON.parse(stdout.split('\n')[0])) } catch (error) { rejectReady(error) }
    }
  })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const timeout = setTimeout(() => { child.kill('SIGKILL'); rejectReady(new Error('Control-plane fixture startup timed out')) }, 10_000)
  ready.then(() => clearTimeout(timeout), () => clearTimeout(timeout))
  const stop = async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); return closed }
  t.after(stop)
  return { ready, closed, stop }
}

async function request(info, route, { body, cookie, csrf } = {}) {
  const response = await fetch(`http://${info.host}:${info.port}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Origin: `http://${info.host}:${info.port}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
  return { status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0], json: await response.json() }
}

test('full child reads the fixed project token across process restarts and retains random one-use fallback', async (t) => {
  const { root, tokenFile } = fixture(t)
  fs.writeFileSync(tokenFile, `${FIXTURE_TOKEN}\n`, { mode: 0o600 })
  const sessions = []
  for (let index = 0; index < 2; index += 1) {
    const child = start(t, root)
    const info = await child.ready
    assert.equal(info.bootstrap_token, FIXTURE_TOKEN)
    assert.equal((await request(info, '/api/session', { body: { bootstrap_token: 'wrong-fixture' } })).status, 401)
    for (let login = 0; login < 2; login += 1) {
      const session = await request(info, '/api/session', { body: { bootstrap_token: FIXTURE_TOKEN } })
      assert.equal(session.status, 200)
      sessions.push(session.cookie, session.json.csrf_token)
      assert.equal((await request(info, '/api/logout', { body: {}, cookie: session.cookie, csrf: session.json.csrf_token })).status, 200)
    }
    const result = await child.stop()
    assert.equal(result.code, 0)
    assert.equal(result.stderr, '')
  }
  assert.equal(new Set(sessions).size, sessions.length)
  assert.equal(fs.readFileSync(tokenFile, 'utf8'), `${FIXTURE_TOKEN}\n`)
  fs.unlinkSync(tokenFile)
  const randomTokens = []
  for (let index = 0; index < 2; index += 1) {
    const child = start(t, root)
    const info = await child.ready
    assert.match(info.bootstrap_token, /^[A-Za-z0-9_-]{43}$/)
    randomTokens.push(info.bootstrap_token)
    assert.equal((await request(info, '/api/session', { body: { bootstrap_token: info.bootstrap_token } })).status, 200)
    assert.equal((await request(info, '/api/session', { body: { bootstrap_token: info.bootstrap_token } })).status, 401)
    await child.stop()
  }
  assert.notEqual(randomTokens[0], randomTokens[1])
  assert.equal(fs.existsSync(path.join(root, 'data')), false)
  assert.deepEqual(fs.readdirSync(path.join(root, 'config')), [])
})

test('full child rejects unsafe token files and never silently falls back or prints bad contents', async (t) => {
  const { root, tokenFile } = fixture(t)
  for (const contents of ['', 'short', 'fixture token', 'fixture-token\n\n', 'x'.repeat(259), Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), '\ufefffixture-token']) {
    fs.writeFileSync(tokenFile, contents, { mode: 0o600 })
    const child = start(t, root)
    await assert.rejects(child.ready, /CONTROL_CHILD_BOOTSTRAP_FILE_INVALID/)
    const result = await child.closed
    assert.equal(result.code, 1)
    assert.equal(result.stdout, '')
    fs.unlinkSync(tokenFile)
  }
  for (const kind of ['public', 'directory', 'symlink', 'broken-symlink', 'parent-symlink']) {
    if (kind === 'public') fs.writeFileSync(tokenFile, FIXTURE_TOKEN, { mode: 0o644 })
    if (kind === 'directory') fs.mkdirSync(tokenFile)
    if (kind === 'symlink' || kind === 'broken-symlink') {
      const target = path.join(root, 'other-token')
      if (kind === 'symlink') fs.writeFileSync(target, FIXTURE_TOKEN, { mode: 0o600 })
      fs.symlinkSync(target, tokenFile)
    }
    if (kind === 'parent-symlink') {
      fs.renameSync(path.join(root, 'config'), path.join(root, 'real-config'))
      fs.symlinkSync(path.join(root, 'real-config'), path.join(root, 'config'), 'dir')
    }
    const child = start(t, root)
    await assert.rejects(child.ready, kind === 'parent-symlink' ? /CLUSTER_RUNTIME_PATH_SYMLINK/ : /CONTROL_CHILD_BOOTSTRAP_FILE_INVALID/)
    const result = await child.closed
    assert.equal(result.code, 1)
    assert.equal(result.stdout, '')
    assert.ok(!result.stderr.includes(FIXTURE_TOKEN))
    if (kind !== 'parent-symlink') fs.rmSync(tokenFile, { recursive: true, force: true })
    fs.rmSync(path.join(root, 'other-token'), { force: true })
  }
})

test('full child validates explicit reusable selection and gives it precedence over the local file', async (t) => {
  const { root, tokenFile } = fixture(t)
  fs.writeFileSync(tokenFile, 'other-file-fixture', { mode: 0o600 })
  const moduleUrl = pathToFileURL(path.join(root, 'scripts/tyche-control-plane.mjs')).href
  const script = `import { startControlPlaneChild } from ${JSON.stringify(moduleUrl)}; await startControlPlaneChild({ port: 0, bootstrapToken: ${JSON.stringify(FIXTURE_TOKEN)}, reusableBootstrapToken: true });`
  const child = start(t, root, { script })
  const info = await child.ready
  for (let index = 0; index < 2; index += 1) assert.equal((await request(info, '/api/session', { body: { bootstrap_token: FIXTURE_TOKEN } })).status, 200)
  await child.stop()
  for (const options of [{ reusableBootstrapToken: true }, { bootstrapToken: FIXTURE_TOKEN, reusableBootstrapToken: 'true' }]) {
    const invalid = start(t, root, { script: `import { startControlPlaneChild } from ${JSON.stringify(moduleUrl)}; await startControlPlaneChild({ port: 0, ...${JSON.stringify(options)} });` })
    await assert.rejects(invalid.ready, /CONTROL_BOOTSTRAP_REUSE_INVALID/)
    assert.equal((await invalid.closed).stdout, '')
  }
})
