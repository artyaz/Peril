<script lang="ts">
  import { onMount, type Component } from 'svelte'
  import { route } from './lib/router'
  import './styles/app.css'

  let Page: Component | null = $state(null)
  let key = $state('home')
  let ready = $state(false)

  const loaders: Record<string, () => Promise<{ default: Component }>> = {
    home: () => import('./routes/Home.svelte'),
    lobby: () => import('./routes/Lobby.svelte'),
    table: () => import('./routes/Table.svelte'),
  }

  async function show(name: string) {
    const m = await loaders[name]()
    Page = m.default
    ready = true
  }

  onMount(() => {
    const warm = () => {
      void import('./routes/Home.svelte')
      void import('./routes/Lobby.svelte')
      void import('./routes/Table.svelte')
      void import('./game/TableScene')
      void import('three')
    }
    if ('requestIdleCallback' in window) requestIdleCallback(warm)
    else setTimeout(warm, 250)
  })

  $effect(() => {
    const r = $route
    key = r.name === 'home' ? 'home' : `${r.name}:${'code' in r ? r.code : ''}`
    ready = false
    void show(r.name)
  })
</script>

{#if Page && ready}
  {#key key}
    <Page />
  {/key}
{:else}
  <div class="wait" aria-hidden="true"></div>
{/if}

<style>
  .wait {
    height: 100%;
    background:
      radial-gradient(1000px 500px at 50% -10%, #fff 0%, transparent 55%),
      linear-gradient(180deg, #ececea 0%, #e2e2de 100%);
  }
</style>
