<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import { route, navigate } from '../lib/router'
  import { loadSession, saveSession } from '../lib/session'
  import type {
    RoomState,
    ServerMsg,
    ClientMsg,
    ConnectionStatus,
  } from '../lib/protocol'
  import { blankify } from '../lib/packs'
  import type { TableSceneApi } from '../game/TableScene'
  import { connectRoom, type RoomTransport } from '../lib/transport'

  const r = $route
  const code = r.name === 'table' || r.name === 'lobby' ? r.code : ''

  let session = loadSession()
  let room = $state<RoomState | null>(null)
  let error = $state('')
  let lookClose = $state(false)
  let canvasHost: HTMLDivElement | null = $state(null)
  let scene: TableSceneApi | null = null
  let transport: RoomTransport | null = null
  let hoverTimer: ReturnType<typeof setTimeout> | null = null
  let dragTimer: ReturnType<typeof setTimeout> | null = null
  let lastDragSent = 0
  let dragSequence = 0
  /** Optimistic vote while waiting for server */
  let pendingVoteId = $state<string | null>(null)
  let voteBusyId = $state<string | null>(null)
  let nextRoundBusy = $state(false)
  let stagedCount = $state(0)
  let connection = $state<ConnectionStatus>('connecting')
  let now = $state(Date.now())
  let clockTimer: ReturnType<typeof setInterval> | null = null

  const phaseLabel = $derived(
    !room ? '…' :
    room.phase === 'lobby' ? 'Lobby' :
    room.phase === 'playing' ? (
      room.players.find((p) => p.id === session?.id)?.activeThisRound === false
        ? 'Joining next round'
        :
      room.czarId === session?.id
        ? 'You are Card Czar'
        : room.submissions?.some((s) => s.playerId === session?.id)
          ? 'Waiting for others…'
          : 'Play your cards'
    ) :
    room.phase === 'voting' ? (pendingVoteId || room.votes?.[session?.id || ''] ? 'Vote locked in' : 'Vote for the funniest') :
    room.phase === 'scoring' ? 'Round result' :
    room.phase === 'ended' ? 'Game over' :
    room.phase,
  )

  const myVote = $derived.by(() => {
    if (!room || !session) return null
    return pendingVoteId || room.votes?.[session.id] || null
  })

  const voteTargetName = $derived.by(() => {
    if (!myVote || !room) return null
    const index = room.submissions.findIndex((submission) => submission.playerId === myVote)
    return index >= 0 ? `Play ${index + 1}` : 'your pick'
  })

  const iAlreadyPlayed = $derived(
    !!room && !!session && !!room.submissions?.some((s) => s.playerId === session.id),
  )

  const voteProgress = $derived.by(() => {
    if (!room || room.phase !== 'voting') return null
    return {
      cast: room.progress?.votesCast || 0,
      total: room.progress?.votersRequired || 0,
    }
  })

  const playProgress = $derived.by(() => ({
    ready: room?.progress?.submitted || 0,
    total: room?.progress?.submissionsRequired || 0,
  }))

  const scoreSeconds = $derived(
    room?.phaseEndsAt ? Math.max(0, Math.ceil((room.phaseEndsAt - now) / 1000)) : null,
  )

  onMount(() => {
    if (!session?.name) {
      navigate({ name: 'home' })
      return
    }

    const onResize = () => scene?.resize()
    window.addEventListener('resize', onResize)
    clockTimer = setInterval(() => {
      now = Date.now()
    }, 250)

    void import('../game/TableScene').then((mod) => {
      scene = mod.createTableScene()
      if (canvasHost) scene.mount(canvasHost)
      scene.onPlayCards = (cards, positions) => {
        void send({ type: 'play_cards', cards, positions }).catch(() => {
          scene?.revertStagedPlays()
        })
      }
      scene.onHoverCard = (index, text) => {
        if (hoverTimer) clearTimeout(hoverTimer)
        hoverTimer = setTimeout(() => {
          void send({
            type: 'hover_card',
            cardIndex: index,
            cardText: text ?? null,
          }).catch(() => {})
        }, 60)
      }
      scene.onDragCard = (drag) => {
        const dragNow = performance.now()
        if (!drag) {
          if (dragTimer) {
            clearTimeout(dragTimer)
            dragTimer = null
          }
          lastDragSent = dragNow
          sendDrag(null)
          return
        }
        if (dragNow - lastDragSent < 80) {
          if (dragTimer) clearTimeout(dragTimer)
          dragTimer = setTimeout(() => {
            lastDragSent = performance.now()
            dragTimer = null
            sendDrag(drag)
          }, Math.max(16, 80 - (dragNow - lastDragSent)))
          return
        }
        lastDragSent = dragNow
        sendDrag(drag)
      }
      scene.onMoveTableCard = (key, x, z, rotY) => {
        void send({ type: 'move_table_card', key, x, z, rotY }).catch(() => {})
      }
      scene.onVote = (submissionPlayerId) => void castVote(submissionPlayerId)
      scene.onStageChange = (count) => {
        stagedCount = count
      }
      if (room && session) scene.setState(room, session.id)
      connect()
    })

    return () => window.removeEventListener('resize', onResize)
  })

  onDestroy(() => {
    transport?.close()
    scene?.unmount()
    if (hoverTimer) clearTimeout(hoverTimer)
    if (dragTimer) clearTimeout(dragTimer)
    if (clockTimer) clearInterval(clockTimer)
  })

  function connect() {
    transport?.close()
    transport = connectRoom({
      playerId: session!.id,
      name: session!.name,
      roomCode: code,
      faceDataUrl: session!.faceDataUrl,
      onMessage: (msg: ServerMsg) => {
        if (msg.type === 'ip' && session) {
          saveSession({ ...session, lastIpHint: msg.ip })
        }
        if (msg.type === 'error') {
          error = msg.message
          // Play/vote failures should clear optimistic UI
          if (/vote|yourself|invalid submission/i.test(msg.message)) {
            pendingVoteId = null
          }
          if (/play|card|already|czar/i.test(msg.message)) {
            scene?.revertStagedPlays()
          }
        }
        if (msg.type === 'peer_hover') {
          scene?.setPeerHover(msg.playerId, msg.cardIndex, msg.cardText)
        }
        if (msg.type === 'peer_drag') {
          scene?.setPeerDrag(msg.drag)
        }
        if (msg.type === 'state') {
          room = msg.state
          if (msg.state.phase !== 'voting') pendingVoteId = null
          else if (session && msg.state.votes?.[session.id]) {
            pendingVoteId = msg.state.votes[session.id]
          }
          if (msg.state.phase !== 'voting') voteBusyId = null
          if (msg.state.phase !== 'scoring') nextRoundBusy = false
          if (msg.state.phase === 'lobby') {
            navigate({ name: 'lobby', code: msg.state.code })
            return
          }
          if (session) scene?.setState(msg.state, session.id)
        }
      },
      onError: (m) => {
        error = m
        if (/play|card|already|czar/i.test(m)) scene?.revertStagedPlays()
        if (/vote/i.test(m)) pendingVoteId = null
        voteBusyId = null
        if (/next/i.test(m)) nextRoundBusy = false
      },
      onStatus: (next) => {
        connection = next
        if (next === 'connected' && /reconnecting/i.test(error)) error = ''
      },
    })
  }

  function send(msg: ClientMsg) {
    return transport?.send(msg) ?? Promise.resolve(undefined)
  }

  function sendDrag(drag: Parameters<NonNullable<TableSceneApi['onDragCard']>>[0]) {
    dragSequence += 1
    void send({ type: 'drag_card', drag, sequence: dragSequence }).catch(() => {})
  }

  async function castVote(submissionPlayerId: string) {
    if (
      room?.phase !== 'voting' ||
      voteBusyId ||
      submissionPlayerId === session?.id
    ) return
    const previous = pendingVoteId
    pendingVoteId = submissionPlayerId
    voteBusyId = submissionPlayerId
    error = ''
    try {
      await send({ type: 'vote', submissionPlayerId })
    } catch {
      pendingVoteId = previous
    } finally {
      voteBusyId = null
    }
  }

  async function nextRound() {
    if (nextRoundBusy || room?.phase !== 'scoring') return
    nextRoundBusy = true
    error = ''
    try {
      await send({ type: 'next_round' })
    } catch {
      nextRoundBusy = false
    }
    // Safety: unlock if state never arrives
    setTimeout(() => {
      if (room?.phase === 'scoring') nextRoundBusy = false
    }, 2500)
  }

  function leave() {
    void send({ type: 'leave' }).finally(() => navigate({ name: 'home' }))
  }

  function winnerName(id: string | null) {
    if (!id || !room) return '…'
    return room.players.find((p: { id: string; name: string }) => p.id === id)?.name || 'Someone'
  }
</script>

<div class="table-page">
  <div class="canvas" bind:this={canvasHost}></div>

  <header class="hud top fade-in">
    <div>
      <div class="room">{room?.name || 'Peril'} · {code}</div>
      <div class="phase">{phaseLabel}</div>
    </div>
    <div class="row">
      <span class="connection" class:online={connection === 'connected'}>{connection}</span>
      <button class="ghost" type="button" onclick={leave}>Leave</button>
    </div>
  </header>

  {#if room?.blackCard}
    <div class="prompt fade-in" class:dim={lookClose}>
      {blankify(room.blackCard.text)}
      {#if room.blackCard.pick > 1}
        <span class="pick">pick {room.blackCard.pick}</span>
      {/if}
    </div>
  {/if}

  <aside class="scores fade-in">
    {#each room?.players || [] as p}
      <div
        class="score"
        class:you={p.id === session?.id}
        class:czar={p.id === room?.czarId}
        class:voted={room?.phase === 'voting' && room.votes?.[p.id]}
      >
        <span class="score-name">
          {#if p.id === room?.czarId}<span class="czar-mark" title="Card Czar">★</span>{/if}
          {p.name}
          {#if p.isBot}<small>bot</small>{/if}
        </span>
        <b>{p.score}</b>
      </div>
    {/each}
  </aside>

  {#if room?.phase === 'playing'}
    <div class="hint-stack phase-panel fade-in">
      <div class="hint phase-instruction">
        {#if room.players.find((player) => player.id === session?.id)?.activeThisRound === false}
          You’re in — watch this round, then your hand is dealt
        {:else if room.czarId === session?.id}
          You’re the Card Czar — wait while others play
        {:else if iAlreadyPlayed}
          ✓ Play locked in
        {:else if stagedCount >= (room.blackCard?.pick || 1)}
          Submitting your play…
        {:else if stagedCount > 0}
          {stagedCount}/{room.blackCard?.pick || 1} cards placed · drag the rest
        {:else if (room.blackCard?.pick || 1) > 1}
          Drag {(room.blackCard?.pick || 1)} cards onto the table
        {:else}
          Drag one card onto the table to play
        {/if}
      </div>
      <div class="phase-progress" aria-label={`${playProgress.ready} of ${playProgress.total} plays ready`}>
        <span style:width={`${playProgress.total ? (playProgress.ready / playProgress.total) * 100 : 0}%`}></span>
      </div>
      <div class="hint-sub">
        {playProgress.ready}/{playProgress.total} plays ready
        {#if !iAlreadyPlayed && room.czarId !== session?.id && stagedCount === 0}
          · grab any card and move it onto the table
        {/if}
      </div>
    </div>
  {/if}

  {#if room?.phase === 'voting'}
    <section class="vote-dock fade-in" class:voted-ok={!!myVote} aria-label="Vote for a play">
      <div class="vote-copy">
        <div class="hint vote-title">
          {#if voteBusyId}
            Sending vote…
          {:else if myVote}
            ✓ {voteTargetName} selected
          {:else}
            Pick the funniest play
          {/if}
        </div>
        <div class="hint-sub">
          {voteProgress?.cast || 0}/{voteProgress?.total || 0} voted · you can change your pick
        </div>
      </div>
      <div class="vote-options">
        {#each room.submissions as submission, index (submission.id)}
          <button
            type="button"
            class="vote-option"
            class:selected={myVote === submission.playerId}
            class:own={submission.playerId === session?.id}
            disabled={submission.playerId === session?.id || !!voteBusyId}
            aria-pressed={myVote === submission.playerId}
            onclick={() => castVote(submission.playerId)}
          >
            <span class="vote-number">
              Play {index + 1}
              {#if myVote === submission.playerId}<b>✓</b>{/if}
            </span>
            <span class="vote-text">{submission.cards.join(' · ')}</span>
            {#if submission.playerId === session?.id}<span class="vote-own">your play</span>{/if}
          </button>
        {/each}
      </div>
    </section>
  {/if}

  {#if room?.phase === 'scoring'}
    <div class="banner fade-in">
      <div class="banner-kicker">Most votes</div>
      <div class="banner-title">{winnerName(room.winnerId)} wins the round</div>
      <div class="banner-sub">
        +1 point · next round {scoreSeconds === null ? 'soon' : `in ${scoreSeconds}s`}
      </div>
      {#if room.hostId === session?.id}
        <button
          class="primary"
          type="button"
          disabled={nextRoundBusy}
          onclick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            nextRound()
          }}
        >
          {nextRoundBusy ? 'Starting…' : 'Start now'}
        </button>
      {/if}
    </div>
  {/if}

  {#if room?.phase === 'ended'}
    <div class="banner fade-in">
      <div class="banner-title">{winnerName(
        [...(room.players)].sort((a: { score: number; id: string }, b: { score: number; id: string }) => b.score - a.score)[0]?.id || null,
      )} wins</div>
      <button onclick={leave}>Leave table</button>
    </div>
  {/if}

  {#if error}
    <div class="err">{error}</div>
  {/if}
</div>

<style>
  .table-page {
    position: relative;
    height: 100%;
    overflow: hidden;
    background: #e6e6e2;
  }
  .canvas {
    position: absolute;
    inset: 0;
  }
  .hud {
    position: absolute;
    z-index: 2;
    left: 0;
    right: 0;
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    padding: 1rem 1.25rem;
    pointer-events: none;
  }
  .hud .row, .hud button { pointer-events: auto; }
  .scores {
    position: absolute;
    z-index: 2;
    right: 1rem;
    top: 50%;
    transform: translateY(-50%);
    display: grid;
    gap: 0.4rem;
    pointer-events: none;
  }
  .hint-stack {
    position: absolute;
    z-index: 2;
    bottom: 0.85rem;
    left: 50%;
    transform: translateX(-50%);
    text-align: center;
    pointer-events: none;
    display: grid;
    gap: 0.25rem;
    width: min(28rem, calc(100% - 2rem));
  }
  .hint-stack.fade-in,
  .vote-dock.fade-in {
    animation: tablePanelIn 420ms var(--ease-out) both;
  }
  .banner.fade-in {
    animation: tableBannerIn 420ms var(--ease-out) both;
  }
  @keyframes tablePanelIn {
    from { opacity: 0; transform: translate(-50%, 10px); }
    to { opacity: 1; transform: translate(-50%, 0); }
  }
  @keyframes tableBannerIn {
    from { opacity: 0; transform: translate(-50%, calc(-50% + 10px)); }
    to { opacity: 1; transform: translate(-50%, -50%); }
  }
  .phase-panel {
    padding: 0.8rem 1rem;
    border: 1px solid rgba(200, 200, 196, 0.72);
    border-radius: 18px;
    background: rgba(250, 250, 248, 0.9);
    backdrop-filter: blur(10px);
    box-shadow: 0 12px 32px rgba(40, 40, 36, 0.12);
  }
  .phase-instruction {
    font-family: "Instrument Serif", Georgia, serif;
    font-size: 1.12rem;
  }
  .phase-progress {
    width: 100%;
    height: 4px;
    overflow: hidden;
    border-radius: 99px;
    background: rgba(42, 42, 40, 0.1);
  }
  .phase-progress span {
    display: block;
    height: 100%;
    min-width: 2px;
    border-radius: inherit;
    background: #3d6b49;
    transition: width 320ms var(--ease-out);
  }
  .vote-dock {
    position: absolute;
    z-index: 12;
    left: 50%;
    bottom: 0.75rem;
    transform: translateX(-50%);
    width: min(58rem, calc(100% - 2rem));
    padding: 0.8rem;
    border: 1px solid rgba(200, 200, 196, 0.8);
    border-radius: 20px;
    background: rgba(250, 250, 248, 0.94);
    backdrop-filter: blur(14px);
    box-shadow: 0 18px 48px rgba(40, 40, 36, 0.16);
    pointer-events: auto;
  }
  .vote-dock.voted-ok {
    border-color: rgba(55, 120, 72, 0.35);
  }
  .vote-copy {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    align-items: baseline;
    padding: 0.05rem 0.25rem 0.65rem;
  }
  .vote-options {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
    gap: 0.55rem;
  }
  .vote-option {
    position: relative;
    display: grid;
    align-content: start;
    gap: 0.35rem;
    min-height: 5.7rem;
    padding: 0.7rem 0.8rem;
    border-radius: 14px;
    text-align: left;
    background: rgba(255, 255, 253, 0.86);
    box-shadow: none;
  }
  .vote-option:hover:not(:disabled) {
    border-color: #85857f;
    box-shadow: 0 8px 20px rgba(40, 40, 36, 0.1);
  }
  .vote-option.selected {
    border-color: #347148;
    background: #e8f3ea;
    box-shadow: 0 0 0 2px rgba(52, 113, 72, 0.14);
  }
  .vote-option.own {
    opacity: 0.55;
    cursor: not-allowed;
  }
  .vote-number {
    display: flex;
    justify-content: space-between;
    color: var(--mute);
    font-size: 0.7rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .vote-number b { color: #2f6b3d; }
  .vote-text {
    font-size: 0.83rem;
    line-height: 1.28;
  }
  .vote-own {
    color: var(--mute);
    font-size: 0.68rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .hint {
    color: var(--ink);
    font-size: 0.95rem;
    letter-spacing: 0.01em;
    pointer-events: none;
  }
  .hint.vote-title {
    font-family: "Instrument Serif", Georgia, serif;
    font-size: 1.25rem;
  }
  .hint-sub {
    color: var(--mute);
    font-size: 0.8rem;
    letter-spacing: 0.02em;
  }
  .prompt {
    pointer-events: none;
  }
  .room {
    font-size: 0.8rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--mute);
  }
  .connection {
    align-self: center;
    padding: 0.35rem 0.55rem;
    border-radius: 999px;
    background: rgba(250, 250, 248, 0.72);
    color: #956b32;
    font-size: 0.7rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .connection.online { color: #2f6b3d; }
  .phase {
    font-family: "Instrument Serif", Georgia, serif;
    font-size: 1.6rem;
    margin-top: 0.15rem;
  }
  .ghost {
    background: rgba(250, 250, 248, 0.72);
    backdrop-filter: blur(8px);
    box-shadow: 0 8px 24px var(--shadow);
  }
  .prompt {
    position: absolute;
    z-index: 2;
    top: 4.75rem;
    left: 1.25rem;
    right: auto;
    transform: none;
    width: min(22rem, calc(100% - 11rem));
    text-align: left;
    font-family: "Instrument Serif", Georgia, serif;
    font-size: clamp(1.05rem, 2.4vw, 1.35rem);
    line-height: 1.3;
    color: var(--ink);
    text-shadow: 0 1px 0 rgba(255,255,255,.5);
    pointer-events: none;
    transition: opacity 280ms ease;
    padding: 0.55rem 0.75rem;
    border-radius: 12px;
    background: rgba(250, 250, 248, 0.72);
    backdrop-filter: blur(8px);
  }
  .prompt.dim { opacity: 0.4; }
  .pick {
    display: inline-block;
    margin-left: 0.5rem;
    font-family: "DM Sans", system-ui, sans-serif;
    font-size: 0.75rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--mute);
    vertical-align: middle;
  }
  .score {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    min-width: 8.5rem;
    padding: 0.5rem 0.75rem;
    border-radius: 14px;
    background: rgba(250, 250, 248, 0.78);
    backdrop-filter: blur(8px);
    font-size: 0.85rem;
    box-shadow: 0 6px 18px var(--shadow);
    transition: outline-color 200ms ease, background 200ms ease;
  }
  .score-name {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    min-width: 0;
  }
  .score-name small {
    color: var(--mute);
    font-size: 0.62rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .czar-mark {
    color: var(--mute);
    font-size: 0.75rem;
  }
  .score.you { outline: 1px solid rgba(42,42,40,.28); }
  .score.voted {
    background: rgba(232, 240, 248, 0.9);
  }
  .score.czar b::after {
    content: none;
  }
  .banner {
    position: absolute;
    z-index: 20;
    left: 50%;
    top: 42%;
    transform: translate(-50%, -50%);
    text-align: center;
    padding: 1.5rem 1.75rem;
    border-radius: 20px;
    background: rgba(250, 250, 248, 0.94);
    backdrop-filter: blur(12px);
    box-shadow: 0 24px 60px rgba(40,40,36,.12);
    display: grid;
    gap: 0.55rem;
    justify-items: center;
    pointer-events: auto;
  }
  .banner button {
    pointer-events: auto;
    min-width: 10rem;
  }
  .banner button:disabled {
    opacity: 0.65;
    cursor: wait;
  }
  .banner-kicker {
    font-size: 0.72rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--mute);
  }
  .banner-title {
    font-family: "Instrument Serif", Georgia, serif;
    font-size: 1.8rem;
  }
  .banner-sub {
    color: var(--mute);
    font-size: 0.88rem;
    margin-bottom: 0.4rem;
  }
  .err {
    position: absolute;
    z-index: 4;
    top: 5.2rem;
    bottom: auto;
    left: 50%;
    transform: translateX(-50%);
    color: #8a3a32;
    background: rgba(250,250,248,.9);
    padding: 0.5rem 0.9rem;
    border-radius: 999px;
  }
  @media (max-width: 760px) {
    .scores {
      top: 5rem;
      right: 0.5rem;
      transform: none;
    }
    .score {
      min-width: 6.5rem;
      padding: 0.38rem 0.55rem;
    }
    .vote-dock {
      width: calc(100% - 1rem);
      bottom: 0.5rem;
    }
    .vote-copy {
      display: grid;
      gap: 0.2rem;
    }
    .vote-options {
      display: flex;
      overflow-x: auto;
      padding-bottom: 0.15rem;
    }
    .vote-option {
      flex: 0 0 11rem;
    }
  }
</style>
