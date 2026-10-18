# ktv-epg

API EPG « sport » pour [KTV](https://github.com/vantaflow/ktv) — Cloudflare Worker.

Agrège la grille TV sport du jour depuis des sources publiques et la renvoie
**normalisée par nom de chaîne** (même algorithme que KTV), en **epochs UTC**
(le client affiche en heure locale). Sert de secours pour les chaînes sport
(beIN Sports, Canal+, Eurosport, L'Équipe…) que les fournisseurs Xtream ne
taguent pas avec un EPG.

## Endpoints

| Route | Description |
|---|---|
| `GET /sport` | `{ day, tz, source, channels: { "beinsport1": [{st,en,title}], … } }` |
| `GET /epg?channel=<nom>` | `{ channel, cur, next }` — programme en cours / suivant |
| `GET /health` | `{ ok: true }` |

`st`/`en` = epoch UTC (secondes). Les clés de chaînes sont normalisées
(`beIN SPORTS 1` → `beinsport1`, `⚽`→`o`, exposants, préfixes pays retirés…).

## Sources

- [programme-tv.nouvelobs.com/sport](https://programme-tv.nouvelobs.com/sport/) — grille du jour (HTTP simple, pas de blocage)

> SofaScore est inexploitable (403 Cloudflare / fingerprint TLS).

## Cache

Cache edge (`caches.default`) 30 min + cron `*/30` de rafraîchissement.

## Dev

```bash
wrangler dev      # local
wrangler deploy   # -> https://ktv-epg.bmwmfcknzb.workers.dev
```
