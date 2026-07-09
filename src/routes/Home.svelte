<script lang="ts">
  import { onMount } from 'svelte'
  import { navigate } from '../lib/router'
  import { loadSession, saveSession, makePlayerId, makeRoomCode, recentRooms, rememberRoom } from '../lib/session'

  let name = $state(loadSession()?.name || '')
  let joinCode = $state('')
  let roomName = $state('Living Room')
  let recent = $state(recentRooms())
  let busy = $state(false)
  let error = $state('')

  onMount(() => {
    // Prefetch pack index quietly
    void fetch('/data/packs-index.json')
  })

  async function createRoom() {
    error = ''
    if (!name.trim()) {
      error = 'Pick a name first'
      return
    }
    busy = true
    try {
      const playerId = loadSession()?.id || makePlayerId()
      const code = makeRoomCode()
      saveSession({
        id: playerId,
        name: name.trim().slice(0, 24),
        roomCode: code,
        createdAt: Date.now(),
        faceDataUrl: loadSession()?.faceDataUrl,
      })
      rememberRoom(code, roomName.trim() || 'Untitled')
      const res = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: roomName.trim() || 'Untitled',
          hostId: playerId,
          packIds: ['cah-base-set'],
          maxPlayers: 4,
          code,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not create room')
      navigate({ name: 'lobby', code: data.code })
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed'
    } finally {
      busy = false
    }
  }

  function joinRoom(code?: string) {
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
    const playerId = loadSession()?.id || makePlayerId()
    saveSession({
      id: playerId,
      name: name.trim().slice(0, 24),
      roomCode: c,
      createdAt: Date.now(),
      faceDataUrl: loadSession()?.faceDataUrl,
    })
    rememberRoom(c, recent.find((r) => r.code === c)?.name || c)
    navigate({ name: 'lobby', code: c })
  }
</script>

<div class="page">
  <div class="shell fade-in">
    <h1 class="brand">Peril</h1>
    <p class="lede">A minimal table for terrible people. No accounts — just a code, a name, and bad decisions.</p>

    <div class="panel stack" style="max-width: 28rem">
      <div class="field">
        <label for="name">Your name</label>
        <input id="name" maxlength="24" placeholder="Something regrettable" bind:value={name} />
      </div>

      <div class="field">
        <label for="room">New room name</label>
        <input id="room" maxlength="40" placeholder="Living Room" bind:value={roomName} />
      </div>

      <div class="row">
        <button class="primary" disabled={busy} onclick={createRoom}>Create room</button>
      </div>

      <div class="divider"></div>

      <div class="field">
        <label for="code">Join with code</label>
        <div class="row">
          <input id="code" maxlength="8" placeholder="AB12C" bind:value={joinCode} style="flex:1; text-transform:uppercase; letter-spacing:.12em" />
          <button onclick={() => joinRoom()}>Join</button>
        </div>
      </div>

      {#if recent.length}
        <div class="muted">Recent</div>
        <div class="row">
          {#each recent as r}
            <button class="ghost" onclick={() => joinRoom(r.code)}>{r.code}</button>
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
  .divider {
    height: 1px;
    background: var(--line);
    margin: 0.4rem 0;
  }
  .ghost {
    background: transparent;
    font-size: 0.85rem;
    padding: 0.45rem 0.85rem;
    letter-spacing: 0.08em;
  }
  .err {
    color: #8a3a32;
    margin: 0;
    font-size: 0.9rem;
  }
</style>
