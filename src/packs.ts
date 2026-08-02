/**
 * packs.ts — what a card *is*, with no opinion about how it looks.
 *
 * This is the data half of card identity: which cards a pack contains, in what
 * order, and how to shuffle a deck reproducibly. It imports nothing from three
 * and touches no DOM, so it runs unchanged in the headless test and on an
 * authoritative host that never draws a frame. All the rasterising — faces, the
 * back, the atlas — lives in cardart.ts, which reads the definitions from here.
 *
 * The split matters for more than tidiness. A networked game agrees on *which*
 * card moved, never on a texture; keeping the deck a plain list of definitions
 * means the server can build and shuffle it without a canvas anywhere in sight,
 * and the client can render the same list however it likes.
 */

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export type PackId = 'standard' | 'cah-black' | 'cah-white'

/**
 * One card, described rather than drawn.
 *
 * `kind` is the discriminant cardart.ts switches on to pick a drawer, and it is
 * what keeps the three packs from having to share a field layout they do not
 * agree on: a suit card has a rank and a suit, a joker has neither, a text card
 * carries a string. `id` is stable and unique within a build and is the key the
 * atlas hands back a UV rect for — it is deliberately human-readable so a card
 * is legible in a log or a network trace without a lookup table.
 */
export interface CardDef {
  id: string
  pack: PackId
  kind: 'suit' | 'joker' | 'text'
  rank?: string
  suit?: 'S' | 'H' | 'D' | 'C'
  text?: string
}

/**
 * Suit and rank order, exported because it is also the *atlas* order: the art
 * module lays cards out in the sequence buildDeck emits them, and both sides
 * reading these constants is what keeps a card's cell where its id says it is.
 * Spades, hearts, diamonds, clubs is bridge order and the order a new deck ships
 * in; Ace low through King is the run every player expects to see in a fan.
 */
export const SUITS = ['S', 'H', 'D', 'C'] as const
export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'] as const

export type Suit = (typeof SUITS)[number]
export type Rank = (typeof RANKS)[number]

/** Red suits render red, black suits black — the one visual fact that is really
 *  a property of the card, so it lives with the data. */
export function isRedSuit(suit: Suit): boolean {
  return suit === 'H' || suit === 'D'
}

// ---------------------------------------------------------------------------
// Cards Against Humanity–style content
// ---------------------------------------------------------------------------
//
// A parody set written for this game, not lifted from the real product: dry
// office-and-everyday humour, no slurs, nothing that needs a content warning.
// The joke is meant to be the flat, over-literal answer to a mundane prompt, so
// the pack stays funny while being safe to put in front of anyone.
//
// A blank in a prompt is written as "___". White cards are plain answers with
// no blank; the game pairs one answer into one prompt's blank.

/** Black pack: prompts. Roughly thirty, each with at least one blank. */
const CAH_BLACK: readonly string[] = [
  'The meeting could have been an email about ___.',
  'My therapist says my real problem is ___.',
  'The office kitchen smells of ___ again.',
  'Please do not put ___ in the recycling.',
  'The landlord insists the damp is caused by ___.',
  'What did the algorithm quietly recommend next? ___.',
  'Nothing brings a family together like ___.',
  'The council has voted to ban ___.',
  "What is in the drawer nobody dares open? ___.",
  'This train is delayed due to ___.',
  'I have replaced my entire morning routine with ___.',
  'Our new company values: teamwork, honesty, and ___.',
  'The instructions warn specifically against ___.',
  'Local news at six, live from the scene of ___.',
  'My search history is mostly ___.',
  'The team-building day this year is just ___.',
  'I could not sleep because of ___.',
  'The wifi password is a hint: it is ___.',
  'Doctor, be honest with me about ___.',
  'The group chat has gone strangely quiet since ___.',
  'What finally got me to leave the party? ___.',
  'The new intern was fired for ___.',
  'I gave up a promising career for ___.',
  'The gym induction politely covered ___ and then ___.',
  'What is the secret ingredient? ___.',
  'The user manual has one page, and it just says ___.',
  'A moment of silence, please, for ___.',
  'The sign on the door has been updated to read ___.',
  'My out-of-office reply now simply promises ___.',
  'The committee spent four hours debating ___.',
]

/** White pack: answers. Roughly sixty, each usable in any blank above. */
const CAH_WHITE: readonly string[] = [
  'A bag of smaller bags.',
  'Three quarters of a trifle.',
  'A slightly damp sofa.',
  'Aggressively neutral beige.',
  'Four thousand unread emails.',
  'A pigeon with strong opinions.',
  'The office fridge, and everything in it.',
  'A single laminated sign.',
  'Enthusiasm at seven in the morning.',
  'Exactly one shoe.',
  'Six identical charging cables.',
  'A haunted spreadsheet.',
  'The last biscuit.',
  'A very confident wrong answer.',
  'Small talk about the weather.',
  'A drawer full of expired sauces.',
  'Motivational wall art.',
  'Hitting reply-all on purpose.',
  'A fitted sheet, folded badly.',
  'Lukewarm tea.',
  'The distant sound of a printer.',
  'A mystery charge for four pounds ninety-nine.',
  'A subcommittee.',
  'Standing in the wrong queue with total commitment.',
  'A trampoline nobody uses.',
  'Two percent battery.',
  'A door clearly marked PULL.',
  'The four oclock slump.',
  'A packet of nine hot dog buns.',
  "Someone else's umbrella.",
  'A team lunch that runs until four.',
  'Passive-aggressive sticky notes.',
  'The good stapler.',
  'An unskippable tutorial.',
  'Being cc-ed for no reason.',
  'A calendar invite with no agenda.',
  'A houseplant slowly giving up.',
  'The self-checkout, refusing to believe me.',
  'A group project where I did everything.',
  'Overhead lighting that hums.',
  'A wobbly table and one folded napkin.',
  'The word "synergy," said without irony.',
  'A parking ticket, framed.',
  'One very long voicemail.',
  'The last ten percent of any task.',
  'A spreadsheet with feelings.',
  'A firm handshake and nothing else.',
  'The bit of tape you can never find the end of.',
  'A conference call that is mostly breathing.',
  'An escalator, temporarily stairs.',
  'A biscuit tin full of sewing supplies.',
  'The confident stranger giving directions.',
  'A meeting that could have been two meetings.',
  'A slowly deflating novelty balloon.',
  'The printer, out of a colour I was not using.',
  'A password that expired an hour ago.',
  'A well-meaning forwarded chain email.',
  'The seat that is somehow always warm.',
  'A vending machine that keeps the change.',
  'An inspirational quote over a stock photo of a mountain.',
]

/** Public, read-only view of the two text packs, so a caller can list content
 *  without reaching into module internals or building a whole deck. */
export const CAH_PROMPTS: readonly string[] = CAH_BLACK
export const CAH_ANSWERS: readonly string[] = CAH_WHITE

// ---------------------------------------------------------------------------
// Deck building
// ---------------------------------------------------------------------------

/** Two jokers, the way a real pack ships them: one dark, one red. Kept as ids
 *  rather than an index so the atlas and the network agree on the same string. */
const JOKERS: readonly string[] = ['joker-black', 'joker-red']

/**
 * The cards in a pack, in canonical order.
 *
 * Order is part of the contract: cardart.ts fills its atlas in exactly this
 * sequence, so the nth card drawn is the nth cell. A fresh deck therefore comes
 * back sorted, and any shuffling a game wants is the caller's to apply with
 * `shuffle` — building and randomising are kept separate so the server can
 * build a deterministic deck and seed the shuffle itself.
 */
export function buildDeck(pack: PackId): CardDef[] {
  switch (pack) {
    case 'standard': {
      const cards: CardDef[] = []
      for (const suit of SUITS) {
        for (const rank of RANKS) {
          cards.push({ id: `${rank}${suit}`, pack, kind: 'suit', rank, suit })
        }
      }
      // Jokers last, so the 52 playing cards keep the indices a caller would
      // expect if it ever ignores the jokers.
      for (const id of JOKERS) cards.push({ id, pack, kind: 'joker' })
      return cards
    }
    case 'cah-black':
      return CAH_BLACK.map((text, i) => ({ id: `black-${i}`, pack, kind: 'text', text }))
    case 'cah-white':
      return CAH_WHITE.map((text, i) => ({ id: `white-${i}`, pack, kind: 'text', text }))
  }
}

/**
 * Fisher-Yates, seeded through the passed generator.
 *
 * Returns a new array and never touches the input: a deck is data other things
 * hold references to, and shuffling in place would reorder a list something else
 * is mid-iteration over. The randomness is injected rather than taken from
 * Math.random so a game can drive it from a seeded PRNG and get the same shuffle
 * on every client from one shared seed — the whole reason multiplayer can agree
 * on a deck order without sending 54 cards over the wire.
 *
 * `rand` must return a float in [0, 1). The classic backwards walk is used
 * because it visits each index once and is the arrangement that is provably
 * unbiased when the source is uniform.
 */
export function shuffle<T>(items: readonly T[], rand: () => number): T[] {
  const out = items.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    const t = out[i]
    out[i] = out[j]
    out[j] = t
  }
  return out
}

/**
 * A small, fast, seedable PRNG (mulberry32), offered so a caller has a source
 * for `shuffle` without importing one. Kept here rather than assumed on the
 * caller because determinism is a property of the deck, and the deck lives here.
 */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a += 0x6d2b79f5
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Pack metadata, so a menu can list what is available without building every
 * deck first. `count` is derived from the same source `buildDeck` uses, so the
 * two can never drift apart — the test pins that they agree.
 */
export const PACKS: Record<PackId, { name: string; count: number }> = {
  standard: { name: 'Standard 52 + Jokers', count: SUITS.length * RANKS.length + JOKERS.length },
  'cah-black': { name: 'Prompts (black)', count: CAH_BLACK.length },
  'cah-white': { name: 'Answers (white)', count: CAH_WHITE.length },
}
