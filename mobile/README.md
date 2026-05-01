# Voice AI Tech — Technician Mobile App

An Expo (React Native) app for field technicians. It connects to the existing
admin-api using a tenant API key (prefix `vai_`) and lets a technician:

- See **assigned jobs** (Dispatch tab) with status filters
- Accept / decline jobs and walk them through the dispatch state machine
  (`assigned → en_route → on_site → in_progress → completed`)
- See **upcoming appointments** for the next 7 days (Schedule tab)
- Check in / complete / cancel an appointment
- Call, text, or email the customer with one tap

The app talks to two endpoint groups exposed by the admin-api specifically for
mobile clients:

- `/api/v1/dispatch/jobs` — list / get / transition jobs, list resources
- `/api/v1/scheduling/bookings` — list / get / transition bookings

Both groups are protected by `requireApiKeyOrJwt(requireAuth)` plus
`requireApiKeyPermission` (read-only or write).

## Project layout

```
mobile/
  app/
    _layout.tsx           # Stack root + auth gate + providers
    (auth)/login.tsx      # API key entry
    (tabs)/dispatch.tsx   # Assigned jobs list
    (tabs)/schedule.tsx   # Upcoming appointments
    (tabs)/profile.tsx    # Resource selection + sign out
    jobs/[id].tsx         # Job detail + transitions + customer contact
    bookings/[id].tsx     # Booking detail + transitions + customer contact
  components/             # JobCard, BookingCard, StatusPill, ContactRow, ...
  hooks/                  # useAuth, useColors
  lib/                    # api client, secure-store auth, react-query
  constants/              # color palette + status tones
  assets/                 # Placeholder icon / splash
```

## Local development

This app lives in its own folder so it does not share the monorepo's pnpm
workspace. Use npm/pnpm directly inside `mobile/`.

```bash
cd mobile
npx expo install              # installs the pinned versions in package.json
npx expo start                # opens Expo Dev Tools; scan QR in Expo Go
```

When you launch the app, you'll be asked for:

1. **Server URL** — the public origin of the admin-api
   (`https://your-tenant.example.com`). You can set a default by passing
   `EXPO_PUBLIC_API_URL=...` or by editing `app.json`'s `extra.defaultApiUrl`.
2. **API key** — generated in **Admin Console → Settings → API Keys**.
   Read-only keys can browse but cannot trigger transitions; write/admin keys
   can do both.

The job map preview also fetches a driving route between the technician's
current location and the job site. By default it queries the public OSRM
demo server (`https://router.project-osrm.org`); point at your own OSRM /
Valhalla deployment by setting `EXPO_PUBLIC_ROUTING_URL`. When the route
endpoint is unreachable (offline, rate-limited, timeout) the preview falls
back to a straight-line haversine ETA.

The credentials are stored using `expo-secure-store` (keychain / keystore).
On the Profile tab you can pick which dispatch resource (technician) the app
should filter by — this scopes the Dispatch and Schedule lists to that person.

## EAS builds (iOS + Android)

The project is configured for Expo Application Services (EAS):

```bash
npm install -g eas-cli       # one-time
cd mobile
eas login
eas init                     # writes a real projectId into app.json/extra.eas
eas build --profile development --platform ios
eas build --profile development --platform android
eas build --profile production --platform all
```

Profiles defined in `eas.json`:

| Profile       | Distribution | Use                                |
|---------------|--------------|------------------------------------|
| `development` | internal     | Dev client + tunnel                |
| `preview`     | internal     | QA-internal IPA / APK              |
| `production`  | store        | App Store + Google Play submission |

### Submission

```bash
eas submit --profile production --platform ios
eas submit --profile production --platform android
```

You will need:

- **iOS**: Apple Developer account, Bundle ID `com.voiceai.tech` registered,
  App Store Connect record created.
- **Android**: A Google Play service account JSON (`play-store-key.json`,
  gitignored), package `com.voiceai.tech`, app shell created in Play Console.

## Permissions

| Platform | Permission              | Why                              |
|----------|-------------------------|----------------------------------|
| Android  | `CALL_PHONE`            | One-tap call to the customer     |
| iOS      | None at install time    | `tel:` / `sms:` / `mailto:` only |

If you add background tracking, push, or maps later, declare them in
`app.json` (and `infoPlist` / `permissions`) and re-run `eas build`.

## Notes

- The app does **not** ship its own auth provider; all access is gated by the
  API key and the per-key permission scope on the server.
- Pull-to-refresh is available on every list. The job/booking detail screens
  invalidate the corresponding list query after each successful transition.
- Both light and dark mode are supported and follow the system preference.

## Offline-aware transitions

Field techs often work in basements, crawl spaces, or rural homes with no
cell signal. To keep them moving:

- `lib/connectivity.ts` tracks an `online`/`offline` flag that flips when
  `apiCall` either succeeds or throws a `TypeError`/`AbortError` (15-second
  fetch timeout).
- `lib/offlineQueue.ts` persists job and booking transitions to
  `AsyncStorage` (`voiceai.tech.offlineQueue.v2`) when the device is offline
  or `apiCall` raises an `OfflineError`. Queued payloads contain only the
  mutation intent (kind, target id, action, optional notes) — **no
  credentials are persisted**. The drainer resolves the current API key
  from `expo-secure-store` (`loadStoredCredentials`) on each attempt, so
  signing out automatically pauses the queue until the tech signs back
  in.
- A drainer runs on app start, on `AppState 'active'`, when connectivity
  flips back to online, on a 30-second timer, and on manual retry. Items
  replay in FIFO order; 5xx is treated as transient and 4xx is treated as
  a real conflict (item is dropped, conflict surfaced via `Alert.alert`).
- `components/OfflineBanner.tsx` shows a sticky banner whenever the queue
  has items: "Working offline — N pending updates" + a Retry button.
- The Job and Appointment detail screens show an inline "Queued offline:
  …" card while their transition is waiting in the queue.
