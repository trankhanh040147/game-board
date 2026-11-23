export interface MapBox { id: string; min: [number, number, number]; max: [number, number, number] }
export interface CourtyardMap {
  name: string;
  boxes: MapBox[];
  spawns: { blue: [number, number, number][]; orange: [number, number, number][] };
}

const found = import.meta.glob<CourtyardMap>("../../../shared/map.json", { eager: true, import: "default" });
export const courtyard: CourtyardMap | null = Object.values(found)[0] ?? null;
