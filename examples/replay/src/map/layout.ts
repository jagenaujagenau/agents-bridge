import { hierarchy, pack } from "d3-hierarchy"
import type { MapPosition, MapRegion, ReplayFile, ReplayMap } from "../replay/model.ts"

/**
 * Stable code geography (GOAL §11): regions packed in the repository, files packed
 * in their region, sized by activity. Inputs are sorted and d3's packing is
 * deterministic, so the same session always gets the same coordinates.
 */

interface Datum {
  readonly name: string
  readonly value?: number
  readonly children?: ReadonlyArray<Datum>
}

export const MAP_SIZE = 1000

export const layoutMap = (files: Iterable<ReplayFile>): ReplayMap => {
  const byRegion = new Map<string, Array<ReplayFile>>()
  for (const file of files) {
    const list = byRegion.get(file.region) ?? []
    list.push(file)
    byRegion.set(file.region, list)
  }
  const data: Datum = {
    name: "",
    children: [...byRegion.keys()].sort().map((region) => ({
      name: region,
      children: byRegion.get(region)!
        .sort((a, b) => (a.path < b.path ? -1 : 1))
        .map((file) => ({ name: file.path, value: Math.max(1, file.activity) }))
    }))
  }
  // Few files would otherwise swell to fill the map; pack them into a smaller, centered disc.
  const count = [...byRegion.values()].reduce((n, list) => n + list.length, 0)
  const extent = MAP_SIZE * Math.min(1, Math.max(0.5, Math.sqrt(count / 24)))
  const offset = (MAP_SIZE - extent) / 2
  const root = pack<Datum>()
    .size([extent, extent])
    .padding((node) => (node.depth === 0 ? 18 : 4))(
      hierarchy(data, (d) => d.children as Array<Datum> | undefined)
        .sum((d) => d.value ?? 0)
        .sort((a, b) => (b.value ?? 0) - (a.value ?? 0) || (a.data.name < b.data.name ? -1 : 1))
    )

  const regions: Array<MapRegion> = []
  const nodes = new Map<string, MapPosition>()
  for (const region of root.children ?? []) {
    regions.push({
      id: region.data.name,
      x: region.x + offset,
      y: region.y + offset,
      radius: region.r,
      files: (region.children ?? []).map((f) => f.data.name)
    })
    for (const file of region.children ?? []) nodes.set(file.data.name, { x: file.x + offset, y: file.y + offset, radius: file.r })
  }
  return { size: MAP_SIZE, regions, nodes }
}
