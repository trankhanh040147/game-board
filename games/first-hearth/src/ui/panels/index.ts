import type { Services } from '../util';
import type { PanelHost } from './host';
import { AlmanacPanel } from './almanac';
import { CodexPanel } from './codex';
import { DiplomacyPanel } from './diplomacy';
import { ExpeditionsPanel } from './expeditions';
import { MarketPanel } from './market';
import { ObjectivesPanel } from './objectives';
import { PeoplePanel } from './people';
import { SocietyPanel } from './society';
import { WondersPanel } from './wonders';

export { PanelHost } from './host';
export type { GamePanel } from './host';

/** Register every panel with the host. */
export function createPanels(svc: Services, host: PanelHost): void {
  host.register(new CodexPanel(svc));
  host.register(new SocietyPanel(svc));
  host.register(new MarketPanel(svc));
  host.register(new PeoplePanel(svc));
  host.register(new AlmanacPanel(svc));
  host.register(new DiplomacyPanel(svc));
  host.register(new ExpeditionsPanel(svc));
  host.register(new WondersPanel(svc));
  host.register(new ObjectivesPanel(svc));
}
