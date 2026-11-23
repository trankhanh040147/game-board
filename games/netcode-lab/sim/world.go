package sim

import (
	"encoding/json"
	"fmt"

	"netcodelab/shared"
)

// Box is an axis-aligned box in Q16.16 metres. Y is up.
type Box struct {
	Min, Max [3]Fx
}

// Map is the static level geometry.
type Map struct {
	Name   string
	Boxes  []Box
	Spawns map[string][][3]Fx
}

type mapFile struct {
	Name  string `json:"name"`
	Boxes []struct {
		ID  string     `json:"id"`
		Min [3]float64 `json:"min"`
		Max [3]float64 `json:"max"`
	} `json:"boxes"`
	Spawns map[string][][3]float64 `json:"spawns"`
}

// ParseMap reads map JSON (shared/map.json format).
func ParseMap(data []byte) (*Map, error) {
	var f mapFile
	if err := json.Unmarshal(data, &f); err != nil {
		return nil, fmt.Errorf("map: %w", err)
	}
	m := &Map{Name: f.Name, Spawns: map[string][][3]Fx{}}
	for _, b := range f.Boxes {
		var box Box
		for i := 0; i < 3; i++ {
			box.Min[i], box.Max[i] = FromFloat(b.Min[i]), FromFloat(b.Max[i])
			if box.Min[i] >= box.Max[i] {
				return nil, fmt.Errorf("map: box %q is empty on axis %d", b.ID, i)
			}
		}
		m.Boxes = append(m.Boxes, box)
	}
	for team, pts := range f.Spawns {
		for _, p := range pts {
			m.Spawns[team] = append(m.Spawns[team], [3]Fx{FromFloat(p[0]), FromFloat(p[1]), FromFloat(p[2])})
		}
	}
	return m, nil
}

// Courtyard returns the embedded shared/map.json.
func Courtyard() *Map {
	m, err := ParseMap(shared.MapJSON)
	if err != nil {
		panic(err)
	}
	return m
}

// Spawn returns spawn point i (wrapping) for a team.
func (m *Map) Spawn(team string, i int) [3]Fx {
	pts := m.Spawns[team]
	if len(pts) == 0 {
		return [3]Fx{0, 0, 0}
	}
	if i < 0 {
		i = -i
	}
	return pts[i%len(pts)]
}
