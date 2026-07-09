<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import { route, navigate } from '../lib/router'
  import { loadSession, saveSession } from '../lib/session'
  import type { RoomState, ServerMsg, ClientMsg } from '../lib/protocol'
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

  const phaseLabel = $derived(
    !room ? '…' :
    room.phase === 'lobby' ? 'Lobby' :
    room.phase === 'playing' ? (room.czarId === session?.id ? 'You are Card Czar' : 'Play your cards') :
    room.phase === 'voting' ? 'Vote for the best' :
    room.phase === 'scoring' ? 'Round result' :
    room.phase === 'ended' ? 'Game over' :
    room.phase,
  )

  onMount(() => {
    if (!session?.name) {
      navigate({ name: 'home' })
      return
    }

    const onResize = () => scene?.resize()
    window.addEventListener('resize', onResize)

    void import('../game/TableScene').then((mod) => {
      scene = mod.createTableScene()
      if (canvasHost) scene.mount(canvasHost)
      scene.onPlayCards = (cards) => send({ type: 'play_cards', cards })
      scene.onHoverCard = (index) => {
        if (hoverTimer) clearTimeout(hoverTimer)
        hoverTimer = setTimeout(() => send({ type: 'hover_card', cardIndex: index }), 40)
      }
      scene.onVote = (submissionPlayerId) => send({ type: 'vote', submissionPlayerId })
      if (room && session) scene.setState(room, session.id)
      connect()
    })

    return () => window.removeEventListener('resize', onResize)
  })

  onDestroy(() => {
    transport?.close()
    scene?.unmount()
    if (hoverTimer) clearTimeout(hoverTimer)
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
        if (msg.type === 'error') error = msg.message
        if (msg.type === 'peer_hover') {
          scene?.setPeerHover(msg.playerId, msg.cardIndex)
        }
        if (msg.type === 'state') {
          room = msg.state
          if (msg.state.phase === 'lobby') {
            navigate({ name: 'lobby', code: msg.state.code })
            return
          }
          if (session) scene?.setState(msg.state, session.id)
        }
      },
      onError: (m) => { error = m },
    })
  }

  function send(msg: ClientMsg) {
    transport?.send(msg)
  }

  function toggleLook() {
    lookClose = !lookClose
    scene?.lookCloser(lookClose)
  }

  function nextRound() {
    send({ type: 'next_round' })
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
      <button class="ghost" onclick={toggleLook}>{lookClose ? 'Sit back' : 'Look closer'}</button>
      <button class="ghost" onclick={() => navigate({ name: 'home' })}>Leave</button>
    </div>
  </header>

  {#if room?.blackCard && !lookClose}
    <div class="prompt fade-in">
      {blankify(room.blackCard.text)}
      {#if room.blackCard.pick > 1}
        <span class="pick">pick {room.blackCard.pick}</span>
      {/if}
    </div>
  {/if}

  <aside class="scores fade-in">
    {#each room?.players || [] as p}
      <div class="score" class:you={p.id === session?.id} class:czar={p.id === room?.czarId}>
        <span>{p.name}</span>
        <b>{p.score}</b>
      </div>
    {/each}
  </aside>

  {#if room?.phase === 'playing'}
    <div class="hint">{room.czarId === session?.id ? 'Waiting for plays…' : 'Hover to peek · click to play'}</div>
  {/if}

  {#if room?.phase === 'voting'}
    <div class="hint">Look closer · click a submission · everyone votes</div>
  {/if}

  {#if room?.phase === 'scoring'}
    <div class="banner fade-in">
      <div class="banner-title">{winnerName(room.winnerId)} wins the round</div>
      <button class="primary" onclick={nextRound}>Next round</button>
    </div>
  {/if}

  {#if room?.phase === 'ended'}
    <div class="banner fade-in">
      <div class="banner-title">{winnerName(
        [...(room.players)].sort((a: { score: number; id: string }, b: { score: number; id: string }) => b.score - a.score)[0]?.id || null,
      )} wins</div>
      <button onclick={() => navigate({ name: 'lobby', code })}>Back to lobby</button>
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
  .room {
    font-size: 0.8rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--mute);
  }
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
    top: 5.5rem;
    left: 50%;
    transform: translateX(-50%);
    width: min(36rem, calc(100% - 2rem));
    text-align: center;
    font-family: "Instrument Serif", Georgia, serif;
    font-size: clamp(1.2rem, 3vw, 1.7rem);
    line-height: 1.25;
    color: var(--ink);
    text-shadow: 0 1px 0 rgba(255,255,255,.5);
    pointer-events: none;
  }
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
  .scores {
    position: absolute;
    z-index: 2;
    right: 1rem;
    top: 50%;
    transform: translateY(-50%);
    display: grid;
    gap: 0.4rem;
  }
  .score {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    min-width: 8rem;
    padding: 0.45rem 0.7rem;
    border-radius: 999px;
    background: rgba(250, 250, 248, 0.7);
    backdrop-filter: blur(8px);
    font-size: 0.85rem;
    box-shadow: 0 6px 18px var(--shadow);
  }
  .score.you { outline: 1px solid rgba(42,42,40,.25); }
  .score.czar b::after {
    content: ' ★';
    font-weight: 400;
    color: var(--mute);
  }
  .hint {
    position: absolute;
    z-index: 2;
    bottom: 1.1rem;
    left: 50%;
    transform: translateX(-50%);
    color: var(--mute);
    font-size: 0.85rem;
    letter-spacing: 0.02em;
    pointer-events: none;
  }
  .banner {
    position: absolute;
    z-index: 3;
    left: 50%;
    top: 42%;
    transform: translate(-50%, -50%);
    text-align: center;
    padding: 1.5rem 1.75rem;
    border-radius: 20px;
    background: rgba(250, 250, 248, 0.88);
    backdrop-filter: blur(12px);
    box-shadow: 0 24px 60px rgba(40,40,36,.12);
    display: grid;
    gap: 1rem;
    justify-items: center;
  }
  .banner-title {
    font-family: "Instrument Serif", Georgia, serif;
    font-size: 1.8rem;
  }
  .err {
    position: absolute;
    z-index: 4;
    bottom: 3rem;
    left: 50%;
    transform: translateX(-50%);
    color: #8a3a32;
    background: rgba(250,250,248,.9);
    padding: 0.5rem 0.9rem;
    border-radius: 999px;
  }
</style>
