/**
 * Built-in Peril deck.
 *
 * Original content — deliberately not a Cards Against Humanity import, both to
 * stay clear of their card text and to keep the default pack workplace-safe.
 * Drop additional packs in `public/data/packs/*.json` shaped as
 * `{ id, name, prompts: [{text, pick}], responses: string[] }` and pass their
 * ids when creating a room.
 */

export type Prompt = { text: string; pick: number }

export type Pack = {
  id: string
  name: string
  prompts: Prompt[]
  responses: string[]
}

/** `_` marks a blank the winning response fills. */
export const BASE_PACK: Pack = {
  id: 'peril-base',
  name: 'Peril: Base Set',
  prompts: [
    { text: 'The startup pivoted to _.', pick: 1 },
    { text: 'My therapist says my real problem is _.', pick: 1 },
    { text: 'Nothing ruins a first date faster than _.', pick: 1 },
    { text: 'The group project fell apart because of _.', pick: 1 },
    { text: 'I lost my job over _.', pick: 1 },
    { text: 'The secret ingredient is _.', pick: 1 },
    { text: 'Welcome to the team! Your first task is _.', pick: 1 },
    { text: 'The prophecy foretold _.', pick: 1 },
    { text: 'Every family reunion ends with _.', pick: 1 },
    { text: 'My browser history is mostly _.', pick: 1 },
    { text: 'The new office policy bans _.', pick: 1 },
    { text: 'Scientists were shocked to discover _.', pick: 1 },
    { text: 'You can tell a lot about a person by _.', pick: 1 },
    { text: 'This meeting could have been _.', pick: 1 },
    { text: 'I put _ on my resume.', pick: 1 },
    { text: 'The haunted house was just _.', pick: 1 },
    { text: 'My villain origin story begins with _.', pick: 1 },
    { text: 'The cult recruits members with _.', pick: 1 },
    { text: 'Local man arrested for _.', pick: 1 },
    { text: 'The five-star review simply read: _.', pick: 1 },
    { text: 'I would trade my entire savings for _.', pick: 1 },
    { text: 'Do not open that door. Behind it is _.', pick: 1 },
    { text: 'The tutorial never explained _.', pick: 1 },
    { text: 'My autobiography is titled _.', pick: 1 },
    { text: 'What is the tenth circle of hell?', pick: 1 },
    { text: 'The reboot nobody asked for: _.', pick: 1 },
    { text: 'First _, then _.', pick: 2 },
    { text: 'I survived on nothing but _ and _.', pick: 2 },
    { text: 'The recipe calls for _ and a pinch of _.', pick: 2 },
    { text: 'My two greatest weaknesses are _ and _.', pick: 2 },
    { text: 'The museum exhibit paired _ with _.', pick: 2 },
    { text: 'Step one: _. Step two: _. Step three: profit.', pick: 2 },
  ],
  responses: [
    'a suspiciously damp envelope',
    'aggressive eye contact',
    'seventeen unread voicemails',
    'a haunted vending machine',
    'the concept of Tuesday',
    'unearned confidence',
    'a spreadsheet with feelings',
    'my third-best personality',
    'a raccoon in a business suit',
    'the sound of a distant kazoo',
    'radical honesty at brunch',
    'a lightly used trampoline',
    'the wrong kind of silence',
    'forty pounds of glitter',
    'an apology written in crayon',
    'the vibes, exclusively',
    'a group chat that never sleeps',
    'my sleep paralysis demon',
    'an unreasonable number of tabs',
    'competitive napping',
    'the last slice of pizza',
    'a motivational poster gone wrong',
    'legally distinct enthusiasm',
    'a very confident wrong answer',
    'the ghost of my gym membership',
    'six hours of onboarding',
    'a cat with opinions',
    'the smell of a new laptop',
    'my emotional support spreadsheet',
    'an aggressively firm handshake',
    'a plot twist nobody wanted',
    'the honor system',
    'a lukewarm standing ovation',
    'three raccoons and a dream',
    'yelling at a printer',
    'the entire concept of jazz',
    'a sandwich of questionable origin',
    'passive-aggressive sticky notes',
    'my search history at 3 a.m.',
    'a trust fall with no one behind me',
    'an unlicensed magician',
    'the group project curse',
    'excessive lens flare',
    'a suspiciously cheap flight',
    'my mother reading this aloud',
    'a firm but loving intervention',
    'the wrong Steve',
    'a pigeon with a grudge',
    'irreversible smugness',
    'the fine print',
    'a haircut I will regret',
    'ninety minutes of buffering',
    'an heirloom bowling ball',
    'my untreated main character syndrome',
    'a well-timed fire alarm',
    'the audacity',
    'a corporate retreat in the woods',
    'unsolicited career advice',
    'a jar of expired optimism',
    'the sequel to my worst decision',
    'a horse in the hallway',
    'genuine human connection',
    'a coupon that expired in 2009',
    'the loudest possible whisper',
    'an inflatable castle',
    'my nemesis, obviously',
    'a poorly translated manual',
    'four consecutive Mondays',
    'a self-aware toaster',
    'the last surviving fax machine',
    'aggressively casual Friday',
    'a rat with a tiny hat',
    'existential dread, but fun',
    'the wrong number, twice',
    'a standing desk I never stand at',
    'my emotional range',
    'an unpaid internship in hell',
    'a slightly cursed antique',
    'the sound of my own name',
    'a dramatic reading of the terms of service',
    'one thousand rubber ducks',
    'a very serious pillow fort',
    'the concept of object permanence',
    'a lightly haunted Roomba',
    'my LinkedIn presence',
    'a suspiciously specific alibi',
    'the entire bread aisle',
    'a bureaucratic nightmare',
    'confidence unsupported by evidence',
    'a llama with excellent posture',
    'the group photo where I blinked',
    'unstructured screaming',
    'a fully catered disaster',
  ],
}

const PACKS = new Map<string, Pack>([[BASE_PACK.id, BASE_PACK]])

export function getPack(id: string): Pack | undefined {
  return PACKS.get(id)
}

export function registerPack(pack: Pack) {
  PACKS.set(pack.id, pack)
}

export function listPacks(): Array<{ id: string; name: string; prompts: number; responses: number }> {
  return [...PACKS.values()].map((p) => ({
    id: p.id,
    name: p.name,
    prompts: p.prompts.length,
    responses: p.responses.length,
  }))
}

export function buildDeck(packIds: string[]): { prompts: Prompt[]; responses: string[] } {
  const ids = packIds.length ? packIds : [BASE_PACK.id]
  const prompts: Prompt[] = []
  const responses: string[] = []
  const seenResponse = new Set<string>()

  for (const id of ids) {
    const pack = PACKS.get(id)
    if (!pack) continue
    prompts.push(...pack.prompts)
    for (const r of pack.responses) {
      if (!seenResponse.has(r)) {
        seenResponse.add(r)
        responses.push(r)
      }
    }
  }

  if (!prompts.length) prompts.push(...BASE_PACK.prompts)
  if (!responses.length) responses.push(...BASE_PACK.responses)

  return { prompts, responses }
}
