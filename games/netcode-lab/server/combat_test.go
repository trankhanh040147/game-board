package server

import (
	"io"
	"log/slog"
	"testing"

	"netcodelab/net/codec"
	"netcodelab/net/cond"
	"netcodelab/sim"
)

func testClient(r *Room, id, team uint8, pos [3]sim.Fx) *Client {
	c := &Client{room: r, id: id, team: team, inbuf: map[uint32]sim.Cmd{}, recvMs: map[uint32]float64{}, alive: true, health: 100, life: 1}
	c.up = cond.NewLink(cond.Params{}, false, 1, func([]byte) {})
	c.down = cond.NewLink(cond.Params{}, false, 2, func([]byte) {})
	c.state = sim.State{Pos: pos, OnGround: true}
	r.clients[id] = c
	return c
}

func lastShot(t *testing.T, c *Client) codec.ShotResult {
	t.Helper()
	for i := len(c.events) - 1; i >= 0; i-- {
		if c.events[i].ev.Type == codec.EvShotResult {
			var sr codec.ShotResult
			sr.Read(&codec.Reader{B: c.events[i].ev.Data})
			return sr
		}
	}
	t.Fatal("no shot result")
	return codec.ShotResult{}
}

// B.9 check 3 (unit part): with a known history, a ray aimed where the target
// was at render time T hits the rewound hitbox and misses the current one.
func TestLagCompRewindHitsWhatTheShooterSaw(t *testing.T) {
	r := NewRoom(slog.New(slog.NewTextHandler(io.Discard, nil)), "x")
	f := sim.FromFloat
	// Shooter at x=0,z=-10 looking along -Z (yaw 0), open ground. Target
	// crosses along +X at z=-20: at tick 100 it is at x=0 (in the line of fire), then
	// moves 0.11 m per tick (7 m/s at 64 Hz).
	shooter := testClient(r, 1, 0, [3]sim.Fx{0, 0, f(-10)})
	target := testClient(r, 2, 1, [3]sim.Fx{0, 0, f(-20)})
	for tick := uint32(100); tick <= 108; tick++ {
		target.state.Pos[0] = f(0.11 * float64(tick-100))
		r.hist.record(tick, float64(tick)*15.625, r.clients, false)
	}
	s := DefaultSettings()
	// Shot at tick 108; the shooter was rendering tick 100 (100 ms + downlink ago).
	shot := fire{cmd: sim.Cmd{Seq: 50, In: sim.Input{Buttons: sim.BtnFire}, RenderTick: 100}, state: shooter.state}

	s.LagComp = false
	r.resolveFire(shooter, shot, 108, 0, s)
	off := lastShot(t, shooter)
	if off.HitID != 0 || off.SeenID != 2 || off.Flags&codec.ShotLagComp != 0 {
		t.Fatalf("lagcomp off: want miss with SeenID=2, got %+v", off)
	}
	if off.MovedCm < 85 || off.MovedCm > 90 { // 8 ticks x 0.11 m
		t.Fatalf("movedCm %d, want ~88", off.MovedCm)
	}
	if target.health != 100 {
		t.Fatal("miss must not damage")
	}

	s.LagComp = true
	shot.cmd.Seq = 60
	r.resolveFire(shooter, shot, 108, 0, s)
	on := lastShot(t, shooter)
	if on.HitID != 2 || on.Flags&codec.ShotLagComp == 0 || on.RewoundTick != 100 || on.Damage == 0 {
		t.Fatalf("lagcomp on: want hit on rewound target, got %+v", on)
	}
	if on.SeenPos != on.UsedPos {
		t.Fatalf("rewound box must equal what the shooter saw: %v vs %v", on.SeenPos, on.UsedPos)
	}

	// History cap: a 1 s-old render time is clamped to the cap (here 50 ms ~ 3 ticks).
	s.HistoryMs = 50
	shot.cmd.Seq = 70
	r.resolveFire(shooter, shot, 108, 0, s)
	capped := lastShot(t, shooter)
	if capped.Flags&codec.ShotClamped == 0 || capped.HitID != 0 {
		t.Fatalf("capped rewind should clamp and miss: %+v", capped)
	}

	// Favour the victim: shooter RTT above the threshold -> no rewind.
	s.HistoryMs, s.FavorVictimRttMs = 1000, 30
	shooter.reportRTT = 80
	shot.cmd.Seq = 80
	r.resolveFire(shooter, shot, 108, 0, s)
	fav := lastShot(t, shooter)
	if fav.Flags&codec.ShotFavoured == 0 || fav.HitID != 0 {
		t.Fatalf("favour victim should skip rewind: %+v", fav)
	}
}

func TestWallBlocksShot(t *testing.T) {
	r := NewRoom(slog.New(slog.NewTextHandler(io.Discard, nil)), "x")
	f := sim.FromFloat
	// Shooter south of the low wall (z 3), target hidden north of it (z -3); wall is 2 m tall.
	shooter := testClient(r, 1, 0, [3]sim.Fx{0, 0, f(3)})
	testClient(r, 2, 1, [3]sim.Fx{0, 0, f(-3)})
	r.hist.record(10, 0, r.clients, false)
	r.resolveFire(shooter, fire{cmd: sim.Cmd{Seq: 1, In: sim.Input{Buttons: sim.BtnFire}, RenderTick: 10}, state: shooter.state}, 10, 0, DefaultSettings())
	sr := lastShot(t, shooter)
	if sr.HitID != 0 || sr.WallDistCm < 250 || sr.WallDistCm > 270 {
		t.Fatalf("wall at 2.6 m must stop the shot: %+v", sr)
	}
}

func TestHeadshotKillsAndRespawns(t *testing.T) {
	r := NewRoom(slog.New(slog.NewTextHandler(io.Discard, nil)), "x")
	f := sim.FromFloat
	shooter := testClient(r, 1, 0, [3]sim.Fx{0, 0, f(-10)})
	target := testClient(r, 2, 1, [3]sim.Fx{0, 0, f(-20)})
	r.hist.record(5, 0, r.clients, false)
	// Aim at the head: eye 1.6 m, head centre ~1.62 m, 10 m away: pitch ~0.
	r.resolveFire(shooter, fire{cmd: sim.Cmd{Seq: 1, In: sim.Input{Buttons: sim.BtnFire}, RenderTick: 5}, state: shooter.state}, 5, 0, DefaultSettings())
	sr := lastShot(t, shooter)
	if sr.Hitbox != sim.HitHead || sr.Damage != DamageHead || sr.Flags&codec.ShotKilled == 0 {
		t.Fatalf("%+v", sr)
	}
	if target.alive || target.deaths != 1 || shooter.kills != 1 || r.teamScore[0] != 1 || len(r.outbox) != 1 {
		t.Fatalf("kill bookkeeping: alive=%v deaths=%d kills=%d score=%v outbox=%d", target.alive, target.deaths, shooter.kills, r.teamScore, len(r.outbox))
	}
	var gotDeath bool
	for _, e := range target.events {
		gotDeath = gotDeath || e.ev.Type == codec.EvDeath
	}
	if !gotDeath {
		t.Fatal("victim needs a death event (P24)")
	}
	life := target.life
	r.respawn(target)
	if !target.alive || target.health != 100 || target.life != life+1 {
		t.Fatal("respawn")
	}
}

func TestClaimsRejectedUnlessTrust(t *testing.T) {
	r := NewRoom(slog.New(slog.NewTextHandler(io.Discard, nil)), "x")
	c := testClient(r, 1, 0, [3]sim.Fx{})
	v := testClient(r, 2, 1, [3]sim.Fx{})
	claim := []codec.Claim{{InputSeq: 1, VictimID: 2, Hitbox: sim.HitHead}}
	r.processClaims(c, claim, 1, DefaultSettings())
	if c.rejectedClaims != 1 || v.health != 100 || len(r.outbox) != 1 {
		t.Fatalf("authoritative mode must reject: rejected=%d hp=%d", c.rejectedClaims, v.health)
	}
	s := DefaultSettings()
	s.Authority = "trust"
	r.processClaims(c, claim, 2, s)
	if v.alive || v.health != 0 {
		t.Fatal("trust mode relays the claimed headshot")
	}
}
