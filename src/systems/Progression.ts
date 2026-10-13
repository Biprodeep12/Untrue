// Progression (spec 5): experience, levels and skills. Each level raises max
// health and damage, and gives a skill point to spend on a skill.

export const MAX_LEVEL = 50;
const HEALTH_PER_LEVEL = 8;
const DAMAGE_PER_LEVEL = 0.05;

export type SkillId = 'warrior' | 'hunter' | 'gatherer' | 'forager' | 'swimmer' | 'packMule' | 'survivalist' | 'toughness' | 'nimble';

export interface SkillDef {
  id: SkillId;
  name: string;
  /** What each rank gives. */
  effect: string;
}

/** 9 skills × 5 ranks = 45 points, so levels up to 46 all buy something. */
export const MAX_RANK = 5;

export const SKILLS: readonly SkillDef[] = [
  { id: 'warrior', name: 'Warrior', effect: '+8% damage per rank' },
  { id: 'hunter', name: 'Hunter', effect: 'Animals give extra meat and hide: +35% chance per rank' },
  { id: 'gatherer', name: 'Gatherer', effect: 'Chop, mine and pick 15% faster per rank' },
  { id: 'forager', name: 'Forager', effect: 'Plants give an extra one: +30% chance per rank' },
  { id: 'swimmer', name: 'Swimmer', effect: 'Swim 10% faster and tire 15% slower in deep water per rank' },
  { id: 'packMule', name: 'Pack Mule', effect: 'Carry 25 more weight per rank' },
  { id: 'survivalist', name: 'Survivalist', effect: 'Hunger and thirst drain 10% slower per rank' },
  { id: 'toughness', name: 'Toughness', effect: '+6% max health per rank' },
  { id: 'nimble', name: 'Nimble', effect: 'Dodge rolls cost 12% less stamina per rank' },
];

export interface ProgressionSave {
  xp: number;
  level: number;
  skills?: Partial<Record<SkillId, number>>;
  /** Legendary creatures defeated, by species id; missing in older saves. */
  trophies?: Record<string, number>;
  /** Rare recipes learned, by output item id; missing in older saves. */
  recipes?: string[];
}

export class Progression {
  /** Experience toward the next level. */
  xp = 0;
  level = 1;
  /** Ranks learned per skill. */
  readonly skills: Record<SkillId, number> = { warrior: 0, hunter: 0, gatherer: 0, forager: 0, swimmer: 0, packMule: 0, survivalist: 0, toughness: 0, nimble: 0 };

  /** Legendary creatures defeated, by species id. */
  readonly trophies: Record<string, number> = {};
  /** Rare recipes learned, by output item id. */
  readonly recipes = new Set<string>();

  /** Experience needed to go from `level` to the next. */
  static needed(level: number): number {
    return Math.round(40 * Math.pow(level, 1.5));
  }

  get maxHealth(): number {
    return Math.round((100 + HEALTH_PER_LEVEL * (this.level - 1)) * (1 + 0.06 * this.skills.toughness));
  }

  get damageBonus(): number {
    return (1 + DAMAGE_PER_LEVEL * (this.level - 1)) * (1 + 0.08 * this.skills.warrior);
  }

  /** One point per level gained, less the ranks already learned. */
  get skillPoints(): number {
    let spent = 0;
    for (const r of Object.values(this.skills)) spent += r;
    return this.level - 1 - spent;
  }

  rank(id: SkillId): number {
    return this.skills[id];
  }

  /** Spends a point on a skill; returns whether it could. */
  learn(id: SkillId): boolean {
    if (this.skillPoints <= 0 || this.skills[id] >= MAX_RANK) return false;
    this.skills[id]++;
    return true;
  }

  /** Adds experience; returns how many levels were gained. */
  add(xp: number): number {
    let gained = 0;
    this.xp += Math.round(xp);
    while (this.level < MAX_LEVEL && this.xp >= Progression.needed(this.level)) {
      this.xp -= Progression.needed(this.level);
      this.level++;
      gained++;
    }
    return gained;
  }

  save(): ProgressionSave {
    return { xp: this.xp, level: this.level, skills: { ...this.skills }, trophies: { ...this.trophies }, recipes: [...this.recipes] };
  }

  load(s: ProgressionSave): void {
    this.xp = s.xp;
    this.level = s.level;
    for (const def of SKILLS) this.skills[def.id] = Math.min(MAX_RANK, s.skills?.[def.id] ?? 0);
    Object.assign(this.trophies, s.trophies ?? {});
    for (const id of s.recipes ?? []) this.recipes.add(id);
  }
}
