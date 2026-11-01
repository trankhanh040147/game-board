/**
 * Toasts + the notification log drawer.
 *
 * Toasts react to `app.toast()` (the `notification` event). The log reads
 * `state.notifications`; read state is tracked locally so the UI never mutates
 * simulation state (an app-level markRead API is on the gap list).
 */
import type { Notification } from '../sim/types';
import { dateLabel } from '../sim/core';
import { icon } from './icons';
import { esc, fmtInt, pct, stateOf, tipText, type Services } from './util';

const TOAST_TTL = 5200;
const MAX_TOASTS = 3;

export class ToastHost {
  readonly root: HTMLElement;
  private toasts: { el: HTMLElement; timer: number; text: string }[] = [];

  constructor(private readonly svc: Services) {
    this.root = document.createElement('div');
    this.root.className = 'fh-toasts';
    this.root.setAttribute('aria-live', 'polite');
    this.root.setAttribute('aria-atomic', 'false');
    this.root.addEventListener('click', (ev) => {
      const target = ev.target instanceof Element ? ev.target.closest('[data-dismiss]') : null;
      if (!target) return;
      const toast = target.closest('.fh-toast');
      if (toast) this.dismiss(toast as HTMLElement);
    });
  }

  destroy(): void {
    for (const toast of this.toasts) window.clearTimeout(toast.timer);
    this.toasts = [];
  }

  push(text: string, severity: Notification['severity'] = 'info', iconName = 'bell'): void {
    if (!text) return;
    if (this.toasts.some((t) => t.text === text)) return;
    const el = document.createElement('div');
    el.className = `fh-toast is-${severity}`;
    el.setAttribute('role', severity === 'bad' || severity === 'warn' ? 'alert' : 'status');
    el.innerHTML = `
      <span class="fh-toast-icon">${icon(iconName, 'fh-icon is-small')}</span>
      <span class="fh-toast-text">${esc(text)}</span>
      <button type="button" class="fh-toast-close clickable" data-dismiss aria-label="Dismiss notice">${icon('close', 'fh-icon is-tiny')}</button>
    `;
    this.root.prepend(el);
    const entry = { el, text, timer: window.setTimeout(() => this.dismiss(el), TOAST_TTL) };
    this.toasts.unshift(entry);
    while (this.toasts.length > MAX_TOASTS) {
      const old = this.toasts.pop();
      if (old) this.dismiss(old.el);
    }
  }

  private dismiss(el: HTMLElement): void {
    const idx = this.toasts.findIndex((t) => t.el === el);
    if (idx >= 0) {
      window.clearTimeout(this.toasts[idx].timer);
      this.toasts.splice(idx, 1);
    }
    if (!el.isConnected) return;
    el.classList.add('is-leaving');
    window.setTimeout(() => el.remove(), 220);
  }
}

export class NotificationLog {
  readonly root: HTMLElement;
  private listHost!: HTMLElement;
  private headHost!: HTMLElement;
  private filter: 'all' | 'unread' | 'warn' = 'all';
  private readIds = new Set<number>();
  private open = false;

  constructor(private readonly svc: Services) {
    this.root = document.createElement('div');
    this.root.className = 'fh-drawer fh-notif-drawer';
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-modal', 'false');
    this.root.setAttribute('aria-label', 'Notification log');
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="fh-drawer-head">
        <div class="fh-panel-titles"><span class="fh-eyebrow">The record</span><h2 class="display">Notices</h2></div>
        <div class="fh-head-actions">
          <button type="button" class="fh-btn is-ghost clickable" data-act="mark-read">Mark all read</button>
          <button type="button" class="fh-iconbtn clickable" data-act="close" aria-label="Close notices">${icon('close', 'fh-icon')}</button>
        </div>
      </div>
      <div class="fh-drawer-filters" role="tablist">
        <button type="button" role="tab" class="fh-itab clickable is-active" data-filter="all">All</button>
        <button type="button" role="tab" class="fh-itab clickable" data-filter="unread">Unread</button>
        <button type="button" role="tab" class="fh-itab clickable" data-filter="warn">Warnings</button>
      </div>
      <div class="fh-drawer-body" data-js="list"></div>
      <div class="fh-drawer-foot" data-js="foot"></div>
    `;
    this.listHost = this.root.querySelector('[data-js="list"]') as HTMLElement;
    this.headHost = this.root.querySelector('[data-js="foot"]') as HTMLElement;
    this.root.addEventListener('click', this.onClick);
  }

  destroy(): void {
    this.root.removeEventListener('click', this.onClick);
  }

  isOpen(): boolean {
    return this.open;
  }

  toggle(): void {
    this.open ? this.close() : this.show();
  }

  show(): void {
    this.open = true;
    this.root.hidden = false;
    this.root.classList.add('is-open');
    this.render();
    this.root.querySelector<HTMLElement>('[data-act="close"]')?.focus();
  }

  close(): void {
    this.open = false;
    this.root.classList.remove('is-open');
    this.root.hidden = true;
  }

  private unread(s: ReturnType<typeof stateOf>): number {
    let n = 0;
    for (const note of s.notifications) if (!note.read && !this.readIds.has(note.id)) n++;
    return n;
  }

  markAllRead(): void {
    for (const note of stateOf(this.svc).notifications) this.readIds.add(note.id);
    this.render();
    this.svc.refreshSoon();
  }

  refresh(): void {
    if (!this.open) return;
    this.render();
  }

  private render(): void {
    const s = stateOf(this.svc);
    const unread = this.unread(s);
    const all = [...s.notifications].reverse();
    const filtered = all.filter((note) => {
      if (this.filter === 'unread') return !note.read && !this.readIds.has(note.id);
      if (this.filter === 'warn') return note.severity === 'warn' || note.severity === 'bad';
      return true;
    });
    const shown = filtered.slice(0, 120);
    for (const btn of this.root.querySelectorAll<HTMLElement>('[data-filter]')) {
      btn.classList.toggle('is-active', btn.dataset.filter === this.filter);
    }
    this.listHost.innerHTML = shown.length
      ? shown
          .map((note) => {
            const isUnread = !note.read && !this.readIds.has(note.id);
            return `<button type="button" class="fh-note ${isUnread ? 'is-unread' : ''} is-${note.severity} clickable" data-note="${note.id}" ${tipText(`${dateLabel(note.tick)} · ${note.severity}`)}>
              <span class="fh-note-icon">${icon(note.icon || severityIcon(note.severity), 'fh-icon is-small')}</span>
              <span class="fh-note-body"><span class="fh-note-text">${esc(note.text)}</span><span class="fh-note-meta">${esc(dateLabel(note.tick))}</span></span>
              ${isUnread ? '<span class="fh-note-dot" aria-label="unread"></span>' : ''}
            </button>`;
          })
          .join('')
      : `<div class="fh-empty"><p class="fh-empty-title">Nothing here</p><p class="fh-empty-body">The record is empty for this filter.</p></div>`;
    this.headHost.innerHTML = `<span>${fmtInt(shown.length)} shown · ${fmtInt(unread)} unread</span><span class="fh-faint">${pct((s.exploration.mapReveal ?? 0), 0)} of the valley charted</span>`;
    if (unread === 0) this.root.querySelector('[data-act="mark-read"]')?.setAttribute('hidden', '');
    else this.root.querySelector('[data-act="mark-read"]')?.removeAttribute('hidden');
  }

  private onClick = (ev: MouseEvent): void => {
    const target = ev.target instanceof Element ? ev.target : null;
    if (!target) return;
    const filter = target.closest<HTMLElement>('[data-filter]');
    if (filter) {
      this.filter = (filter.dataset.filter as 'all' | 'unread' | 'warn') ?? 'all';
      this.render();
      return;
    }
    const note = target.closest<HTMLElement>('[data-note]');
    if (note) {
      const id = Number(note.dataset.note);
      if (Number.isFinite(id)) {
        this.readIds.add(id);
        note.classList.remove('is-unread');
        note.querySelector('.fh-note-dot')?.remove();
        this.render();
        this.svc.refreshSoon();
      }
      return;
    }
    const act = target.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'close') this.close();
    else if (act === 'mark-read') this.markAllRead();
  };
}

function severityIcon(severity: Notification['severity']): string {
  switch (severity) {
    case 'bad':
      return 'skull';
    case 'warn':
      return 'warning';
    case 'good':
      return 'check';
    case 'discovery':
      return 'eye';
    case 'milestone':
      return 'star';
    default:
      return 'bell';
  }
}
