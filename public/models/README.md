# Avatar models

## `msn-character.glb` — not included

The **MSN Character** model by
[AzaradSeraphim](https://sketchfab.com/AzaradSeraphim) referenced for this
project cannot be committed here:

```
GET https://api.sketchfab.com/v3/models/7ed22e550e1145c0bcda9cd648729085
  → "isDownloadable": false
  → "license": {}
```

The author has not enabled downloads and has not attached a licence, so there
is no legitimate way to fetch, redistribute, or vendor the asset. Sketchfab's
embed viewer is the only sanctioned way to display it, and an iframe cannot be
used as geometry inside our own WebGL scene.

**No substitute model has been silently swapped in.** The avatar pipeline is
built and waiting for this exact file.

## Enabling it

1. Obtain the asset legitimately — either the author enables downloads on the
   Sketchfab page, or you arrange a direct licence with them.
2. Export/convert to glTF-binary and save it here as **`msn-character.glb`**.
3. Reload. `src/game/avatar.ts` picks it up automatically; no code change.

To point at a different filename or a CDN, change `AVATAR_MODEL_URL` in
`src/game/avatar.ts`.

## What happens until then

Every seat renders the **procedural fallback** avatar (lathed torso, spherical
head, directional eyes, per-player hue). The game is fully playable and the
netcode is fully testable in this state — the model is cosmetic.

## What the loader expects

The loader is written against this model's actual properties, read from the
Sketchfab API:

| Property   | Value                      | Consequence for the loader                          |
|------------|----------------------------|-----------------------------------------------------|
| Triangles  | 2,656                      | Cheap enough to clone per seat with no LOD needed    |
| Vertices   | 1,357                      | —                                                    |
| Animations | 0                          | Idle motion is applied procedurally, not via clips   |
| Rig        | none published             | Head look-at falls back to the whole mesh if no bone |

On load the model is automatically:

- **normalised in scale** to a 0.72 m seated torso (authored units are not
  trusted),
- **re-origined** so its feet sit on the seat plane and it is centred in X/Z,
- given `castShadow` / `receiveShadow`,
- **material-cloned per seat**, so per-player tinting cannot bleed across seats.

If the mesh contains a node matching `/head|neck|skull/i`, that node is driven
by the remote player's head yaw/pitch. Otherwise the whole model turns.
