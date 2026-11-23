// Package shared holds data read by both the native and the WASM sim builds.
package shared

import _ "embed"

//go:embed map.json
var MapJSON []byte
