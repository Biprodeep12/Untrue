// Main-thread chunk generation for tests and tools.

import { generateChunk, TerrainFields, type ChunkRequest, type ChunkResult } from '../generation/TerrainGenerator';
import type { ChunkGenerator } from './ChunkManager';

export class SyncGenerator implements ChunkGenerator {
  private fields: TerrainFields | null = null;
  private handler: (res: ChunkResult) => void = () => {};

  request(req: ChunkRequest): void {
    if (this.fields?.worldSeed !== req.worldSeed) this.fields = new TerrainFields(req.worldSeed);
    this.handler(generateChunk(this.fields, req));
  }

  onResult(handler: (res: ChunkResult) => void): void {
    this.handler = handler;
  }
}
