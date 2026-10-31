import type * as THREE from 'three';
import type { AudioAPI, MusicTrack, SfxName } from '../core/types';

/**
 * TEMPORARY silent audio stub — ui-audio replaces this file with the procedural WebAudio engine.
 */
export const audio: AudioAPI = {
  unlock: () => undefined,
  play: (_name: SfxName) => undefined,
  update: (_camera: THREE.Camera, _dt: number) => undefined,
  setVolumes: () => undefined,
  startMusic: (_track: MusicTrack) => undefined,
  stopMusic: () => undefined,
  setCrowd: () => undefined,
  cheer: () => undefined,
  gong: () => undefined,
  dispose: () => undefined,
};

export function createAudio(): AudioAPI {
  return audio;
}
