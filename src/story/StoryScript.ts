// The words of The World That Forgets: visions, dialogue and inscriptions.

export interface Vision {
  title: string;
  pages: readonly string[];
}

export const VISIONS = {
  prologue: {
    title: 'Prologue — A world with no beginning',
    pages: [
      'Nobody knows when the world began. Mountains rise where oceans once lay, forests grow over forgotten cities, and ancient roads lead to places that may no longer exist.',
      'A traveller returns to a familiar valley and finds a lake where a village once stood. Nobody is surprised. They call it the Forgetting.',
      'You awaken on cold stone beneath an unfamiliar sky, remembering neither your name nor how you came here. In your hand is a small lantern with a faint blue flame.',
    ],
  },
  bell: {
    title: 'The bell',
    pages: ['The monument crumbles into dust. Far away, beyond the horizon, a bell rings three times.', 'You begin walking toward it.'],
  },
  revision: {
    title: 'Chapter II — The village that never existed',
    pages: [
      'That night, the village disappears.',
      'You wake in an empty field. The houses, the roads, the people: gone. A dense forest stands where they were, as if nothing had ever been built here.',
      'Only the lantern remembers. Inside its glass you see the village as it was yesterday, and its people still moving, living out their lives in a memory that no longer belongs to the world.',
    ],
  },
  memory1: {
    title: 'A memory: the builders',
    pages: ['Light gathers above the pedestal. A city rises stone by stone, its builders singing. The same face appears among them three times: a mason, a queen, a beggar at the gate.'],
  },
  memory2: {
    title: 'A memory: the war',
    pages: ['Two kingdoms march against each other across a valley. When the battle ends, nobody remembers why it began, and the valley becomes a forest before the bodies are buried.'],
  },
  memory3: {
    title: 'A memory: the Anchors',
    pages: [
      'A figure with a lantern raises great towers across the land: the Anchors. Around each one, the world holds still. Cities stay where they are built. History becomes permanent.',
      'One name is carved into every tower: the Worldmaker.',
    ],
  },
  hall: {
    title: 'Chapter IV — The Hall of Lanterns',
    pages: [
      'Thousands of lanterns hang in the dark, each like your own. Most are cold. A few hold faint silhouettes: the vanished village, the observatory and its keeper.',
      'In the largest, a vast city lies beneath a red sky, ringed by machines that reshape the land. At its centre stands a figure in your clothes, carrying your lantern.',
      'The figure looks straight at you through the glass. "You have finally found the place where I buried you."',
      'The oldest records name a creator: the Worldmaker. Some call it kind, some a tyrant. One says it created nothing at all. It only found a world that had already forgotten itself.',
    ],
  },
  truth: {
    title: 'Chapter V — The truth about the Worldmaker',
    pages: [
      'The Worldmaker learned that memory could anchor the world. Its Anchors held kingdoms still, and for a time, history became permanent.',
      'But permanence was its own prison. Wars never ended. The dead were mourned forever. So the Worldmaker tore the Anchors down and began to erase the past.',
      'Forgetting did not end suffering either. It only let suffering repeat. Unable to choose, the Worldmaker made a lantern to carry memory outside the changing world, then erased itself.',
      '"I could not decide whether the world deserved to continue. So I created someone who would have to live in it before answering."',
    ],
  },
  dark: {
    title: 'Chapter VI — You are not the original',
    pages: [
      'The younger figure asks the question no version of you has ever answered:',
      '"If you knew the world would forget everything you did, would you still choose to save it?"',
      'For the first time, the lantern goes dark.',
    ],
  },
} satisfies Record<string, Vision>;

export const ENDINGS = {
  remembered: {
    name: 'The Remembered World',
    choice: 'Restore the Anchors',
    summary: 'The world will hold still. History becomes permanent, with every wound it carries.',
    vision: {
      title: 'The Remembered World',
      pages: [
        'The Anchors wake one by one. Mountains stop moving. Cities stay where they were built.',
        'You stand in the restored village, watching its people go about their lives. Nobody recognises you. For the first time, the world no longer needs to remember you in order to exist.',
      ],
    },
  },
  living: {
    name: 'The Living World',
    choice: 'Destroy the last Anchor',
    summary: 'Nothing will be guaranteed to last. Life will keep beginning again, free of the past.',
    vision: {
      title: 'The Living World',
      pages: [
        'The final Anchor collapses behind you, and the lantern becomes an ordinary, unlit thing.',
        'You walk into a wilderness that has never existed before. You cannot know what the world will become, and for the first time, neither can its creator.',
      ],
    },
  },
  memory: {
    name: 'The Last Memory',
    choice: 'Take every memory into the lantern',
    summary: 'The world will stop forgetting, because you will remember it all. You will become its keeper.',
    vision: {
      title: 'The Last Memory',
      pages: [
        'Every memory flows into the lantern, and the world grows still and peaceful.',
        'Centuries later, a traveller wakes beside a stone monument, an unlit lantern at their side. The carving reads: "If you have awakened again, do not search for the beginning."',
        'Perhaps the cycle has ended. Or perhaps you have simply become the next Worldmaker.',
      ],
    },
  },
} as const;

export type Ending = keyof typeof ENDINGS;

export const INSCRIPTIONS = {
  monument: '"If you have awakened again, do not search for the beginning. You will only find what you have already destroyed."',
  grave: 'Every stone bears your name, and the same words: "Returned, but not remembered." The dates are impossible: some centuries past, some not yet come.',
  grave2: 'Another stone with your name. "Returned, but not remembered."',
  journal: 'The old man\'s journal. The last entry is in your handwriting: "Do not trust the man in the observatory. He is not the first version of himself."',
  observatoryEmpty: 'The journal lies open on the table. The pages after your last visit are blank.',
  anchorAfter: 'The Anchor hums quietly. Whatever you chose, it is done.',
} as const;

export interface Speech {
  name: string;
  pages: readonly string[];
}

export const SPEECH = {
  elder: {
    name: 'Elder Maren',
    pages: [
      'Welcome, traveller. Our village has stood in peace beneath these trees for three hundred years.',
      'Nothing ever changes here. That is our blessing.',
    ],
  },
  merchant: {
    name: 'Corwin the Merchant',
    pages: ['Peace? Ha. I remember the fire that took half the village. Black smoke for a week.', 'The elder says it never happened. Maybe I dreamt it.'],
  },
  child: {
    name: 'Little Pell',
    pages: ['Look at my drawing! It\'s the big black tower in the square.', '...There\'s no tower? There is. I see it every night.'],
  },
  oldman: {
    name: 'The Astronomer',
    pages: [
      'You. Of course it is you. No, we have never met. Not in this version of the world.',
      'I have spent my life charting the Forgetting. It is not random. The world changes according to memory. Places with strong histories resist; forgotten places become something else.',
      'I call these changes revisions. And they are accelerating.',
      'Read the journal on my table, if you wish. You wrote it. You write it every time.',
      'I have killed you before, you know. Every time you return, you ask me the same questions. Follow your lantern to the Sunken Archive. The oldest memories sleep there.',
    ],
  },
  younger: {
    name: 'Your younger self',
    pages: [
      'I have wandered this world for years. I found the archive, met the old man, and stood among the graves that carry our name.',
      'I finally understand. You are the Worldmaker, and I am the one who must stop you.',
      '...You see it, don\'t you? I cast no shadow. My lantern lights nothing. I am only what you forgot: your first fear, your first reason.',
      'The Worldmaker did not make us to find the right answer. It made us because it was afraid to answer. Every version of you was allowed to believe it was the first.',
      'Find the Original Anchor at the centre of everything. And answer this time.',
    ],
  },
} satisfies Record<string, Speech>;

/** Messages left by previous versions of the player, found after an ending. */
export const ECHOES = [
  'Scratched into the stone in your handwriting: "I chose to remember. It still hurt. I am glad it did."',
  'A faded carving: "Last time I forgot on purpose. This time I want to see what happens."',
  'In your handwriting: "The old man was kind to me. Tell him I said so, if he is still there."',
  'A carving, half worn away: "Do not look for the beginning. Look for the people."',
  'In your handwriting: "I have stood here before. I think I will stand here again."',
];

/** Preserved histories found after The Last Memory. Some disagree with the story. */
export const FRAGMENTS = [
  'A memory surfaces: the Village of Graves was never a village. It was a garden, and the stones were seeds.',
  'A memory surfaces: the Astronomer was the Worldmaker\'s first student, and he left on purpose.',
  'A memory surfaces: there were never three choices. There was only ever one, and you made it.',
  'A memory surfaces: a red city beneath a red sky, and in it, nobody at all.',
];

export const QUIET_BOOK = '"I think this time, I will let the world surprise me." The book has no author\'s name.';

/** What the player reads when leafing through a bookshelf. */
export const BOOKS = [
  'A farmer\'s almanac. Someone has crossed out every date and written "again" in the margin.',
  'A book of maps. No two pages show the same coastline.',
  'A children\'s story about a lantern that remembers. The last page is torn out.',
  'A ledger of trades. The same name appears in it for three hundred years.',
  'Poems about the Forgetting. "What the world lets go of, someone must carry."',
  'A cookbook. The stew recipe calls for mushrooms, herbs and a handful of berries.',
  'A diary: "The house across the square was not there yesterday. Nobody else noticed."',
];

/** The lantern whispers when something new is found. */
export const WHISPERS = [
  'The lantern whispers: you have walked this path before.',
  'The lantern whispers: this place was different, once.',
  'The lantern whispers: someone you knew lived here.',
  'The lantern whispers: do not forget this one.',
];
