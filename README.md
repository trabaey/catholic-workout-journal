# Catholic Workout Journal

A self-hosted workout journal for a household: lifting routines with PRs and
progressive-overload tips, cardio and other activities, daily check-ins
(sleep, energy, soreness), injuries, goals, analytics, a calendar and a route
map. Every day also carries its place in the Church's liturgical year (the
feast, the season and the week), shown above that day's journal. One small
Node.js server with a SQLite database and a single-page web app.
It runs in Docker, comfortably on a Raspberry Pi, and works well as an
"Add to Home Screen" app on a phone.

Optional: sync activities, sleep and recovery data from **Garmin Connect**, or
from **Apple Health** through an iOS Shortcut.

## Quick start

You need Docker with the Compose plugin.

```sh
git clone https://github.com/trabaey/catholic-workout-journal.git
cd catholic-workout-journal
echo "TZ=America/New_York" > .env     # your time zone, see below
docker compose up -d --build
```

Then:

1. Open `http://<your machine's IP>:3000` and create your user. Each person in
   the household gets their own, picked on the device when the app starts.
2. Go to **Settings → 📚 Exercise library → Download exercise library**. This
   fetches the free [RepDB](https://repdb.co) library (~600 exercises with
   muscle tags and illustrations, about 20 MB) into your `data/` folder. The app
   works without it, but suggestions, auto-filled tags and form pictures come
   from it.
3. Add a routine under **Settings → 🏋️ Routines & exercises** and start logging.

## Configuration

| Setting | Where | What it does |
|---|---|---|
| `TZ` | `.env` beside `docker-compose.yml` | **Set this.** Every date in the app means your local calendar day. Left wrong, entries logged in the evening land on tomorrow. Any [tz database name](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones), e.g. `Europe/London`. |
| `WT_ALLOWED_HOSTS` | `environment:` in `docker-compose.yml` | The server only answers to IP addresses, `localhost` and private names (`.local`, `.lan`, `.home.arpa`, `.internal`, `.ts.net`). Add any other hostname you reach it by, comma-separated. |
| Port | `ports:` in `docker-compose.yml` | Defaults to `3000`. |
| `WT_TRAILS_API` | `environment:` in `docker-compose.yml` | The OpenStreetMap trail servers the Map tab's **Quests** mode asks, comma-separated. Set it to `off` to turn trail lookups off. If OMV manages your compose file, set it there too, since OMV regenerates the file. |

## Security: keep it on your own network

**There is no login.** Anyone who can reach the server can pick any user and
read or change their data. Run it on your home network, and reach it from
outside through a VPN (WireGuard, Tailscale, …). Never expose it directly to the
internet.

## Your data

Everything lives in `./data/`, bind-mounted into the container:

- `workout.db` is the SQLite database.
- `repdb/` holds the downloaded exercise library.
- Garmin and Apple sync credentials are per-user files, kept out of the
  database on purpose.

Rebuilding or updating the container never touches `data/`.

**Backups:**

- **Settings → 👤 Account & data** exports a JSON backup and restores from one.
- `GET /api/backup/db` streams a consistent copy of the whole database, safe to
  take while the app runs: `curl -o backup.db http://<host>:3000/api/backup/db`.
- Never copy `workout.db` directly while the app is running.

## Updating

```sh
git pull
docker compose up -d --build
```

Every change to the app needs the rebuild. Only `data/` is mounted, so the code
is baked into the image.

## Trail Quests

The Map tab's **Quests** mode lists the named trails near your home base (the
📌 pinned map view, or where most of your outings are) that you haven't
covered, or haven't covered in the last two years. It scores each trail by
how much of its length your GPS routes cover.

The trails come from [OpenStreetMap](https://www.openstreetmap.org), through
the public [Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API)
(`overpass-api.de`, with `overpass.private.coffee` as a fallback). The Pi asks
for one box about 46 km across around your home base, rounded to about 5 km.
It never sends your pin, your routes or who you are. The answer is cached in
`data/trails-*.json` for a month; delete a file to force a refetch.

A trail missing from the list is usually missing a name in OpenStreetMap.
[OpenTrailMap](https://opentrailmap.us) is a good way to see what's mapped
near you, and anyone can fix it on openstreetmap.org. Press **↻ Refresh**
under the list to pick up the change. The Pi asks OpenStreetMap again at most
once an hour per area, and says when it can next.

## Optional: Garmin Connect sync

1. Enter your Garmin email and password under **Settings → 👤 Account & data →
   Garmin**, then press **Sync**. If your account uses two-factor
   authentication, the app asks for the code.
2. After the first sign-in, a saved session is reused and your password is not
   needed again until that session expires.

To sync every morning, add a cron job on the host:

```cron
0 9 * * * docker exec workout-tracker python3 garmin_sync.py --all --unattended >> ~/garmin_sync.log 2>&1
```

`--all` syncs every user who has connected Garmin. `--unattended` never signs in
with a password from cron: when a session expires, the app shows a badge asking
you to sign in again.

## Optional: Apple Health

**Settings → 👤 Account & data → Apple Health** generates a personal sync URL to
paste into an iOS Shortcut, which posts your workouts to the app. Keep that URL
private, since it identifies you. Regenerating it revokes the old one.

## Credits and licences

- The app's own code is [MIT licensed](LICENSE).
- Exercise data by [RepDB](https://repdb.co). The library is **not** included in
  this repository: each install downloads RepDB's own published copy, under
  [RepDB's free-tier licence](https://github.com/RepDB/exercise-dataset), which
  allows in-app use with attribution but not redistribution of the dataset.
- Maps: [Leaflet](https://leafletjs.com) (BSD-2, vendored under
  `public/vendor/leaflet/`). Basemap tiles © Esri, HERE, Garmin and
  © OpenStreetMap contributors.
- Historical weather for outings: [Open-Meteo](https://open-meteo.com).
- Trail data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright)
  (ODbL), through the Overpass API. What counts as a trail follows OSM US's
  [OpenTrailMap](https://github.com/osmus/OpenTrailMap) rules (CC0).
