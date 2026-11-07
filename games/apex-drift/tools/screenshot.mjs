#!/usr/bin/env node
/**
 * Headless-Chrome verification harness for Apex Drift.
 *
 *   node tools/screenshot.mjs
 *   node tools/screenshot.mjs --url http://127.0.0.1:8090/ --out tools/shots
 *   node tools/screenshot.mjs --no-serve          # use an already running server
 *
 * What it does:
 *   1. starts tools/serve.mjs on port 8090 (unless --no-serve / a custom URL),
 *   2. launches a throwaway headless Chrome with SwiftShader WebGL2,
 *   3. attaches over the Chrome DevTools Protocol using Node's global WebSocket,
 *   4. collects console errors / uncaught exceptions / log errors,
 *   5. walks the shell: title -> garage -> countdown -> race -> camera modes ->
 *      pause/resume -> hold W and prove the car moves,
 *   6. writes dummy-free PNG evidence into tools/shots/ and a run-summary.json,
 *   7. exits non-zero on any failure (missing screenshots, WebGL unavailable,
 *      console error, ready timeout, car did not move).
 *
 * Zero dependencies: Node >= 22 (global fetch + WebSocket) and Chrome.
 */

import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/* ------------------------------------------------------------- options -- */

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_URL = 'http://127.0.0.1:8090/';
const CHROME_PATH =
  process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function parseArgs(argv) {
  const options = {
    url: DEFAULT_URL,
    out: join(ROOT, 'tools', 'shots'),
    serve: true,
    readyTimeoutMs: 25_000,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--url') options.url = argv[++i];
    else if (arg === '--out') options.out = resolve(argv[++i]);
    else if (arg === '--no-serve') options.serve = false;
    else if (arg === '--serve') options.serve = true;
    else if (arg === '--ready-timeout') options.readyTimeoutMs = Number(argv[++i]);
    else if (arg === '--verbose') options.verbose = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(
        [
          'Usage: node tools/screenshot.mjs [options]',
          '  --url <url>          page to verify (default http://127.0.0.1:8090/)',
          '  --out <dir>          screenshot directory (default tools/shots)',
          '  --no-serve           do not spawn tools/serve.mjs',
          '  --ready-timeout <ms> __apexDebug.ready timeout (default 25000)',
          '  --verbose            echo Chrome/CDP detail',
        ].join('\n'),
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));

/* ---------------------------------------------------------- small utils -- */

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function getFreePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

async function fetchOk(url, timeoutMs = 1500) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok ? response : null;
  } catch {
    return null;
  }
}

async function looksLikeApexPage(response) {
  try {
    const text = (await response.text()).slice(0, 20_000);
    return /Apex Drift/i.test(text) || /src\/app\/main\.js/.test(text);
  } catch {
    return false;
  }
}

async function waitForHttp(url, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    const response = await fetchOk(url);
    if (response) return response;
    lastError = url;
    await sleep(100);
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${label} (${lastError ?? url})`);
}

/** Try IPv4 then IPv6 loopback; Chrome may bind only one. */
async function waitForDevtools(port, timeoutMs) {
  const hosts = ['127.0.0.1', '[::1]'];
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    for (const host of hosts) {
      const base = `http://${host}:${port}`;
      try {
        const version = await (await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(800) })).json();
        return { base, version };
      } catch (error) {
        lastError = error;
      }
    }
    await sleep(120);
  }
  throw new Error(`Chrome DevTools endpoint on :${port} never became ready (${lastError?.message ?? 'no response'})`);
}

/* ------------------------------------------------------------- CDP glue -- */

class CdpSession {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    socket.addEventListener('message', (event) => this.#dispatch(event.data));
    socket.addEventListener('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('CDP socket closed'));
      this.pending.clear();
    });
  }

  static async connect(wsUrl, timeoutMs = 10_000) {
    const socket = new WebSocket(wsUrl);
    await new Promise((resolveOpen, rejectOpen) => {
      const timer = setTimeout(() => rejectOpen(new Error('timed out opening the CDP WebSocket')), timeoutMs);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolveOpen();
      }, { once: true });
      socket.addEventListener('error', (event) => {
        clearTimeout(timer);
        rejectOpen(new Error(`CDP WebSocket error: ${event?.message ?? 'socket error'}`));
      }, { once: true });
    });
    return new CdpSession(socket);
  }

  #dispatch(data) {
    let message;
    try {
      message = JSON.parse(typeof data === 'string' ? data : String(data));
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message}`));
      else entry.resolve(message.result ?? {});
      return;
    }
    const handlers = this.listeners.get(message.method);
    if (!handlers) return;
    for (const handler of [...handlers]) {
      try {
        handler(message.params ?? {});
      } catch (error) {
        if (options.verbose) console.error(`[cdp] ${message.method} handler failed:`, error.message);
      }
    }
  }

  send(method, params = {}, timeoutMs = 20_000) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolveSend, rejectSend) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectSend(new Error(`${method}: CDP call timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveSend, reject: rejectSend, method, timer });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        rejectSend(error);
      }
    });
  }

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(handler);
    return () => this.listeners.get(method)?.delete(handler);
  }

  once(method, timeoutMs, label = method) {
    return new Promise((resolveOnce, rejectOnce) => {
      let off = null;
      const timer = setTimeout(() => {
        off?.();
        rejectOnce(new Error(`timed out after ${timeoutMs} ms waiting for ${label}`));
      }, timeoutMs);
      off = this.on(method, (params) => {
        clearTimeout(timer);
        off?.();
        resolveOnce(params);
      });
    });
  }

  close() {
    try {
      this.socket.close();
    } catch {
      /* already closed */
    }
  }
}

/* ------------------------------------------------------------ run state -- */

const checks = [];
const screenshots = [];
const consoleProblems = [];

function record(name, ok, detail) {
  checks.push({ name, ok, detail: detail ?? null });
  const suffix = detail ? ` — ${detail}` : '';
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${suffix}`);
  return ok;
}

async function step(name, fn) {
  try {
    const detail = await fn();
    return record(name, true, detail);
  } catch (error) {
    return record(name, false, error.message);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/* ---------------------------------------------------------------- chrome -- */

function launchChrome({ port, profileDir, url }) {
  const args = [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    '--disable-gpu',
    '--enable-unsafe-swiftshader',
    '--use-angle=swiftshader',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profileDir}`,
    '--window-size=1280,800',
    '--hide-scrollbars',
    '--mute-audio',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    'about:blank',
  ];
  const child = spawn(CHROME_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  child.on('error', (error) => {
    stderr += `\nspawn error: ${error.message}`;
  });
  return {
    child,
    get stderr() {
      return stderr;
    },
    stop() {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    },
  };
}

/* ------------------------------------------------------------------ main -- */

async function main() {
  console.log('Apex Drift — headless verification');
  console.log(`  page: ${options.url}`);
  console.log(`  shots: ${options.out}`);

  await mkdir(options.out, { recursive: true });

  let server = null;
  let chrome = null;
  let session = null;
  let profileDir = null;
  let fatal = null;
  let stats = null;
  let pageUrl = options.url;

  try {
    /* -------------------------------------------------------------- server -- */
    {
      const requested = new URL(pageUrl);
      const localHost = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(requested.hostname);
      const existing = await fetchOk(pageUrl);
      if (existing && (await looksLikeApexPage(existing))) {
        record('static server serving Apex Drift', true, pageUrl);
      } else if (!options.serve) {
        throw new Error(
          `${existing ? `the server at ${pageUrl} does not serve Apex Drift` : `no server reachable at ${pageUrl}`} and --no-serve was passed`,
        );
      } else if (!localHost) {
        throw new Error(`${pageUrl} is not serving Apex Drift and the harness only starts local servers`);
      } else {
        if (existing) {
          record('target port occupied by another app', true, `${requested.port || 'default port'}; starting an isolated server`);
        }
        const port = await getFreePort();
        pageUrl = `${requested.protocol}//${requested.hostname}:${port}${requested.pathname}${requested.search}`;
        server = spawn(process.execPath, [join(ROOT, 'tools', 'serve.mjs')], {
          cwd: ROOT,
          env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let serverError = '';
        server.stderr.on('data', (chunk) => {
          serverError += chunk.toString();
        });
        try {
          await waitForHttp(pageUrl, 15_000, 'tools/serve.mjs');
          record('static server started', true, pageUrl);
        } catch (error) {
          throw new Error(`${error.message}${serverError ? ` (${serverError.trim()})` : ''}`);
        }
      }
      console.log(`  serving: ${pageUrl}`);
    }

    /* -------------------------------------------------------------- chrome -- */
    const chromePort = await getFreePort();
    profileDir = join(tmpdir(), `apex-drift-chrome-${process.pid}-${Date.now()}`);
    chrome = launchChrome({ port: chromePort, profileDir, url: pageUrl });
    await step('headless Chrome launched', async () => {
      const { base, version } = await waitForDevtools(chromePort, 15_000);
      assert(version?.Browser, 'DevTools /json/version did not report a browser');
      return version.Browser;
    });

    /* ---------------------------------------------------------------- target -- */
    const { base } = await waitForDevtools(chromePort, 5_000);
    const targetResponse = await fetch(`${base}/json/new?about:blank`, { method: 'PUT' });
    assert(targetResponse.ok, `could not open a DevTools target (HTTP ${targetResponse.status})`);
    const target = await targetResponse.json();
    assert(target.webSocketDebuggerUrl, 'the DevTools target has no webSocketDebuggerUrl');

    session = await CdpSession.connect(target.webSocketDebuggerUrl);
    session.on('Runtime.consoleAPICalled', (params) => {
      if (params.type !== 'error') return;
      const text = (params.args ?? [])
        .map((arg) => arg.value ?? arg.description ?? arg.type ?? '')
        .join(' ');
      consoleProblems.push({ source: 'console.error', text });
    });
    session.on('Runtime.exceptionThrown', (params) => {
      const details = params.exceptionDetails ?? {};
      const description = details.exception?.description ?? details.text ?? 'uncaught exception';
      consoleProblems.push({ source: 'exception', text: description });
    });
    session.on('Log.entryAdded', (params) => {
      const entry = params.entry ?? {};
      if (entry.level !== 'error') return;
      consoleProblems.push({
        source: `log:${entry.source ?? 'unknown'}`,
        text: entry.text ?? '',
        url: entry.url ?? null,
      });
    });

    await session.send('Runtime.enable');
    await session.send('Log.enable');
    await session.send('Page.enable');
    await session.send('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });

    const evaluate = async (expression, timeoutMs = 10_000) => {
      const result = await session.send(
        'Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: true, userGesture: true },
        timeoutMs,
      );
      if (result.exceptionDetails) {
        const details = result.exceptionDetails;
        throw new Error(details.exception?.description ?? details.text ?? 'evaluation threw');
      }
      return result.result?.value;
    };

    const waitFor = async (expression, predicate, timeoutMs, label) => {
      const deadline = Date.now() + timeoutMs;
      let lastValue;
      let lastError = null;
      while (Date.now() < deadline) {
        try {
          lastValue = await evaluate(expression, 3000);
          if (predicate(lastValue)) return lastValue;
        } catch (error) {
          lastError = error;
        }
        await sleep(100);
      }
      throw new Error(
        `timed out after ${timeoutMs} ms waiting for ${label} (last value: ${JSON.stringify(lastValue)}${
          lastError ? `, last error: ${lastError.message}` : ''
        })`,
      );
    };

    const screenshot = async (name) => {
      const { data } = await session.send('Page.captureScreenshot', { format: 'png' });
      assert(data, `Page.captureScreenshot returned no data for ${name}`);
      const file = join(options.out, name);
      const buffer = Buffer.from(data, 'base64');
      await writeFile(file, buffer);
      assert(buffer.length > 2_000, `${name} is only ${buffer.length} bytes (probably blank)`);
      screenshots.push({ name, file, bytes: buffer.length });
      return buffer.length;
    };

    const key = async ({ key: keyName, code, windowsVirtualKeyCode }) => {
      const base = { key: keyName, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode };
      await session.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
      await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      await sleep(60);
    };

    const press = async (name) => {
      const keys = {
        Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
        Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
        KeyC: { key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67 },
        KeyW: { key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87 },
      };
      const descriptor = keys[name];
      assert(descriptor, `unknown key ${name}`);
      await key(descriptor);
    };

    /* --------------------------------------------------------------- load -- */
    const loaded = session.once('Page.loadEventFired', 20_000, 'Page.loadEventFired');
    await session.send('Page.navigate', { url: pageUrl });
    await loaded.catch(() => {});

    const booted = await step('page boots to a usable title screen', async () => {
      const ready = await waitFor(
        'Boolean(window.__apexDebug && window.__apexDebug.ready)',
        (value) => value === true,
        options.readyTimeoutMs,
        'window.__apexDebug.ready',
      );
      assert(ready === true, '__apexDebug.ready never became true');
      const mode = await waitFor(
        'window.__apexDebug.mode',
        (value) => value === 'title',
        10_000,
        'title mode',
      );
      return `mode=${mode}`;
    });
    if (!booted) {
      const diagnostic = await evaluate(`(() => ({
        title: document.title,
        lockup: (document.querySelector('.title-lockup')?.innerText ?? '').slice(0, 240),
        hasDebugHook: Boolean(window.__apexDebug),
        scripts: [...document.scripts].map((script) => script.src || 'inline'),
      }))()`).catch((error) => ({ diagnosticError: error.message }));
      throw new Error(`page never booted; aborting interaction checks (${JSON.stringify(diagnostic)})`);
    }

    await step('WebGL2 context is live', async () => {
      const info = await evaluate(`(() => {
        const canvas = document.getElementById('view');
        const gl = canvas && (canvas.getContext('webgl2') || null);
        return {
          hasCanvas: Boolean(canvas),
          webgl2: Boolean(gl),
          rendererOk: Boolean(window.__apexDebug?.app?.renderer?.ok),
          error: window.__apexDebug?.app?.renderer?.error ?? null,
        };
      })()`);
      assert(info.hasCanvas, '#view canvas is missing');
      assert(info.webgl2, 'WebGL2 context is unavailable in headless Chrome');
      assert(info.rendererOk, `renderer reported not ok: ${info.error ?? 'unknown error'}`);
      const version = await evaluate('window.__apexDebug.app.renderer.gl.getParameter(window.__apexDebug.app.renderer.gl.VERSION)');
      return String(version);
    });

    /* -------------------------------------------------------------- title -- */
    await step('01 title screen', async () => {
      const bytes = await screenshot('01-title.png');
      const mode = await evaluate('window.__apexDebug.mode');
      assert(mode === 'title', `expected title mode, got ${mode}`);
      return `${bytes} bytes`;
    });

    /* ------------------------------------------------------------- garage -- */
    await step('02 garage screen', async () => {
      await press('Enter');
      await waitFor('window.__apexDebug.mode', (value) => value === 'garage', 8_000, 'garage mode');
      await sleep(250);
      const cards = await evaluate(`({
        cars: document.querySelectorAll('#car-list .car-card').length,
        tracks: document.querySelectorAll('#track-list .track-card').length,
        visible: !document.getElementById('screen-garage').classList.contains('is-hidden'),
      })`);
      assert(cards.visible, 'garage screen is still hidden');
      assert(cards.cars === 3, `expected 3 car cards, got ${cards.cars}`);
      assert(cards.tracks === 2, `expected 2 track cards, got ${cards.tracks}`);
      const bytes = await screenshot('02-garage.png');
      return `${cards.cars} cars, ${cards.tracks} tracks, ${bytes} bytes`;
    });

    /* ---------------------------------------------------------- countdown -- */
    await step('03 countdown', async () => {
      await press('Enter');
      await waitFor(
        `Boolean(window.__apexDebug?.app?.race)`,
        (value) => value === true,
        30_000,
        'race to be created',
      );
      await waitFor(
        'window.__apexDebug.mode',
        (value) => value === 'racing',
        30_000,
        'racing mode',
      );
      await sleep(1_000);
      const state = await evaluate(`(() => {
        const race = window.__apexDebug.app.race;
        return { state: race.state, countdown: race.countdown, cars: race.cars.length };
      })()`);
      assert(state.cars === 6, `expected a 6-car grid, got ${state.cars}`);
      assert(
        state.state === 'countdown' || state.state === 'running',
        `race should be counting down or running, got ${state.state}`,
      );
      const bytes = await screenshot('03-countdown.png');
      return `state=${state.state} countdown=${Number(state.countdown).toFixed(2)} ${bytes} bytes`;
    });

    /* --------------------------------------------------------------- race -- */
    await step('04 race in progress', async () => {
      await sleep(6_000);
      const snapshot = await evaluate(`(() => {
        const race = window.__apexDebug.app.race;
        return {
          state: race.state,
          time: race.time,
          laps: race.laps,
          standings: race.standings.length,
          speed: Math.abs(race.player.speed),
          x: race.player.x,
          z: race.player.z,
          triangles: window.__apexDebug.app.renderer.stats.triangles,
          drawCalls: window.__apexDebug.app.renderer.stats.drawCalls,
        };
      })()`);
      assert(snapshot.state === 'running', `race state should be running, got ${snapshot.state}`);
      assert(snapshot.standings === 6, `expected 6 standings rows, got ${snapshot.standings}`);
      assert(snapshot.triangles > 0, 'renderer drew zero triangles');
      assert(snapshot.drawCalls > 0, 'renderer issued zero draw calls');
      const bytes = await screenshot('04-race.png');
      return `${snapshot.triangles} tris / ${snapshot.drawCalls} draws, ${snapshot.speed.toFixed(1)} m/s, ${bytes} bytes`;
    });

    /* ------------------------------------------------------------- cameras -- */
    const setCameraMode = async (wanted) => {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const mode = await evaluate('window.__apexDebug.app.camera.mode');
        if (mode === wanted) return mode;
        await press('KeyC');
        await sleep(200);
      }
      const mode = await evaluate('window.__apexDebug.app.camera.mode');
      throw new Error(`could not switch the camera to '${wanted}' (stuck at '${mode}')`);
    };

    await step('05 camera: wide', async () => {
      await setCameraMode('far');
      await sleep(500);
      const bytes = await screenshot('05-camera-wide.png');
      return `mode=far, ${bytes} bytes`;
    });

    await step('06 camera: hood', async () => {
      await setCameraMode('hood');
      await sleep(500);
      const bytes = await screenshot('06-camera-hood.png');
      return `mode=hood, ${bytes} bytes`;
    });

    /* -------------------------------------------------------- pause/resume -- */
    await step('07 pause and resume', async () => {
      await press('Escape');
      const pausedMode = await waitFor(
        'window.__apexDebug.mode',
        (value) => value === 'paused',
        5_000,
        'paused mode',
      );
      const visible = await evaluate(
        `!document.getElementById('screen-pause').classList.contains('is-hidden')`,
      );
      assert(visible, 'pause screen did not become visible');
      const bytes = await screenshot('07-pause.png');

      await press('Escape');
      await waitFor('window.__apexDebug.mode', (value) => value === 'racing', 5_000, 'resumed racing mode');
      const hidden = await evaluate(
        `document.getElementById('screen-pause').classList.contains('is-hidden')`,
      );
      assert(hidden, 'pause screen did not hide after resuming');
      await sleep(400);
      return `paused=${pausedMode}, ${bytes} bytes`;
    });

    /* --------------------------------------------------------------- stats -- */
    await step('debug stats evaluate', async () => {
      stats = await evaluate(`(() => {
        const s = window.__apexDebug.stats();
        return { ...s, camera: window.__apexDebug.app.camera.mode, mode: window.__apexDebug.mode };
      })()`);
      assert(stats && typeof stats === 'object', 'stats() returned nothing');
      assert(stats.triangles > 0, `stats.triangles is ${stats.triangles}`);
      return JSON.stringify(stats);
    });

    /* ------------------------------------------------------------- driving -- */
    await step('08 car moves under throttle', async () => {
      const before = await evaluate(`(() => {
        const race = window.__apexDebug.app.race;
        return { x: race.player.x, z: race.player.z, speed: race.player.speed, time: race.time };
      })()`);

      const keyDown = {
        type: 'keyDown',
        key: 'w',
        code: 'KeyW',
        windowsVirtualKeyCode: 87,
        nativeVirtualKeyCode: 87,
      };
      const keyUp = { ...keyDown, type: 'keyUp' };
      await session.send('Input.dispatchKeyEvent', keyDown);
      try {
        await sleep(3_200);
        const bytes = await screenshot('08-driving.png');
        const during = await evaluate(`(() => {
          const race = window.__apexDebug.app.race;
          return {
            speed: race.player.speed,
            throttle: race.player.throttle,
            x: race.player.x,
            z: race.player.z,
            hudWidth: document.getElementById('hud').width,
            hudHeight: document.getElementById('hud').height,
            hasHud: Boolean(window.__apexDebug.app.hud),
          };
        })()`);
        const moved = Math.hypot(during.x - before.x, during.z - before.z);
        assert(
          moved >= 5,
          `car moved only ${moved.toFixed(2)} m in 3.2 s of full throttle (speed ${during.speed.toFixed(2)} m/s)`,
        );
        assert(during.speed > 1, `car speed ${during.speed.toFixed(2)} m/s is not increasing`);
        assert(during.hasHud, 'HUD instance is missing');
        assert(during.hudWidth > 0 && during.hudHeight > 0, 'HUD canvas has no backing store');
        return `moved ${moved.toFixed(1)} m, speed ${during.speed.toFixed(1)} m/s, HUD ${during.hudWidth}x${during.hudHeight}, ${bytes} bytes`;
      } finally {
        await session.send('Input.dispatchKeyEvent', keyUp).catch(() => {});
      }
    });

    /* ------------------------------------------------------------- console -- */
    await step('no console errors or uncaught exceptions', async () => {
      const problems = consoleProblems.filter((problem) => problem.text && problem.text.trim());
      if (problems.length > 0) {
        throw new Error(
          `${problems.length} error(s): ${problems
            .slice(0, 5)
            .map((problem) => `[${problem.source}] ${problem.text.split('\n')[0]}`)
            .join(' | ')}`,
        );
      }
      return 'clean';
    });
  } catch (error) {
    fatal = error;
    record('run aborted', false, error.message);
  } finally {
    if (session) {
      await session.send('Browser.close', {}, 2000).catch(() => {});
      session.close();
    }
    if (chrome) chrome.stop();
    if (server) {
      try {
        server.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }
    if (profileDir) {
      await sleep(120);
      await rm(profileDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /* ------------------------------------------------------------- summary -- */

  const expectedShots = [
    '01-title.png',
    '02-garage.png',
    '03-countdown.png',
    '04-race.png',
    '05-camera-wide.png',
    '06-camera-hood.png',
    '07-pause.png',
    '08-driving.png',
  ];
  const missingShots = expectedShots.filter((name) => !screenshots.some((shot) => shot.name === name));
  if (missingShots.length > 0) {
    record('all 8 screenshots written', false, `missing: ${missingShots.join(', ')}`);
  } else {
    record('all 8 screenshots written', true, `${screenshots.length} files in ${options.out}`);
  }

  const failed = checks.filter((check) => !check.ok);
  const summary = {
    url: pageUrl,
    outDir: options.out,
    ok: failed.length === 0 && !fatal,
    checks,
    screenshots,
    consoleProblems,
    stats,
  };
  await writeFile(join(options.out, 'run-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);

  console.log('');
  console.log(`Shots: ${screenshots.length}/${expectedShots.length} in ${options.out}`);
  if (stats) console.log(`Stats: ${JSON.stringify(stats)}`);
  if (consoleProblems.length > 0) {
    console.log(`Console errors: ${consoleProblems.length}`);
    for (const problem of consoleProblems.slice(0, 8)) {
      console.log(`  [${problem.source}] ${problem.text.split('\n').slice(0, 2).join(' ')}`);
    }
  }
  console.log(
    `Result: ${failed.length === 0 ? 'PASS' : `FAIL (${failed.length} failed check${failed.length === 1 ? '' : 's'})`}`,
  );
  console.log(`Summary: ${join(options.out, 'run-summary.json')}`);

  await sleep(50);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(`screenshot harness crashed: ${error?.stack ?? error}`);
  process.exit(1);
});
