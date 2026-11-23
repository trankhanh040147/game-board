You lead a team that builds "Netcode Lab" in this repository, under games/netcode-lab/.

Goal
A browser multiplayer shooter that 2–10 engineers can play together for 15 fun minutes, where every latency technique from the handoff (prediction, reconciliation, interpolation, lag compensation, the latency budget, tick health, regions, rollback and the rest) is a live toggle a presenter can switch on and off to show the idea working in the running game. Numbers on screen are measured by the game, or clearly labelled est., ref or simulated.

games/netcode-lab/docs/HANDOFF.md holds the domain knowledge (Part A) and a full product proposal (Part B). Read it first. Part A is the source of truth for concepts and numbers. Part B is a strong suggestion, not a contract: the stack, the milestone order and the exact feature list are yours to change when you find a better way. Record each such change and its reason in docs/DECISIONS.md.

Done when
- A teammate on the LAN can join from a browser URL and play a round.
- Each idea in HANDOFF B.6 can be shown live, with steps in docs/DEMO.md.
- The checks that prove it works (HANDOFF B.9 or better ones you choose) have been run, with real outputs in docs/MEASUREMENTS.md.

Team
You build and run the team yourself through the agent-fabric-peer MCP server: how many members, their roles, how work is split and reviewed, and in what order. Use the team tools (team_member_create, team_task_create, team_send, team_wait and the rest) for all member work; do not use peer_fan_out, peer_handoff or peer_ask as a substitute for members. Before anything else, call team_roster: if the agent-fabric-peer server has no team_* tools, stop at once and report that the session is connected to the wrong fabric. Available targets:
- claude: strongest at hard code and design.
- hermes: good at logic, research, tests and review; slow, not for UI or bulk work.
- antigravity: generating art or sound; may be quota-limited (if it fails with RATE_LIMITED, move on without it). Not a reviewer.

Hard rules
- Work only inside games/netcode-lab/. Commit locally as you go. Never push.
- No mock data, no fake measurements, no tests weakened to pass. If something cannot be made to work, say so in docs/BLOCKERS.md with evidence and move on.
- Assets: CC0 only (download first, generate second), each source and licence listed in docs/ASSETS.md. No names, maps or art from existing commercial games.
- Do not ask me anything and do not wait for me. Keep docs/STATUS.md current so you can pick up after a context compaction. Stop when the goal is met or what is left is recorded as blocked.
- You coordinate and verify; members write the files. You may read files and run any command.

Finish with a short report: what works, what was measured, what is blocked, and what a human still has to do (for example a real 4-person playtest).
