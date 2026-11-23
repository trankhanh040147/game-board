// Package regions is M7's infrastructure demo (A.12, P16–P18): three region
// instances (hcm, hn, sg) of the game Room in one process, simulated routes
// per region × ISP, a cable cut that hurts only routes to sg, relayed routes
// ("public" vs "backbone"), and a datagram ping beacon per region.
//
// Every route number here is a SIMULATED setting of the in-process
// conditioner, not a measurement of any real network (A.16). The values are
// illustrative, chosen from the anecdotal ranges in A.12.
package regions

import (
	"sync"

	"netcodelab/net/cond"
)

var (
	Regions = []string{"hcm", "hn", "sg"}
	ISPs    = []string{"viettel", "vnpt", "fpt"}
	// LastMiles models the player's own link on top of the route (simulated):
	// most players are fine, some sit on congested Wi-Fi, a few are on a bad line.
	LastMiles = []string{"good", "wifi", "bad"}
	Routes    = []string{"direct", "relay-public", "relay-backbone"}
)

// Route is one simulated path, as round-trip figures.
type Route struct {
	RTTMs    float64 `json:"rttMs"`
	JitterMs float64 `json:"jitterMs"`
	LossPct  float64 `json:"lossPct"`
}

func (r Route) add(o Route) Route {
	return Route{r.RTTMs + o.RTTMs, r.JitterMs + o.JitterMs, r.LossPct + o.LossPct}
}

// OneWay splits a round trip evenly into the conditioner's per-direction params.
func (r Route) OneWay() cond.Params {
	return cond.Params{DelayMs: r.RTTMs / 2, JitterMs: r.JitterMs / 2, LossPct: r.LossPct / 2}
}

// base: ISP → region, direct public route (simulated; a player in southern Vietnam).
var base = map[string]map[string]Route{
	"hcm": {"viettel": {8, 1, 0}, "vnpt": {11, 2, 0}, "fpt": {9, 1, 0}},
	"hn":  {"viettel": {30, 2, 0}, "vnpt": {36, 4, 0.2}, "fpt": {32, 3, 0}},
	"sg":  {"viettel": {38, 4, 0.2}, "vnpt": {55, 8, 0.5}, "fpt": {45, 6, 0.3}},
}

var lastMile = map[string]Route{"good": {}, "wifi": {6, 20, 0.5}, "bad": {60, 30, 3}}

// CableCut is what a subsea cable incident adds to routes leaving the country
// (only sg here). Simulated.
var CableCut = Route{RTTMs: 80, JitterMs: 25, LossPct: 3}

// Relayed routes (P18): the player enters a relay PoP close by. "public" then
// crosses public ISP hops (more jitter and loss); "backbone" rides a private
// network (little of either). Applied instead of the direct route's jitter/loss. Simulated.
var relay = map[string]Route{
	"relay-public":   {RTTMs: 6, JitterMs: 14, LossPct: 1.5},
	"relay-backbone": {RTTMs: 2, JitterMs: 1, LossPct: 0},
}

// State is the live, shared infrastructure state (cable cut on or off).
type State struct {
	mu  sync.Mutex
	cut bool
	gen uint64 // bumps on every change, so live links re-apply their route
}

func (s *State) Cut() bool { s.mu.Lock(); defer s.mu.Unlock(); return s.cut }

func (s *State) SetCut(on bool) {
	s.mu.Lock()
	if s.cut != on {
		s.cut = on
		s.gen++
	}
	s.mu.Unlock()
}

// RouteFor returns the simulated round-trip route for one player.
func (s *State) RouteFor(region, isp, lm, route string) Route {
	r, ok := base[region][isp]
	if !ok {
		r = base["hcm"]["viettel"]
	}
	if rr, ok := relay[route]; ok {
		r = Route{RTTMs: r.RTTMs + rr.RTTMs, JitterMs: rr.JitterMs, LossPct: rr.LossPct}
	}
	if region == "sg" && s.Cut() {
		c := CableCut
		if route == "relay-backbone" {
			// A private backbone has its own capacity: it reroutes (more delay) but keeps jitter and loss low.
			c = Route{RTTMs: CableCut.RTTMs / 2, JitterMs: 2, LossPct: 0}
		}
		r = r.add(c)
	}
	return r.add(lastMile[lm])
}

// Table is the full route matrix for the UI and /api/regions.
func (s *State) Table() map[string]any {
	t := map[string]any{}
	for _, rg := range Regions {
		m := map[string]any{}
		for _, isp := range ISPs {
			rs := map[string]Route{}
			for _, ro := range Routes {
				rs[ro] = s.RouteFor(rg, isp, "good", ro)
			}
			m[isp] = rs
		}
		t[rg] = m
	}
	return map[string]any{"regions": Regions, "isps": ISPs, "lastMiles": LastMiles, "routes": Routes, "table": t,
		"lastMile": lastMile, "cableCut": s.Cut(), "cableCutAdds": CableCut, "label": "simulated"}
}

func valid(v string, set []string, def string) string {
	for _, x := range set {
		if x == v {
			return v
		}
	}
	return def
}
