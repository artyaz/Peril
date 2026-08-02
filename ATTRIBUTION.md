# Attribution

## Third-party runtime dependencies

| Package | Licence | Use |
|---|---|---|
| [three.js](https://github.com/mrdoob/three.js) | MIT | WebGL rendering |
| [ws](https://github.com/websockets/ws) | MIT | WebSocket server |

## 3D assets

### MSN Character — *referenced, not bundled*

- **Author:** [AzaradSeraphim](https://sketchfab.com/AzaradSeraphim)
- **Source:** <https://sketchfab.com/3d-models/msn-character-7ed22e550e1145c0bcda9cd648729085>
- **Status:** `isDownloadable: false`, no licence published.

The model is **not distributed with this repository** and no copy exists in the
tree. `src/game/avatar.ts` provides a loader slot at
`public/models/msn-character.glb`; until a legitimately obtained copy is placed
there, the game renders its own procedural avatar.

If you supply the model, you are responsible for holding a licence that permits
your use. Credit the author in any public deployment.

See [`public/models/README.md`](public/models/README.md).

## Card content

The prompts and responses in `server/deck.ts` are **original content written for
this project**. They are not derived from Cards Against Humanity or any other
published deck.

Additional packs can be dropped in as JSON without touching the built-in set;
licensing of any such pack is the responsibility of whoever adds it.

## Fonts

[Inter](https://rsms.me/inter/) by Rasmus Andersson (SIL Open Font License 1.1),
loaded from Google Fonts.
