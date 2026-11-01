import { prefersReducedMotion, qs, qsa } from '../lib/dom'
import { compact, count, workTime } from '../lib/format'

/* ------------------------------------------------------------------
   Reveals — an entrance for the parts of every section, not one fade
   ------------------------------------------------------------------ */

export function initReveal(root: ParentNode): void {
  const items = qsa<HTMLElement>(root, '.reveal')
  if (!items.length) return

  if (prefersReducedMotion() || !('IntersectionObserver' in window)) {
    items.forEach((item) => item.classList.add('is-in'))
    return
  }

  items.forEach((item, index) => {
    if (!item.style.getPropertyValue('--reveal-delay')) {
      item.style.setProperty('--reveal-delay', `${(index % 5) * 65}ms`)
    }
  })

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        entry.target.classList.add('is-in')
        observer.unobserve(entry.target)
      }
    },
    { threshold: 0.08, rootMargin: '0px 0px -6% 0px' },
  )

  items.forEach((item) => observer.observe(item))
}

/* ------------------------------------------------------------------
   Counters — animate once, when their figure first comes into view
   ------------------------------------------------------------------ */

function formatCount(value: number, format: string): string {
  if (format === 'compact') return compact(value)
  if (format === 'hours') return workTime(value)
  if (format === 'work') return workTime(value)
  return count(value)
}

function animateFigure(element: HTMLElement, to: number, format: string): void {
  if (prefersReducedMotion()) {
    element.textContent = formatCount(to, format)
    return
  }
  const durationMs = 950
  const start = performance.now()
  const ease = (t: number): number => 1 - Math.pow(1 - t, 3)
  element.dataset.counting = 'true'
  const tick = (now: number): void => {
    const progress = Math.min(1, (now - start) / durationMs)
    element.textContent = formatCount(to * ease(progress), format)
    if (progress < 1) requestAnimationFrame(tick)
    else {
      element.textContent = formatCount(to, format)
      delete element.dataset.counting
    }
  }
  requestAnimationFrame(tick)
}

export function initCounters(root: ParentNode): void {
  const figures = qsa<HTMLElement>(root, '.count')
  if (!figures.length) return

  if (!('IntersectionObserver' in window)) {
    figures.forEach((element) => {
      const to = Number(element.dataset.to ?? 0)
      element.textContent = formatCount(to, element.dataset.fmt ?? 'int')
    })
    return
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const element = entry.target as HTMLElement
        animateFigure(element, Number(element.dataset.to ?? 0), element.dataset.fmt ?? 'int')
        observer.unobserve(element)
      }
    },
    { threshold: 0.4 },
  )

  figures.forEach((element) => {
    element.textContent = formatCount(0, element.dataset.fmt ?? 'int')
    observer.observe(element)
  })
}

/* ------------------------------------------------------------------
   Cabinets — the signature move: a still that changes while you read
   ------------------------------------------------------------------ */

interface Cabinet {
  root: HTMLElement
  slides: HTMLElement[]
  dots: HTMLElement[]
  caption: HTMLElement | null
  title: HTMLElement | null
  meta: HTMLElement | null
  index: number
  timer: number | null
  cycle: number
}

function readCabinet(cabinetRoot: HTMLElement): Cabinet | null {
  const slides = qsa<HTMLElement>(cabinetRoot, '.cabinet__slide')
  if (slides.length < 2) return null
  return {
    root: cabinetRoot,
    slides,
    dots: qsa<HTMLElement>(cabinetRoot, '[data-dot]'),
    caption: qs<HTMLElement>(cabinetRoot, '[data-cabinet-caption]'),
    title: qs<HTMLElement>(cabinetRoot, '[data-cabinet-title]'),
    meta: qs<HTMLElement>(cabinetRoot, '[data-cabinet-meta]'),
    index: 0,
    timer: null,
    cycle: Number(cabinetRoot.dataset.cycle ?? 0),
  }
}

function setSlide(cabinet: Cabinet, index: number): void {
  const total = cabinet.slides.length
  const next = ((index % total) + total) % total
  cabinet.index = next
  cabinet.slides.forEach((slide, i) => slide.classList.toggle('is-active', i === next))
  cabinet.dots.forEach((dot, i) => dot.setAttribute('aria-pressed', String(i === next)))
  const active = cabinet.slides[next]
  if (!active) return
  if (cabinet.caption) cabinet.caption.textContent = active.dataset.caption ?? ''
  if (cabinet.title) cabinet.title.textContent = active.dataset.title ?? ''
  if (cabinet.meta) cabinet.meta.textContent = active.dataset.meta ?? ''
}

function startCycle(cabinet: Cabinet): void {
  if (cabinet.cycle <= 0 || prefersReducedMotion()) return
  stopCycle(cabinet)
  cabinet.timer = window.setInterval(() => setSlide(cabinet, cabinet.index + 1), cabinet.cycle)
}

function stopCycle(cabinet: Cabinet): void {
  if (cabinet.timer != null) {
    window.clearInterval(cabinet.timer)
    cabinet.timer = null
  }
}

export function initCabinets(root: ParentNode): void {
  const cabinets = qsa<HTMLElement>(root, '[data-cabinet]')
    .map(readCabinet)
    .filter((cabinet): cabinet is Cabinet => Boolean(cabinet))

  for (const cabinet of cabinets) {
    cabinet.dots.forEach((dot, index) => {
      dot.addEventListener('click', () => {
        setSlide(cabinet, index)
        startCycle(cabinet)
      })
    })

    // Pause while someone is reading a slide, resume when they leave.
    cabinet.root.addEventListener('mouseenter', () => stopCycle(cabinet))
    cabinet.root.addEventListener('mouseleave', () => startCycle(cabinet))
    cabinet.root.addEventListener('focusin', () => stopCycle(cabinet))
    cabinet.root.addEventListener('focusout', () => startCycle(cabinet))
    startCycle(cabinet)
  }

  if (!cabinets.length) return

  document.addEventListener('visibilitychange', () => {
    for (const cabinet of cabinets) {
      if (document.hidden) stopCycle(cabinet)
      else startCycle(cabinet)
    }
  })
}

/* ------------------------------------------------------------------
   Exhibit cabinet: the still matches the section you are reading
   ------------------------------------------------------------------ */

export function initShotCabinet(root: ParentNode): void {
  const cabinetRoot = qs<HTMLElement>(root, '[data-shot-cabinet]')
  if (!cabinetRoot) return
  const cabinet = readCabinet(cabinetRoot)
  if (!cabinet) return

  const sections = qsa<HTMLElement>(root, '[data-shot]')
  if (!sections.length || !('IntersectionObserver' in window)) return

  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0]
      if (!visible) return
      const index = Number((visible.target as HTMLElement).dataset.shot ?? 0)
      setSlide(cabinet, index)
    },
    { rootMargin: '-38% 0px -52% 0px', threshold: 0 },
  )

  sections.forEach((section) => observer.observe(section))
}

/* ------------------------------------------------------------------
   Long prompts open in place
   ------------------------------------------------------------------ */

export function initPromptToggles(root: ParentNode): void {
  qsa<HTMLButtonElement>(root, '[data-prompt-toggle]').forEach((button) => {
    button.addEventListener('click', () => {
      const body = button.parentElement?.querySelector<HTMLElement>('[data-prompt-body]')
      if (!body) return
      const expanded = button.getAttribute('aria-expanded') === 'true'
      button.setAttribute('aria-expanded', String(!expanded))
      body.classList.toggle('is-clamped', expanded)
      button.textContent = expanded ? 'Read the full prompt' : 'Collapse the prompt'
    })
  })
}

/** Everything that runs on every page. */
export function initPage(root: ParentNode): void {
  initReveal(root)
  initCounters(root)
  initCabinets(root)
  initShotCabinet(root)
  initPromptToggles(root)
}
