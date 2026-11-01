/**
 * Decision pacing & deadlock guards (Lead triage round 2).
 *
 * The decisions director is the most player-facing system in the game: it must
 * never stack modals, never interrupt the player more often than the era-based
 * gap allows, and never present a decision that cannot be resolved.
 */
import { describe, expect, it } from 'vitest';
import { RULES } from '../src/sim/config';
import { tick } from '../src/sim/tick';
import { resolveDecision } from '../src/sim/actions';
import { applyDecisionChoice } from '../src/sim/systems/civ/events';
import { capitalOf } from '../src/sim/core';
import { makeContent, newGame } from './helpers';
import type { ActionContext } from '../src/sim/actions';
import type { GameState, PendingDecision } from '../src/sim/types';

const content = makeContent();

function ctx(state: GameState): ActionContext {
  return { state, content, rules: RULES };
}

/** Play 300 days, resolving every decision the moment it appears via "Let it pass". */
function runPacedYear(state: GameState, days: number): {
  decisionTicks: number[];
  maxPending: number;
  unaffordableOpened: string[];
} {
  const a = ctx(state);
  const decisionTicks: number[] = [];
  const unaffordableOpened: string[] = [];
  let maxPending = 0;
  for (let i = 0; i < days; i++) {
    tick(state, content, RULES);
    maxPending = Math.max(maxPending, state.events.pending.length);
    while (state.events.pending.length > 0) {
      const decision = state.events.pending[0];
      const cap = capitalOf(state);
      const allUnaffordable =
        decision.choices.length > 0 && !!cap && decision.choices.every((ch) => ch.cost && Object.keys(ch.cost).length > 0 && !canAffordAll(cap, ch.cost));
      if (allUnaffordable) unaffordableOpened.push(`${decision.eventId}@${state.tick}`);
      decisionTicks.push(state.tick);
      const res = resolveDecision(a, decision.id, '__none');
      if (!res.ok) throw new Error(`decision ${decision.eventId} could not be resolved: ${res.message}`);
      if (state.events.pending.some((d) => d.id === decision.id)) throw new Error('pending decision was not removed');
    }
  }
  return { decisionTicks, maxPending, unaffordableOpened };
}

function canAffordAll(cap: ReturnType<typeof capitalOf>, cost: Record<string, number>): boolean {
  if (!cap) return true;
  for (const res in cost) {
    const have = (cap.stock as Record<string, number>)[res] ?? 0;
    if (have + 1e-6 < (cost[res] ?? 0)) return false;
  }
  return true;
}

function fabricateDecision(state: GameState, withChoices = true): PendingDecision {
  const decision: PendingDecision = {
    id: state.events.nextDecisionId++,
    eventId: 'wanderer_arrives',
    title: 'A test decision',
    text: 'A test decision that must never soft-lock.',
    choices: withChoices
      ? [
          { id: 'costly_a', label: 'Impossible A', tooltip: 'Costs far too much meat.', effects: [], cost: { meat: 9999 } },
          { id: 'costly_b', label: 'Impossible B', tooltip: 'Costs far too many tools.', effects: [], cost: { tools: 9999 } },
        ]
      : [],
    createdTick: state.tick,
    severity: 2,
    category: 'migration',
    icon: 'people',
    causes: ['testing'],
  };
  state.events.pending.push(decision);
  return decision;
}

describe('decisions: pacing (Lead target: <=1 pending, gaps >= 20 days over 300)', () => {
  it('never stacks modals and spaces player-facing decisions by >= 20 game days', () => {
    const state = newGame('decisions-cadence');
    // Make all decisions resolvable so the test measures the director, not the wallet.
    const cap = capitalOf(state)!;
    for (const res of Object.keys(content.resources)) cap.stock[res] = 500;
    cap.treasury = 5000;

    const { decisionTicks, maxPending, unaffordableOpened } = runPacedYear(state, 300);
    const gaps = decisionTicks.slice(1).map((t, i) => t - decisionTicks[i]);

    expect(maxPending, `pending decisions stacked (max ${maxPending})`).toBeLessThanOrEqual(1);
    expect(unaffordableOpened, 'unresolvable decisions were opened with no affordable choice').toEqual([]);

    const tooClose = gaps
      .map((gap, i) => ({ gap, from: decisionTicks[i], to: decisionTicks[i + 1] }))
      .filter((x) => x.gap < 20);
    expect(
      tooClose,
      `player-facing decisions arrived closer than 20 days: ${tooClose
        .map((x) => `${x.from}->${x.to} (${x.gap}d)`)
        .join(', ')}; all decision ticks: ${decisionTicks.join(',')}`,
    ).toEqual([]);

    // Sanity: the director still produces a reasonable number of decisions.
    expect(decisionTicks.length, 'no decisions at all in 300 days').toBeGreaterThanOrEqual(2);
    expect(decisionTicks.length, `too many decisions in 300 days: ${decisionTicks.join(',')}`).toBeLessThanOrEqual(10);
  });

  it('every decision history entry for a passed decision records __none', () => {
    const state = newGame('decisions-history');
    const { decisionTicks } = runPacedYear(state, 120);
    expect(decisionTicks.length).toBeGreaterThan(0);
    const passed = state.events.history.filter((h) => h.choiceId === '__none');
    expect(passed.length).toBeGreaterThanOrEqual(decisionTicks.length);
    expect(passed.every((h) => typeof h.tick === 'number')).toBe(true);
  });
});

describe('decisions: no unresolvable soft-locks', () => {
  it('a decision whose every choice is unaffordable resolves via __none', () => {
    const state = newGame('decisions-unaffordable');
    const cap = capitalOf(state)!;
    // Zero the wallet: every choice costs meat/tools 9999.
    for (const res of Object.keys(cap.stock)) cap.stock[res] = 0;
    const decision = fabricateDecision(state);

    // Normal choices must fail cleanly (not crash, not remove the decision).
    const fail = resolveDecision(ctx(state), decision.id, 'costly_a');
    expect(fail.ok).toBe(false);
    expect(fail.message ?? '').toMatch(/Missing|need/i);
    expect(state.events.pending.some((d) => d.id === decision.id), 'failed choice consumed the decision').toBe(true);

    // "Let it pass" must always work, remove the pending decision and add history.
    const pass = resolveDecision(ctx(state), decision.id, '__none');
    expect(pass.ok, `__none failed: ${pass.message}`).toBe(true);
    expect(state.events.pending.some((d) => d.id === decision.id)).toBe(false);
    const last = state.events.history[state.events.history.length - 1];
    expect(last.eventId).toBe(decision.eventId);
    expect(last.choiceId).toBe('__none');
  });

  it('a decision with no choices at all can still be cleared via __none', () => {
    const state = newGame('decisions-empty');
    const decision = fabricateDecision(state, false);
    const res = resolveDecision(ctx(state), decision.id, '__none');
    expect(res.ok).toBe(true);
    expect(state.events.pending.length).toBe(0);
  });

  it('applyDecisionChoice("__none") removes pending + records history; unknown ids fail', () => {
    const state = newGame('decisions-apply');
    const decision = fabricateDecision(state);
    const before = state.events.history.length;
    const res = applyDecisionChoice(state, content, RULES, decision, '__none');
    expect(res.ok).toBe(true);
    expect(state.events.pending.some((d) => d.id === decision.id)).toBe(false);
    expect(state.events.history.length).toBe(before + 1);
    expect(state.events.history[state.events.history.length - 1].choiceId).toBe('__none');

    const bogus = applyDecisionChoice(state, content, RULES, decision, 'not-a-choice');
    expect(bogus.ok).toBe(false);
  });

  it('resolving a decision the player cannot afford never throws', () => {
    const state = newGame('decisions-throw');
    const cap = capitalOf(state)!;
    for (const res of Object.keys(cap.stock)) cap.stock[res] = 0;
    const decision = fabricateDecision(state);
    let threw: unknown = null;
    try {
      for (const choiceId of ['costly_a', 'costly_b', '__none', 'nope']) resolveDecision(ctx(state), decision.id, choiceId);
    } catch (e) {
      threw = e;
    }
    expect(threw, `resolving decisions threw: ${String(threw)}`).toBeNull();
    expect(state.events.pending.length).toBe(0);
  });
});
