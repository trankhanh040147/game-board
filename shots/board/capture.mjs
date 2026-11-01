/**
 * Proof shots for the board. Drives the local Chrome with puppeteer-core
 * (borrowed from the game workspaces, no root dependency) and writes
 * 1440x900 and 390x844 screenshots for every route, plus a full-page
 * JPEG per route at 1440 for review.
 *
 *   npm run shots            # against http://127.0.0.1:5200
 *   BASE=… npm run shots
 */
import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const require = createRequire('/Users/vulcanlabs/src/gh/game-board/games/first-hearth/package.json')
const puppeteer = require('puppeteer-core')

const here = path.dirname(fileURLToPath(import.meta.url))
const base = process.env.BASE ?? 'http://127.0.0.1:5200'
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const routes = [
  ['home', '/'],
  ['making-of', '/making-of'],
  ['exhibit-first-hearth', '/making-of/first-hearth'],
  ['exhibit-blade-and-mount', '/making-of/blade-and-mount'],
  ['exhibit-alien-shooter', '/making-of/alien-shooter'],
  ['about', '/about'],
  ['not-found', '/no-such-page'],
]

const viewports = [
  { name: '1440', width: 1440, height: 900 },
  { name: '390', width: 390, height: 844 },
]

await mkdir(here, { recursive: true })

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'],
})

let failures = 0

/** Force the finished state: reveals visible, counters settled, no smooth scroll. */
async function settle(page) {
  await page.evaluate(() => {
    document.documentElement.style.scrollBehavior = 'auto'
    document.querySelectorAll('.reveal').forEach((element) => element.classList.add('is-in'))
  })
  await page.evaluate(async () => {
    const step = window.innerHeight * 0.75
    for (let y = 0; y < document.body.scrollHeight; y += step) {
      window.scrollTo(0, y)
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
    window.scrollTo(0, 0)
  })
  await new Promise((resolve) => setTimeout(resolve, 1300))
}

for (const viewport of viewports) {
  const page = await browser.newPage()
  await page.setCacheEnabled(false)
  await page.setViewport({ width: viewport.width, height: viewport.height, deviceScaleFactor: 1 })
  const errors = []
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`)
  })

  for (const [name, route] of routes) {
    errors.length = 0
    const response = await page.goto(base + route, { waitUntil: 'networkidle0' })
    await page.evaluate(() => document.fonts.ready)
    await settle(page)

    await page.screenshot({ path: path.join(here, `${name}-${viewport.name}.png`) })
    if (viewport.width === 1440) {
      await page.screenshot({
        path: path.join(here, `${name}-${viewport.name}-full.jpg`),
        fullPage: true,
        type: 'jpeg',
        quality: 82,
      })
      await page.evaluate(() => window.scrollTo(0, 0))
    }

    const h1 = await page.evaluate(() => document.querySelector('h1')?.textContent?.trim() ?? '')
    const status = response?.status() ?? 0
    const ok = (status === 200 || status === 304) && !errors.length
    if (!ok) failures += 1
    console.log(
      `${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(24)} ${String(viewport.width).padEnd(5)} ${status}  h1="${h1.slice(0, 44)}"  ${errors.slice(0, 2).join(' | ')}`,
    )
  }
  await page.close()
}

await browser.close()
console.log(failures ? `\n${failures} route/viewport combos failed` : '\nall routes clean, no console errors')
if (failures) process.exitCode = 1
