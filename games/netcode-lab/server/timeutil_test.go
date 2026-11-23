package server

import (
	"runtime"
	"time"
)

func runtimeGosched() { runtime.Gosched() }

func timeAfter(ms int) <-chan time.Time { return time.After(time.Duration(ms) * time.Millisecond) }
