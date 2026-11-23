package main

import "testing"

func TestSnapIDsMissing(t *testing.T) {
	cases := []struct {
		prev, cur uint8
		want      int
	}{
		{5, 6, 0},   // consecutive
		{5, 8, 2},   // two lost
		{255, 1, 0}, // wrap skips 0
		{254, 2, 2}, // 255 and 1 lost across the wrap
		{255, 3, 2}, // 1 and 2 lost
		{0, 7, 0},   // unknown previous id
		{9, 9, 0},   // duplicate
	}
	for _, c := range cases {
		if got := snapIDsMissing(c.prev, c.cur); got != c.want {
			t.Errorf("snapIDsMissing(%d, %d) = %d, want %d", c.prev, c.cur, got, c.want)
		}
	}
}
