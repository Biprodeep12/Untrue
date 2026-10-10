// Draws a building's interior: tiles, furniture, residents and the player,
// in their own y-sorted room view.

import { Container, Graphics, Rectangle, Sprite, Texture } from 'pixi.js';
import { TILE_SIZE } from '../config';
import { hash3 } from '../generation/Random';
import type { Npc } from '../entities/NPC';
import type { Interior } from '../world/Interior';
import { decoFrame, Dir, playerCell, tileCell, TILE_VARIANTS } from './Atlas';
import type { Light } from './Lighting';
import { GLOWING } from './TileRenderer';

export class InteriorRenderer {
  readonly view = new Container();
  /** What the player is about to mine, and how far along it is. */
  readonly marker = new Graphics();
  private readonly floor = new Container();
  private readonly things = new Container({ sortableChildren: true });
  private readonly textures = new Map<string, Texture>();
  private readonly people = new Map<Npc, Sprite>();
  private interior: Interior | null = null;
  private furniture: Sprite[] = [];

  constructor(private readonly atlas: Texture) {
    this.view.addChild(this.floor, this.things, this.marker);
    this.view.visible = false;
  }

  open(interior: Interior, player: Container): void {
    this.interior = interior;
    this.floor.removeChildren().forEach((c) => c.destroy());
    for (let y = 0; y < interior.h; y++) {
      for (let x = 0; x < interior.w; x++) {
        const s = new Sprite(this.tile(interior.tiles[y * interior.w + x], hash3(x, y, 31) % TILE_VARIANTS));
        s.position.set(x * TILE_SIZE, y * TILE_SIZE);
        this.floor.addChild(s);
      }
    }
    this.drawFurniture();
    this.things.addChild(player);
    this.view.visible = true;
  }

  /** Redraws the furniture, e.g. after a chest was opened. */
  drawFurniture(): void {
    const room = this.interior;
    if (!room) return;
    for (const s of this.furniture) s.destroy();
    this.furniture = [];
    for (let y = 0; y < room.h; y++) {
      for (let x = 0; x < room.w; x++) {
        const deco = room.tileAt(x, y)!.deco;
        if (!deco) continue;
        const s = new Sprite({ texture: this.deco(deco), anchor: { x: 0.5, y: 1 } });
        s.position.set((x + 0.5) * TILE_SIZE, (y + 1) * TILE_SIZE);
        s.zIndex = (y + 1) * TILE_SIZE;
        this.things.addChild(s);
        this.furniture.push(s);
      }
    }
  }

  /** Hands the player sprite back to the world and clears the room. */
  close(): Container[] {
    this.view.visible = false;
    this.interior = null;
    for (const s of this.furniture) s.destroy();
    this.furniture = [];
    for (const s of this.people.values()) s.destroy();
    this.people.clear();
    return this.things.removeChildren() as Container[];
  }

  /** Residents who are home, standing at their spots. */
  update(residents: ReadonlyArray<{ npc: Npc; x: number; y: number }>): void {
    const live = new Set<Npc>();
    for (const r of residents) {
      live.add(r.npc);
      let s = this.people.get(r.npc);
      if (!s) {
        s = new Sprite({ texture: this.human(r.npc.outfit), anchor: { x: 0.5, y: 1 } });
        this.things.addChild(s);
        this.people.set(r.npc, s);
      }
      // Residents face the room, or the player while talking.
      s.texture = this.human(r.npc.outfit, r.npc.talking ? r.npc.facing : Dir.Down);
      s.position.set(r.x * TILE_SIZE, r.y * TILE_SIZE);
      s.zIndex = r.y * TILE_SIZE;
    }
    for (const [npc, s] of this.people) {
      if (live.has(npc)) continue;
      s.destroy();
      this.people.delete(npc);
    }
  }

  /** Fireplaces and lamps light the room at night. */
  lights(out: Light[]): void {
    const room = this.interior;
    if (!room) return;
    for (let y = 0; y < room.h; y++) {
      for (let x = 0; x < room.w; x++) {
        const glow = GLOWING[room.tileAt(x, y)!.deco];
        if (glow) out.push({ x: (x + 0.5) * TILE_SIZE, y: (y + 0.3) * TILE_SIZE, radius: glow[0] * TILE_SIZE, warmth: glow[1] });
      }
    }
  }

  private tile(id: number, variant: number): Texture {
    return this.cached(`t${id}:${variant}`, () => {
      const [x, y] = tileCell(id, variant);
      return new Rectangle(x, y, 16, 16);
    });
  }

  private deco(id: number): Texture {
    return this.cached(`d${id}`, () => {
      const f = decoFrame(id);
      return new Rectangle(f.x, f.y, f.w, f.h);
    });
  }

  private human(outfit: string, dir: number = Dir.Down): Texture {
    return this.cached(`h${outfit}:${dir}`, () => {
      const [x, y] = playerCell(dir, 0, outfit);
      return new Rectangle(x, y, 16, 32);
    });
  }

  private cached(key: string, frame: () => Rectangle): Texture {
    let t = this.textures.get(key);
    if (!t) this.textures.set(key, (t = new Texture({ source: this.atlas.source, frame: frame() })));
    return t;
  }
}
