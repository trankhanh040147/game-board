# Sunmeadow Isles — Miniature 3D City Builder

An isometric 3D city builder in the browser: lay roads, watch traffic flow, and grow rooftop
gardens on a small island.

**Prompt:** "Build an isometric 3D city builder with roads, traffic simulation and rooftop gardens."

**Built with:** Seleya — Fabric Coding (a multi-agent run: Claude Code for plans, Antigravity for
builds, designs and reviews). The source in this folder is the generated output as exported from
that session.

## Stack

React 19 · Vite 7 · Three.js · Tailwind CSS 4 · TypeScript

## Layout

```
src/
├── App.tsx            UI shell and HUD
├── main.tsx           entry point
├── index.css          styles
├── seleya-inspector.ts  element picker injected by the Seleya preview (no-op outside an iframe)
└── game/
    ├── renderer.ts    Three.js isometric scene
    ├── roads.ts       road placement and connectivity
    ├── traffic.ts     vehicle simulation
    ├── economy.ts     budget, income and upkeep
    ├── goals.ts       objectives
    ├── events.ts      random city events
    ├── actions.ts     player actions
    ├── state.ts       game state
    └── audio.ts       sound
```

## Run it locally

```bash
pnpm install
pnpm dev        # Vite dev server
pnpm build      # typecheck + production build into dist/
pnpm preview
```

## Honesty notes

- No tests ship with this game, and no telemetry (prompts, tokens, agent time) has been extracted
  for it yet, so it is not part of the board's making-of data.
- Token and time figures shown in the Seleya UI were "tokens unknown"; none are claimed here.
