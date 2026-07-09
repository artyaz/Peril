import './styles/boot.css'

const appRoot = document.getElementById('app')!

async function boot() {
  // Dynamic-only graph: svelte runtime + App shell load after first paint shell.
  const [{ mount }, { default: App }] = await Promise.all([
    import('svelte'),
    import('./App.svelte'),
  ])
  mount(App, { target: appRoot })
  requestAnimationFrame(() => {
    const bootEl = document.getElementById('boot')
    if (!bootEl) return
    bootEl.classList.add('gone')
    setTimeout(() => bootEl.remove(), 450)
  })
}

void boot()
