import '@fontsource/cinzel/400.css';
import '@fontsource/cinzel/600.css';
import '@fontsource/cormorant-garamond/400.css';
import '@fontsource/cormorant-garamond/500.css';
import '@fontsource/cormorant-garamond/600.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import './styles/base.css';
import './styles/ui.css';
import { GameApp } from './app';

declare global {
  interface Window {
    __game?: GameApp;
    __FIRST_HEARTH__?: { ready: boolean; errors: string[] };
  }
}

const canvas = document.getElementById('world') as HTMLCanvasElement | null;
const uiRoot = document.getElementById('ui-root') as HTMLElement | null;
if (!canvas || !uiRoot) {
  throw new Error('Missing #world canvas or #ui-root container');
}

const app = new GameApp(canvas, uiRoot);
window.__game = app;
window.__FIRST_HEARTH__ = { ready: false, errors: [] };

app
  .init()
  .then(() => {
    window.__FIRST_HEARTH__ = { ready: true, errors: [] };
    const boot = document.getElementById('boot-screen');
    if (boot) boot.classList.add('boot-hidden');
    setTimeout(() => boot?.remove(), 900);
  })
  .catch((err) => {
    console.error('[boot] failed', err);
    window.__FIRST_HEARTH__ = { ready: false, errors: [String(err?.message ?? err)] };
    const boot = document.getElementById('boot-screen');
    if (boot) {
      boot.innerHTML = `<div class="boot-error"><h1>The hearth would not light</h1><p>${String(err?.message ?? err)}</p></div>`;
    }
  });
