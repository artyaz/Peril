<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import { route, navigate } from '../lib/router'
  import { loadSession, saveSession } from '../lib/session'
  import { loadPackIndex, type PackMeta } from '../lib/packs'
  import { wsUrl, type RoomState, type ServerMsg, type ClientMsg } from '../lib/protocol'

  const r = $route
  const code = r.name === 'lobby' || r.name === 'table' ? r.code : ''

  let session = loadSession()
  let room = $state<RoomState | null>(null)
  let error = $state('')
  let packs = $state<PackMeta[]>([])
  let selected = $state<string[]>(['cah-base-set'])
  let filter = $state('')
  let showAll = $state(false)
  let ws: WebSocket | null = null
  let facePreview = $state(session?.faceDataUrl || '')

  const isHost = $derived(!!room && !!session && room.hostId === session.id)

  onMount(async () => {
    if (!session?.name) {
      navigate({ name: 'home' })
      return
    }
    const index = await loadPackIndex()
    packs = index.all
    connect()
  })

  onDestroy(() => {
    ws?.close()
  })

  function connect() {
    ws?.close()
    ws = new WebSocket(wsUrl())
    ws.onopen = () => {
      const msg: ClientMsg = {
        type: 'hello',
        playerId: session!.id,
        name: session!.name,
        faceDataUrl: session!.faceDataUrl,
        roomCode: code,
        create: false,
      }
      ws!.send(JSON.stringify(msg))
    }
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data) as ServerMsg
      if (msg.type === 'ip' && session) {
        saveSession({ ...session, lastIpHint: msg.ip })
      }
      if (msg.type === 'error') error = msg.message
      if (msg.type === 'state') {
        room = msg.state
        selected = msg.state.packIds
        if (msg.state.phase !== 'lobby') {
          navigate({ name: 'table', code: msg.state.code })
        }
      }
    }
    ws.onclose = () => {
      setTimeout(() => {
        if (document.visibilityState !== 'hidden') connect()
      }, 1200)
    }
  }

  function send(msg: ClientMsg) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }

  function togglePack(id: string) {
    if (!isHost) return
    const next = selected.includes(id) ? selected.filter((x: string) => x !== id) : [...selected, id]
    if (!next.length) return
    selected = next
    send({ type: 'set_packs', packIds: next })
  }

  function start() {
    send({ type: 'start' })
  }

  function onFace(e: Event) {
    const input = e.target as HTMLInputElement
    const file = input.files?.[0]
    if (!file || !session) return
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = String(reader.result || '')
      // Downscale for network
      const img = new Image()
      img.onload = () => {
        const canvas = document.createElement('canvas')
        const size = 256
        canvas.width = size
        canvas.height = size
        const ctx = canvas.getContext('2d')!
        // Cover crop
        const scale = Math.max(size / img.width, size / img.height)
        const w = img.width * scale
        const h = img.height * scale
        ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h)
        const out = canvas.toDataURL('image/jpeg', 0.72)
        facePreview = out
        saveSession({ ...session!, faceDataUrl: out })
        session = loadSession()
        send({ type: 'set_face', faceDataUrl: out })
      }
      img.src = dataUrl
    }
    reader.readAsDataURL(file)
  }

  const visiblePacks = $derived(
    packs
      .filter((p: PackMeta) => (showAll ? true : p.official))
      .filter((p: PackMeta) => !filter || p.name.toLowerCase().includes(filter.toLowerCase()))
      .slice(0, 120),
  )
</script>

<div class="page">
  <div class="shell fade-in">
    <div class="top">
      <div>
        <h1 class="brand" style="font-size: clamp(2.2rem, 6vw, 3.4rem)">Room {code}</h1>
        <p class="lede" style="margin-bottom: 1.5rem">{room?.name || '…'} · share the code · no login</p>
      </div>
      <button onclick={() => navigate({ name: 'home' })}>Leave</button>
    </div>

    <div class="grid">
      <section class="panel stack">
        <div class="muted">Players · {room?.players.length || 0}/{room?.maxPlayers || 4}</div>
        {#each room?.players || [] as p}
          <div class="player">
            <div class="avatar" style:background-image={p.faceDataUrl ? `url(${p.faceDataUrl})` : 'none'}></div>
            <div>
              <div>{p.name}{#if p.isHost}<span class="tag">host</span>{/if}</div>
              <div class="muted">{p.connected ? 'here' : 'away'}</div>
            </div>
          </div>
        {:else}
          <div class="muted">Connecting…</div>
        {/each}

        <div class="field" style="margin-top: .5rem">
          <label for="face">Stretch a photo on your face</label>
          <input id="face" type="file" accept="image/*" onchange={onFace} />
        </div>
        {#if facePreview}
          <div class="face-preview" style:background-image={`url(${facePreview})`}></div>
        {/if}

        {#if isHost}
          <div class="row">
            <button type="button" onclick={() => send({ type: 'add_bot' })}>Add bot</button>
            <button class="primary" type="button" onclick={start}>Start game</button>
          </div>
          <p class="muted">Solo works — start seats bots so you can play alone.</p>
        {:else}
          <p class="muted">Waiting for host…</p>
        {/if}
        {#if error}<p class="err">{error}</p>{/if}
      </section>

      <section class="panel stack">
        <div class="row" style="justify-content: space-between">
          <div class="muted">Packs · {selected.length} selected · 71 official + fan</div>
          <button class="ghost" onclick={() => (showAll = !showAll)}>{showAll ? 'Official only' : 'Show all'}</button>
        </div>
        <input placeholder="Filter packs" bind:value={filter} disabled={!isHost} />
        <div class="packs">
          {#each visiblePacks as p}
            <button
              class="pack"
              class:on={selected.includes(p.id)}
              disabled={!isHost}
              onclick={() => togglePack(p.id)}
            >
              <span>{p.name}</span>
              <span class="muted">{p.w}/{p.b}{#if !p.official} · fan{/if}</span>
            </button>
          {/each}
        </div>
      </section>
    </div>
  </div>
</div>

<style>
  .top {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    align-items: flex-start;
  }
  .grid {
    display: grid;
    grid-template-columns: minmax(240px, 320px) 1fr;
    gap: 1rem;
  }
  @media (max-width: 800px) {
    .grid { grid-template-columns: 1fr; }
  }
  .player {
    display: flex;
    gap: 0.75rem;
    align-items: center;
  }
  .avatar {
    width: 40px;
    height: 40px;
    border-radius: 50%;
    background: #d4d4d0 center/cover;
    box-shadow: inset 0 -10px 16px rgba(0,0,0,.08);
  }
  .tag {
    margin-left: 0.4rem;
    font-size: 0.7rem;
    color: var(--mute);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .face-preview {
    width: 72px;
    height: 72px;
    border-radius: 50%;
    background: #ccc center/cover;
    box-shadow: 0 10px 24px var(--shadow);
  }
  .packs {
    display: grid;
    gap: 0.4rem;
    max-height: 52vh;
    overflow: auto;
    padding-right: 0.25rem;
  }
  .pack {
    display: flex;
    justify-content: space-between;
    gap: 0.75rem;
    text-align: left;
    border-radius: 12px;
    padding: 0.65rem 0.85rem;
    background: transparent;
    box-shadow: none;
  }
  .pack.on {
    background: var(--ink);
    color: var(--bg-soft);
    border-color: var(--ink);
  }
  .pack.on .muted { color: rgba(232,232,226,.7); }
  .ghost {
    background: transparent;
    box-shadow: none;
    padding: 0.35rem 0.7rem;
    font-size: 0.8rem;
  }
  .err { color: #8a3a32; margin: 0; }
</style>
