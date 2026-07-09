<script lang="ts">
  import { onMount } from 'svelte'
  import { navigate } from '../lib/router'
  import { loadSession, saveSession, makePlayerId, makeRoomCode, recentRooms, rememberRoom } from '../lib/session'
  import { createRoomHttp, joinRoomHttp } from '../lib/transport'

  let name = $state(loadSession()?.name || '')
  let joinCode = $state('')
  let roomName = $state('Living Room')
  let recent = $state(recentRooms())
  let busy = $state<'create' | 'join' | null>(null)
  let error = $state('')

  onMount(() => {
    void fetch('/data/packs-index.json')
  })

  async function createRoom() {
    error = ''
    if (!name.trim()) {
      error = 'Pick a name first'
      return
    }
    busy = 'create'
    try {
      const playerId = loadSession()?.id || makePlayerId()
      const code = makeRoomCode()
      const data = await createRoomHttp({
        name: roomName.trim() || 'Untitled',
        hostId: playerId,
        playerName: name.trim().slice(0, 24),
        packIds: ['cah-base-set'],
        code,
        faceDataUrl: loadSession()?.faceDataUrl,
      })
      saveSession({
        id: playerId,
        name: name.trim().slice(0, 24),
        roomCode: data.code,
        createdAt: Date.now(),
        faceDataUrl: loadSession()?.faceDataUrl,
      })
      rememberRoom(data.code, data.name)
      navigate({ name: 'lobby', code: data.code })
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed'
    } finally {
      busy = null
    }
  }

  async function joinRoom(code?: string) {
    error = ''
    const c = (code || joinCode).trim().toUpperCase()
    if (!name.trim()) {
      error = 'Pick a name first'
      return
    }
    if (c.length < 4) {
      error = 'Enter a room code'
      return
    }
    busy = 'join'
    try {
      const current = loadSession()
      const playerId = current?.id || makePlayerId()
      const cleanName = name.trim().slice(0, 24)
      const data = await joinRoomHttp({
        code: c,
        playerId,
        name: cleanName,
        faceDataUrl: current?.faceDataUrl,
      })
      saveSession({
        id: playerId,
        name: cleanName,
        roomCode: data.code,
        createdAt: Date.now(),
        faceDataUrl: current?.faceDataUrl,
      })
      rememberRoom(data.code, data.state.name)
      navigate({ name: data.state.phase === 'lobby' ? 'lobby' : 'table', code: data.code })
    } catch (e) {
      error = e instanceof Error ? e.message : 'Could not join room'
    } finally {
      busy = null
    }
  }
</script>

<div class="page">
  <div class="shell fade-in home">
    <header class="hero">
      <h1 class="brand">Peril</h1>
      <p class="lede">A minimal table for terrible people. No accounts — just a code, a name, and bad decisions.</p>
    </header>

    <div class="panel stack form">
      <div class="field">
        <label for="name">Your name</label>
        <input id="name" maxlength="24" placeholder="Something regrettable" bind:value={name} />
      </div>

      <div class="field">
        <label for="room">New room name</label>
        <input id="room" maxlength="40" placeholder="Living Room" bind:value={roomName} />
      </div>

      <button class="primary wide" disabled={!!busy} onclick={createRoom}>
        {busy === 'create' ? 'Creating…' : 'Create room'}
      </button>

      <div class="or"><span>or join</span></div>

      <div class="field">
        <label for="code">Room code</label>
        <div class="row join">
          <input
            id="code"
            maxlength="8"
            placeholder="AB12C"
            bind:value={joinCode}
            class="code"
            disabled={!!busy}
            onkeydown={(event) => {
              if (event.key === 'Enter') void joinRoom()
            }}
          />
          <button type="button" disabled={!!busy} onclick={() => joinRoom()}>
            {busy === 'join' ? 'Checking…' : 'Join'}
          </button>
        </div>
      </div>

      {#if recent.length}
        <div class="muted recent-label">Recent</div>
        <div class="row chips">
          {#each recent as r}
            <button type="button" class="chip" disabled={!!busy} onclick={() => joinRoom(r.code)}>{r.code}</button>
          {/each}
        </div>
      {/if}

      {#if error}
        <p class="err">{error}</p>
      {/if}
    </div>
  </div>
</div>

<style>
  .home {
    display: grid;
    align-content: center;
    min-height: 100%;
    gap: 0;
  }
  .hero {
    margin-bottom: 2rem;
  }
  .form {
    max-width: 26rem;
  }
  .wide {
    width: 100%;
  }
  .or {
    display: grid;
    place-items: center;
    position: relative;
    color: var(--mute);
    font-size: 0.78rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    margin: 0.25rem 0;
  }
  .or::before {
    content: '';
    position: absolute;
    inset: 50% 0 auto;
    height: 1px;
    background: var(--line);
  }
  .or span {
    position: relative;
    background: rgba(250, 250, 248, 0.95);
    padding: 0 0.65rem;
  }
  .join {
    width: 100%;
  }
  .code {
    flex: 1;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    font-variant-numeric: tabular-nums;
  }
  .chips {
    gap: 0.5rem;
  }
  .chip {
    background: transparent;
    box-shadow: none;
    font-size: 0.82rem;
    padding: 0.45rem 0.8rem;
    letter-spacing: 0.1em;
  }
  .recent-label {
    margin-top: 0.25rem;
  }
  .err {
    color: #8a3a32;
    margin: 0;
    font-size: 0.9rem;
    line-height: 1.4;
  }
</style>
