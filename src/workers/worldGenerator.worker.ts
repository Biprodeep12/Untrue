// Generates chunk terrain off the main thread. Results go back as
// transferable buffers, so chunk data is never copied.

import { generateChunk, TerrainFields, type ChunkRequest } from '../generation/TerrainGenerator';

let fields: TerrainFields | null = null;
const port = self as unknown as Worker;

port.onmessage = (e: MessageEvent<ChunkRequest>) => {
  const req = e.data;
  if (fields?.worldSeed !== req.worldSeed) fields = new TerrainFields(req.worldSeed);
  const res = generateChunk(fields, req);
  port.postMessage(res, [res.tiles.buffer, res.decos.buffer]);
};
