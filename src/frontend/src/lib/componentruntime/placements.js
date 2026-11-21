// A surface's placements as the surface reads them (owner ruling 43, "use as
// my view"): the stored rows, read through the service and turned into the
// entries SurfaceView mounts (placementrows.js holds the pure part).
import { listPlacements } from '../services.js';
import { placedEntries } from './placementrows.js';

// loadPlacements reads one surface's entries.
export async function loadPlacements(surface) {
  return placedEntries(await listPlacements(surface));
}
