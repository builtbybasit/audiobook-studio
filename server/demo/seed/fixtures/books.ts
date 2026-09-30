// The hand-authored source for every book in the mock library: its cast, its chapter titles, and
// the pools of narration, thought and dialogue the script generator draws lines from.
//
// These seeds are read-only. Everything built from them copies what it takes (`makeCharacters`
// clones each cast entry's aliases, `generateSegments` only ever reads strings), so no scenario can
// reach back and change what the next call to `makeWorld()` produces.
import type { Gender } from "@/types";

/** One character as written in the seed data, before voices and colours are assigned. */
export interface CastSeed {
  name: string;
  aliases: string[];
  gender: Gender;
  description: string;
}

/** The hand-authored source for one book; `makeWorld` expands it into the real entities. */
export interface BookSeed {
  id: string;
  title: string;
  author: string;
  count: number;
  cover: [string, string];
  /** [volume name, source file, chapter count] */
  volumes: [string, string, number][];
  cast: CastSeed[];
  /** [name, gender] for walk-on speakers */
  minor: [string, Gender][];
  titles: string[];
  narration: string[];
  thought: Record<string, string[]>;
  dialogue: Record<string, string[]>;
}

export const BOOK_SEEDS: BookSeed[] = [
  {
    id: "cliche",
    title: "The Cliché Cultivation World",
    author: "Unknown Daoist",
    count: 24,
    cover: ["#4c1d95", "#a78bfa"],
    volumes: [
      ["Vol. 1 · Outer Sect", "Cliche Cultivation World - Vol 1.epub", 8],
      ["Vol. 2 · Down the Mountain", "Cliche Cultivation World - Vol 2.epub", 8],
      ["Vol. 3 · The Tournament Arc", "Cliche Cultivation World - Vol 3.epub", 8],
    ],
    cast: [
      {
        name: "Narrator",
        aliases: [],
        gender: "n",
        description: "Narration, thoughts, and every speaker without a voice of their own.",
      },
      {
        name: "Ji Ning",
        aliases: ["Ning", "Junior Brother Ji"],
        gender: "m",
        description:
          "Outer-sect disciple who has read too many cultivation novels and knows exactly which cliché he is living through. Dry, self-aware, secretly earnest.",
      },
      {
        name: "Elder Mo",
        aliases: ["the Elder"],
        gender: "m",
        description:
          "Ancient sect elder with a scroll in one hand and a grudge in the other. Speaks in proverbs; means every one of them.",
      },
      {
        name: "Xiao Lan",
        aliases: ["Lan'er"],
        gender: "f",
        description:
          "Childhood friend from the valley village, sharper than anyone in the sect gives her credit for. Loyal, blunt, tired of waiting.",
      },
      {
        name: "Bai Feng",
        aliases: ["Senior Brother Bai"],
        gender: "m",
        description:
          "Senior brother and designated rival. Loud, handsome, and honestly not that bad once the plot stops making him a villain.",
      },
    ],
    minor: [
      ["Sect Disciple", "m"],
      ["Auctioneer", "m"],
      ["Old Gatekeeper", "m"],
      ["Disciple Wu", "m"],
      ["Madam Qian", "f"],
      ["Guard Captain", "m"],
      ["Pill Merchant", "m"],
      ["Junior Sister Mei", "f"],
      ["Innkeeper", "f"],
      ["Elder Shan", "f"],
      ["Young Master Zhou", "m"],
      ["Bandit Leader", "m"],
      ["Fortune Teller", "?"],
      ["Crane Spirit", "?"],
      ["Servant", "f"],
      ["Beggar", "m"],
    ],
    titles: [
      "The Silent Peak",
      "A Debt of Spirit Stones",
      "The Elder’s Test",
      "Qi Deviation",
      "Seven Paths Down the Mountain",
      "Lan’er Returns",
      "The Auction House",
      "Sword Intent",
      "A Cliché Tournament",
      "Blood on the Jade Steps",
      "Cave of Whispers",
      "The Pill Furnace",
    ],
    narration: [
      "The mountain mist thinned as dawn crept over the outer sect grounds.",
      "Ji Ning folded his hands and waited, counting the cracks in the courtyard stone.",
      "Somewhere below, a bell rang three times.",
      "The elder did not look up from his scroll.",
      "A spirit crane wheeled above the peak, indifferent to the mortals beneath it.",
      "Dust settled in the pill room, thick with the smell of burnt ginseng.",
      "The blade hummed once and went still.",
      "Nobody spoke for a long moment.",
      "Lan’er waited by the gate with her sleeves rolled, as if the mountain owed her an answer.",
    ],
    thought: {
      "Ji Ning": [
        "This is exactly how the stories go, and I hate it.",
        "If I fail here, the whole plot ends in chapter twelve.",
        "Why does everyone in this world talk like a fortune cookie?",
      ],
      "Xiao Lan": ["He is hiding something again.", "The Elder knows more than he says."],
    },
    dialogue: {
      "Ji Ning": [
        "I have not come to fight, Elder.",
        "Give me three days. That is all I ask.",
        "Senior Brother, your sword is on fire.",
        "Fine. Fine! I will take the stupid trial.",
      ],
      "Elder Mo": [
        "The path of cultivation is not a path of shortcuts, child.",
        "Three days. Not an hour more.",
        "You remind me of someone I once buried.",
        // the dictionary rewrites "outer sect" into Hanzi on the way to the endpoint, so this
        // speaker's requests are measurably more UTF-8 bytes than characters
        "The outer sect has kept worse than you, and buried better.",
      ],
      "Xiao Lan": [
        "You promised you would come back before the festival.",
        "Do not look at me like that.",
        "Then we go together, or not at all.",
      ],
      "Bai Feng": [
        "Ha! Junior Brother, you have grown bold.",
        "Step aside. This is a matter between men.",
        "I did not ask for your opinion, Ji Ning.",
      ],
    },
  },
  // A long-running web serial: the case the Export page has to survive. 214 chapters over six
  // volumes, so the chapter list, the plan, the file names and the update analysis are all exercised
  // at a scale a three-volume novel never reaches.
  {
    id: "gates",
    title: "Thousand Gates of the Ninth Heaven",
    author: "Cloudwalker of the Eastern Sea",
    count: 214,
    cover: ["#0f766e", "#5eead4"],
    volumes: [
      ["Vol. 1 · The Gate of Iron", "Thousand Gates - Vol 1.epub", 36],
      ["Vol. 2 · The Gate of Salt", "Thousand Gates - Vol 2.epub", 36],
      ["Vol. 3 · The Gate of Ash", "Thousand Gates - Vol 3.epub", 36],
      ["Vol. 4 · The Gate of Bone", "Thousand Gates - Vol 4.epub", 36],
      ["Vol. 5 · The Gate of Mirrors", "Thousand Gates - Vol 5.epub", 36],
      ["Vol. 6 · The Gate That Was Never Built", "Thousand Gates - Vol 6.epub", 34],
    ],
    cast: [
      {
        name: "Narrator",
        aliases: [],
        gender: "n",
        description: "Narration, thoughts, and every speaker without a voice of their own.",
      },
      {
        name: "Shen Yue",
        aliases: ["Yue", "the Gatewalker"],
        gender: "f",
        description:
          "Walked into the first gate on a dare and has been walking ever since. Patient, literal, and very hard to lie to.",
      },
      {
        name: "Fifth Uncle",
        aliases: ["the Uncle"],
        gender: "m",
        description:
          "Claims to be a retired gatekeeper. Carries too many keys for a retired anything.",
      },
      {
        name: "The Cartographer",
        aliases: ["Mapmaker"],
        gender: "n",
        description:
          "Draws the gates nobody has walked yet, and is correct often enough to be frightening.",
      },
      {
        name: "Ren Baoyu",
        aliases: ["Baoyu"],
        gender: "m",
        description: "Sect prodigy, three gates behind and furious about it.",
      },
    ],
    minor: [
      ["Gate Warden", "m"],
      ["Salt Merchant", "f"],
      ["Ferryman", "m"],
      ["Archivist", "f"],
      ["Bone Singer", "?"],
      ["Mirror Child", "?"],
      ["Caravan Guard", "m"],
      ["Tea Seller", "f"],
    ],
    titles: [
      "The Gate That Would Not Open",
      "Salt on the Threshold",
      "What the Warden Kept",
      "A Map with No Edges",
      "Nine Steps, Counted Twice",
      "The Ferryman's Price",
      "Ash in the Hinges",
      "Letters to a Closed Door",
      "The Archivist Lies Politely",
      "Bone Music",
      "Every Mirror Faces East",
      "The Gate That Was Never Built",
      "A Key for a Name",
      "The Long Walk Between",
      "Rust, and What It Remembers",
      "Two Gates, One Hinge",
    ],
    narration: [
      "The gate stood where the map said nothing stood at all.",
      "Shen Yue counted the hinges, which is how she counted everything.",
      "Salt had crusted along the threshold in a line nobody had crossed for a century.",
      "Fifth Uncle produced a key, then another, then looked embarrassed.",
      "The Cartographer drew without looking down, which was its own kind of answer.",
      "Somewhere beyond the wall, a bell that should not exist rang once.",
      "Wind came through the arch carrying the smell of a season that had not arrived.",
      "The door did not open so much as agree to be elsewhere.",
      "Ren Baoyu arrived late, as he had for three volumes running.",
    ],
    thought: {
      "Shen Yue": [
        "Nine hinges. There were eight yesterday.",
        "If the map is wrong, the map is lying, and maps do not lie by accident.",
        "He is going to say something wise and useless in a moment.",
      ],
      "Ren Baoyu": [
        "Three gates. Three. She makes it look like walking downhill.",
        "I will not ask her for help. I will not.",
      ],
    },
    dialogue: {
      "Shen Yue": [
        "It opens. It just does not open for you.",
        "Give me the key, Uncle. The real one.",
        "I have walked eleven of these. None of them cared what I wanted.",
        "Then we go through, and we find out together.",
      ],
      "Fifth Uncle": [
        "A gate is a promise somebody made and could not keep.",
        "I was a gatekeeper. Keeping is not the same as opening.",
        "Do not touch the salt.",
      ],
      "The Cartographer": [
        "The edge of the map is not the edge of the world. It is the edge of my patience.",
        "I drew this gate four years before it was built.",
        "You are standing on a road I have not finished.",
      ],
      "Ren Baoyu": [
        "I do not need a guide.",
        "Everyone says your name like it means something.",
        "Fine. Lead, then. I will keep up.",
      ],
    },
  },
  {
    id: "starforge",
    title: "Ashes of the Starforge",
    author: "M. R. Halloway",
    count: 18,
    cover: ["#7c2d12", "#fb923c"],
    volumes: [["Ashes of the Starforge", "Ashes of the Starforge.epub", 18]],
    cast: [
      {
        name: "Narrator",
        aliases: [],
        gender: "n",
        description: "Narration, thoughts, and every speaker without a voice of their own.",
      },
      {
        name: "Captain Idris Vale",
        aliases: ["Vale", "the Captain"],
        gender: "m",
        description:
          "Salvage captain running on debt and stubbornness. Clipped, decisive, allergic to being told the odds.",
      },
      {
        name: "Ocho",
        aliases: ["the ship"],
        gender: "n",
        description:
          "The ship’s mind. Polite, precise, and increasingly worried about its crew. Never raises its voice; never needs to.",
      },
      {
        name: "Dr. Maren Sato",
        aliases: ["Sato", "Doc"],
        gender: "f",
        description:
          "Ship’s physician and reluctant engineer. Runs the numbers three times and argues with all of them.",
      },
      {
        name: "Envoy Tal",
        aliases: ["the Envoy"],
        gender: "f",
        description:
          "Concord envoy with a diplomat’s smile and a warship’s patience. Every sentence is a negotiation.",
      },
    ],
    minor: [
      ["Deck Officer Ruiz", "m"],
      ["Comms", "?"],
      ["Salvager Two", "f"],
      ["Medic", "f"],
      ["Concord Marine", "m"],
      ["Dockmaster", "m"],
      ["Engineer Pell", "f"],
      ["Cargo AI", "n"],
      ["Pilot Yun", "f"],
      ["Quartermaster", "m"],
    ],
    titles: [
      "Cold Start",
      "The Forge Remembers",
      "Ocho Wakes",
      "Envoy",
      "Slag Orbit",
      "Eleven Minutes of Silence",
      "Sato’s Wager",
      "The Long Burn",
      "Mutiny at Perihelion",
    ],
    narration: [
      "The hull ticked as it cooled, a slow metronome in the dark.",
      "Vale watched the forge star through a scratched viewport, too tired to blink.",
      "The corridor lights came up one by one, hesitant as a rumour.",
      "Something in the cargo bay had begun to hum.",
      "The Envoy’s shuttle docked without a sound.",
      "Sato ran the numbers twice, then a third time, and did not like them any better.",
    ],
    thought: {
      "Captain Idris Vale": [
        "We are not going home. Nobody says it, but the ship knows.",
        "She is lying. The question is which part.",
      ],
      "Dr. Maren Sato": ["Eleven minutes. That is all the margin we have."],
    },
    dialogue: {
      "Captain Idris Vale": [
        "Ocho, give me the burn window.",
        "We do this once. There is no second pass.",
        "I am not asking, Doctor.",
      ],
      Ocho: [
        "Burn window opens in eleven minutes, Captain.",
        "I would advise against that. Strongly.",
        "Hull integrity at sixty-one percent and falling.",
      ],
      "Dr. Maren Sato": [
        "If we burn now we cook the forward tanks.",
        "You want a miracle? Give me an hour.",
        "Fine. But it is your name on the log.",
      ],
      "Envoy Tal": [
        "The Concord does not negotiate with salvagers.",
        "You have something that belongs to us, Captain.",
        "How curious. Your ship is afraid.",
      ],
    },
  },
  {
    id: "drowned",
    title: "Letters from the Drowned City",
    author: "Ines Varga",
    count: 22,
    cover: ["#134e4a", "#2dd4bf"],
    volumes: [
      ["Part One · High Water", "Drowned City 1.epub", 11],
      ["Part Two · What the Tide Keeps", "Drowned City 2.epub", 11],
    ],
    cast: [
      {
        name: "Narrator",
        aliases: [],
        gender: "n",
        description: "Narration, thoughts, and every speaker without a voice of their own.",
      },
      {
        name: "Wren",
        aliases: [],
        gender: "f",
        description:
          "Nineteen, stubborn, still writing letters to someone who left when the water was at the first step. Quiet until she is not.",
      },
      {
        name: "Old Tobiah",
        aliases: ["Tobiah", "the lamplighter"],
        gender: "m",
        description:
          "Lamplighter of the drowned avenue. Rows the last boat. Grumbles like a man who has already said goodbye to the city.",
      },
      {
        name: "The Tidewarden",
        aliases: ["Warden"],
        gender: "f",
        description:
          "Whatever keeps the drowned city’s bargains. Speaks slowly, in terms. Do not agree to anything.",
      },
    ],
    minor: [
      ["Postmistress", "f"],
      ["Ferryman", "m"],
      ["Child", "?"],
      ["Cannery Foreman", "m"],
      ["Bell-ringer", "m"],
      ["Widow Marsh", "f"],
      ["Constable", "m"],
      ["Drowned Voice", "?"],
      ["Fishwife", "f"],
      ["Priest", "m"],
      ["Glassblower", "f"],
      ["Salt Merchant", "m"],
    ],
    titles: [
      "High Water",
      "The Lamplighter’s Ledger",
      "A Letter Unsent",
      "Under the Salt Bridge",
      "What the Tide Keeps",
      "Wren Goes Down",
      "The Warden’s Bargain",
      "Glass and Silt",
      "Last Light on Cannery Row",
      "The Drowned Bell",
      "Ink That Will Not Dry",
    ],
    narration: [
      "The water had reached the third step of the cathedral by morning.",
      "Wren wrote the address twice, then crossed it out.",
      "Lamps flickered along the submerged avenue, green through the murk.",
      "The bell tolled somewhere beneath the harbour.",
      "Tobiah’s boat knocked gently against the drowned lamppost.",
    ],
    thought: {
      Wren: [
        "If I post this, she will know I am still here.",
        "The Warden never blinks. Why have I only noticed now?",
      ],
    },
    dialogue: {
      Wren: [
        "Is it deeper than yesterday?",
        "I need to get to the post office. The real one.",
        "You knew. You knew the whole time.",
      ],
      "Old Tobiah": [
        "Deeper every day, girl. Deeper every day.",
        "Nobody rows past the salt bridge after dark.",
        "Sit down before you tip us both in.",
      ],
      "The Tidewarden": [
        "The city keeps what it is given.",
        "A letter for a name. That is the price.",
        "You may go down, Wren. Coming back is another matter.",
      ],
    },
  },
];

export const MINOR_LINES: string[] = [
  "Yes, my lord.",
  "This way, please.",
  "You cannot go in there.",
  "Coin first. Then we talk.",
  "Did you hear that?",
  "It was not me, I swear it.",
  "Move along. Nothing to see.",
  "They say the elder has not slept in a week.",
  "Sold! To the gentleman at the back.",
  "Careful. The steps are wet.",
];

/** The seed one book was written from. Throws rather than returning undefined: every id the app
 *  can reach a mock generator with came from this list in the first place. */
export function bookSeed(id: string): BookSeed {
  const seed = BOOK_SEEDS.find((b) => b.id === id);
  if (!seed) throw new Error(`no mock book seed for “${id}”`);
  return seed;
}
