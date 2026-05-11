export interface MinecraftPoint {
  x: number;
  z: number;
}

export interface LeafletPoint {
  lat: number;
  lng: number;
}

export interface ChunkPosition {
  chunkX: number;
  chunkZ: number;
  localX: number;
  localZ: number;
}

const CHUNK_SIZE = 16;

export function minecraftToLeaflet(x: number, z: number): [number, number] {
  return [-z, x];
}

export function leafletToMinecraft(lat: number, lng: number): MinecraftPoint {
  return {
    x: normalizeZero(Math.floor(lng)),
    z: normalizeZero(Math.floor(-lat)),
  };
}

export function floorDiv(value: number, divisor: number): number {
  return normalizeZero(Math.floor(value / divisor));
}

export function localBlockCoord(block: number, chunk: number): number {
  return block - chunk * CHUNK_SIZE;
}

export function blockToChunk(x: number, z: number): ChunkPosition {
  const chunkX = floorDiv(x, CHUNK_SIZE);
  const chunkZ = floorDiv(z, CHUNK_SIZE);
  return {
    chunkX,
    chunkZ,
    localX: localBlockCoord(x, chunkX),
    localZ: localBlockCoord(z, chunkZ),
  };
}

export function blockColumnIndex(localX: number, localZ: number): number {
  return localZ * CHUNK_SIZE + localX;
}

function normalizeZero(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}
