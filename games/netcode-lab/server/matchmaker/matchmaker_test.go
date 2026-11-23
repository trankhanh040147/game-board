package matchmaker

import (
	"testing"
	"time"
)

func TestRelaxation(t *testing.T) {
	m := New(DefaultConfig())
	now := time.Unix(0, 0)
	m.now = func() time.Time { return now }
	// Bad last mile: every region above 60 ms, hcm under 100.
	st := m.Submit(Ticket{Player: "p", ISP: "vnpt", RTT: map[string]float64{"hcm": 72, "hn": 98, "sg": 120, "tokyo": 40}})
	if st.State != "searching" || st.MaxMs != 60 || len(st.Ignored) != 1 {
		t.Fatalf("at 0 s: %+v", st)
	}
	now = now.Add(9 * time.Second)
	if st, _ = m.Get(st.ID); st.State != "searching" {
		t.Fatalf("at 9 s: %+v", st)
	}
	now = now.Add(1500 * time.Millisecond)
	st, _ = m.Get(st.ID)
	if st.State != "matched" || st.Region != "hcm" || st.MaxMs != 100 {
		t.Fatalf("at 10.5 s: %+v", st)
	}
}

func TestImmediateAndTimeout(t *testing.T) {
	m := New(DefaultConfig())
	now := time.Unix(0, 0)
	m.now = func() time.Time { return now }
	if st := m.Submit(Ticket{RTT: map[string]float64{"hcm": 9, "sg": 40}}); st.Region != "hcm" {
		t.Fatalf("want hcm now: %+v", st)
	}
	st := m.Submit(Ticket{RTT: map[string]float64{"sg": 180}})
	now = now.Add(61 * time.Second)
	if st, _ = m.Get(st.ID); st.State != "failed" {
		t.Fatalf("want failed: %+v", st)
	}
}
