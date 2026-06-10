#!/usr/bin/env node
// app/scripts/stage-deploy.mjs
// Stages a deployable bundle of the gotrends-agent app under .deploy/gotrends-agent/.
// - Vite-builds the client
// - Copies worker source with @/ path alias rewritten to relative imports
// - Writes a minimal runtime-only package.json
// Run from repo root: `node app/scripts/stage-deploy.mjs`
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, rmSync, cpSync } from 'node:fs'
import { resolve, dirname, relative, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const APP_DIR = resolve(__dirname, '..')        // /home/pedrorocha/gotrends2/app
const REPO_ROOT = resolve(APP_DIR, '..')        // /home/pedrorocha/gotrends2
const DEPLOY_DIR = resolve(REPO_ROOT, '.deploy/gotrends-agent')

console.log(`[stage] App: ${APP_DIR}`)
console.log(`[stage] Deploy target: ${DEPLOY_DIR}`)

// 1. Build client
console.log('[stage] Running vite build...')
execSync('./node_modules/.bin/vite build', { cwd: APP_DIR, stdio: 'inherit' })

// 2. Wipe + create deploy dir
rmSync(DEPLOY_DIR, { recursive: true, force: true })
mkdirSync(DEPLOY_DIR, { recursive: true })

// 3. Copy dist/client/* to deploy root
const distClient = resolve(APP_DIR, 'dist/client')
console.log(`[stage] Copying dist/client → .deploy root`)
cpSync(distClient, DEPLOY_DIR, { recursive: true })

// 4. Copy src/ with @/ rewrite
const srcDir = resolve(APP_DIR, 'src')
const dstSrcDir = resolve(DEPLOY_DIR, 'src')

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.(ts|tsx|mts|cts|js|mjs|cjs|md)$/.test(entry)) out.push(full)
  }
  return out
}

const PATH_ALIAS_RE = /(['"`])@\/((?:[a-zA-Z0-9_.\-/]+))(\1)/g

function rewriteAtImports(absSrcFile, content) {
  // Convert "@/foo/bar" inside string literals to a relative path from the file's location
  // to <deploy>/src/foo/bar.
  const relFromSrc = relative(dirname(absSrcFile), srcDir)
  // After we COPY the file to dstSrcDir, the relative target needs to match. Since we mirror
  // the directory structure exactly inside .deploy/src/, the relative path is computable here.
  return content.replace(PATH_ALIAS_RE, (m, q, sub) => {
    // sub may NOT have a leading slash; ensure we don't accidentally produce '//'
    const target = relFromSrc === '' ? `./${sub}` : `${relFromSrc}/${sub}`
    // normalise (e.g., "./foo" stays "./foo"; "core/types" becomes "./core/types")
    const normalized = target.startsWith('.') ? target : `./${target}`
    return `${q}${normalized}${q}`
  })
}

let rewrittenCount = 0
for (const file of walk(srcDir)) {
  const rel = relative(srcDir, file)
  const dst = join(dstSrcDir, rel)
  mkdirSync(dirname(dst), { recursive: true })
  let content = readFileSync(file, 'utf8')
  if (PATH_ALIAS_RE.test(content)) {
    content = rewriteAtImports(file, content)
    rewrittenCount++
    PATH_ALIAS_RE.lastIndex = 0  // reset regex state
  }
  writeFileSync(dst, content)
}
console.log(`[stage] Worker source copied, ${rewrittenCount} files had @/ aliases rewritten`)

// 5. Minimal package.json
writeFileSync(
  resolve(DEPLOY_DIR, 'package.json'),
  JSON.stringify({
    name: 'gotrends-agent',
    private: true,
    type: 'module',
    dependencies: {
      hono: '^4.6.0',
      zod: '^4.4.3',
    },
  }, null, 2) + '\n',
)

// 6. Final report
function dirSize(d) {
  let n = 0, b = 0
  for (const e of readdirSync(d)) {
    const f = join(d, e)
    if (statSync(f).isDirectory()) { const r = dirSize(f); n += r.n; b += r.b }
    else { n++; b += statSync(f).size }
  }
  return { n, b }
}
const total = dirSize(DEPLOY_DIR)
console.log(`[stage] Done. ${total.n} files, ${(total.b / 1024).toFixed(1)} KB total`)
console.log(`[stage] Asset hashes:`)
for (const f of readdirSync(resolve(DEPLOY_DIR, 'assets'))) {
  console.log(`  assets/${f}`)
}
console.log(`[stage] Next: upload .deploy/gotrends-agent/ via Godeploy getUploadToken + curl, then createApp/updateApp.`)
