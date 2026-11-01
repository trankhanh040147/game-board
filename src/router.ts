import { renderFooter, renderHeader, mountHeader } from './components/ui'
import { initPage } from './components/behavior'
import type { PageView } from './pages/home'
import { view as homeView } from './pages/home'
import { view as makingOfView } from './pages/makingOf'
import { view as exhibitView } from './pages/exhibit'
import { notFoundView, view as aboutView } from './pages/about'

interface Route {
  match: (path: string) => Record<string, string> | null
  view: (params: Record<string, string>) => PageView
}

const routes: Route[] = [
  { match: (path) => (path === '/' ? {} : null), view: () => homeView() },
  { match: (path) => (path === '/making-of' ? {} : null), view: () => makingOfView() },
  {
    match: (path) => {
      const found = path.match(/^\/making-of\/([^/]+)$/)
      return found && found[1] ? { slug: decodeURIComponent(found[1]) } : null
    },
    view: (params) => exhibitView(params),
  },
  { match: (path) => (path === '/about' ? {} : null), view: () => aboutView() },
]

function normalize(pathname: string): string {
  if (pathname.length > 1) return pathname.replace(/\/+$/, '') || '/'
  return pathname
}

function matchRoute(path: string): { page: PageView; params: Record<string, string> } {
  for (const route of routes) {
    const params = route.match(path)
    if (params) return { page: route.view(params), params }
  }
  return { page: notFoundView(), params: {} }
}

const main = document.getElementById('main')
const header = document.getElementById('site-header')
const footer = document.getElementById('site-footer')

function setMeta(page: PageView): void {
  document.title = page.title
  const description = document.querySelector<HTMLMetaElement>('meta[name="description"]')
  if (description) description.content = page.description
  const ogTitle = document.querySelector<HTMLMetaElement>('meta[property="og:title"]')
  if (ogTitle) ogTitle.content = page.title
  const ogDescription = document.querySelector<HTMLMetaElement>('meta[property="og:description"]')
  if (ogDescription) ogDescription.content = page.description
}

function updateHeaderState(path: string): void {
  if (!header) return
  header.querySelectorAll<HTMLAnchorElement>('.site-nav__link').forEach((link) => {
    const href = link.getAttribute('href') ?? ''
    const active = href === '/' ? path === '/' : path === href || path.startsWith(href + '/')
    if (active) link.setAttribute('aria-current', 'page')
    else link.removeAttribute('aria-current')
  })
}

let lastPath = ''

function render(pathname: string, options: { scroll: boolean; hash?: string } = { scroll: true }): void {
  if (!main) return
  const path = normalize(pathname)
  const { page } = matchRoute(path)

  document.body.dataset.game = page.gameSlug ?? ''
  delete document.body.dataset.navOpen
  const mobilePanel = header?.querySelector<HTMLElement>('#mobile-nav')
  if (mobilePanel) mobilePanel.dataset.open = 'false'
  const menuButton = header?.querySelector<HTMLElement>('.menu-button')
  if (menuButton) menuButton.setAttribute('aria-expanded', 'false')

  main.innerHTML = page.html
  setMeta(page)
  updateHeaderState(path)

  page.mount?.(main)
  initPage(main)

  if (options.scroll) {
    if (options.hash) {
      const target = document.getElementById(options.hash.replace(/^#/, ''))
      if (target) {
        target.scrollIntoView({ behavior: 'auto', block: 'start' })
      } else {
        window.scrollTo({ top: 0, left: 0, behavior: 'auto' })
      }
    } else {
      window.scrollTo({ top: 0, left: 0, behavior: 'auto' })
    }
  }

  if (lastPath && lastPath !== path) {
    main.focus({ preventScroll: true })
  }
  lastPath = path
}

function navigate(href: string, options: { replace?: boolean } = {}): void {
  const url = new URL(href, window.location.origin)
  const path = normalize(url.pathname)
  const current = normalize(window.location.pathname)
  const sameDocument = path === current

  if (!options.replace && !sameDocument) {
    window.history.pushState({ path }, '', url.pathname + url.search + url.hash)
  } else if (!options.replace) {
    window.history.replaceState({ path }, '', url.pathname + url.search + url.hash)
  }

  render(path, { scroll: !sameDocument || Boolean(url.hash), hash: url.hash || undefined })
}

function interceptLinks(): void {
  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0) return
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const target = event.target as HTMLElement | null
    const anchor = target?.closest<HTMLAnchorElement>('a[href]')
    if (!anchor) return
    if (anchor.target === '_blank' || anchor.hasAttribute('download')) return
    const href = anchor.getAttribute('href') ?? ''
    if (!href || href.startsWith('mailto:') || href.startsWith('tel:')) return

    const url = new URL(href, window.location.origin)
    if (url.origin !== window.location.origin) return

    // In-page anchors are left to the browser.
    if (url.pathname === normalize(window.location.pathname) && url.hash && !url.search) {
      return
    }
    event.preventDefault()
    navigate(href)
  })
}

export function boot(): void {
  if (header) {
    header.innerHTML = renderHeader(normalize(window.location.pathname))
    mountHeader(header)
  }
  if (footer) footer.innerHTML = renderFooter()

  if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual'

  window.addEventListener('popstate', () => {
    render(normalize(window.location.pathname), {
      scroll: true,
      hash: window.location.hash || undefined,
    })
  })

  interceptLinks()
  render(normalize(window.location.pathname), {
    scroll: true,
    hash: window.location.hash || undefined,
  })
}
