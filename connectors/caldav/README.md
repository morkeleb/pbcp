# connectors/caldav

An example producer on `@pbcp/client`: it reads one or more CalDAV calendars and turns them into cards (RFC §11.1). It is a reader only. It does not create, change or answer events, and it takes no decisions (`onDecision` does nothing).

- Once a day, an `artifact` card with the day's agenda at `urgency: brief`: a table of time, title and location. The list is the content; with `CALDAV_CHART` set, a `mermaid` `gantt` fence of the timed events follows it (core tier, §3.1), since a chart in a card is for what a list cannot say.
- For an event in the next 7 days, a `signal` card when it is **new**, **moved** or **cancelled** (see [Signals](#signals)). Its urgency (§9) is by how soon the event is: `immediate` within two hours, `brief` today or tomorrow, `log` later.
- `summary` (§4.1): on a signal, the event's time (new and old, on a move) and its location (and calendar, with several); on an agenda, the first timed event's time and location, `First: Standup, 09:15–09:30.` An empty day, or one with only all-day events, has no `summary`, since the title already says everything.
- `about` (§4.1): the agenda's day on an agenda, and the event's local day (its new one, on a move) on a signal, so a head files both under the day they concern.
- `labels` (§4.1): the calendar's namespace (its slug, cut to 32 characters) as a label: `work`. A merged agenda (several calendars) carries every configured calendar's label, at most 8.
- `references` (§8): a signal about a day whose agenda has been produced (today's, once it is out) names that agenda card; a move names it when the event left or joined that day.
- `source` (§4.1): a new or moved signal links to the event when the event has a web `URL` property (`http` or `https`), labelled `Calendar event`. An agenda covers a whole day and has no `source`; nor does an event without a URL, since a CalDAV resource URL needs the server login and does not open in a calendar app, nor a cancelled one, which is gone.

It polls every 5 minutes by default, so a change is reported at most one interval after the server has it.

## Setup

<!-- setup: generated from src/connect.ts by scripts/readme-setup.ts; edit the template there, not this section -->

The token is bound to the root `cal` (RFC §12): every card id this connector mints starts with `cal:`.

It runs from a checkout of the repository at a release tag (the packages are not on npm yet):

```sh
git clone --branch v0.8.0 --depth 1 https://github.com/morkeleb/pbcp && cd pbcp
corepack pnpm install --frozen-lockfile && corepack pnpm build
export PBCP_HEAD_URL='<head url>' PBCP_TO_PERSON='<owner>' PBCP_TOKEN='<token>'
export CALDAV_URL=https://cal.example.com/dav/ CALDAV_USER=me CALDAV_PASSWORD=… CALDAV_TZ=Europe/Copenhagen
node connectors/caldav/dist/src/index.js
```

Several calendars, the agenda time, the optional chart and the rest are under [Configuration](#configuration).

<!-- /setup -->

## Configuration

| Variable | Default | |
|---|---|---|
| `CALDAV_URL` | – | server or principal URL; Basic auth |
| `CALDAV_USER`, `CALDAV_PASSWORD` | – | |
| `CALDAV_CALENDARS` | – | several calendars, as a JSON list of `{ "name", "url" }`; see below. When set, `CALDAV_CALENDAR` is ignored |
| `CALDAV_CALENDAR` | the first calendar found | one calendar: display name, or the calendar's full URL as the server reports it |
| `CALDAV_TZ` | the process time zone | IANA name; sets `TZ` for the process |
| `CALDAV_AGENDA_AT` | `06:00` | local time from which the day's agenda is produced |
| `CALDAV_CHART` | off | `1` (or `true`, `yes`, `on`) adds the gantt chart to the agenda |
| `CALDAV_INTERVAL_S` | `300` | seconds between passes |
| `PBCP_HEAD_URL`, `PBCP_TOKEN` | – | the head and this producer's token |
| `PBCP_TO_PERSON` | the head's `owner` | read once from `GET /` at startup when unset |
| `PBCP_STORE` | `PBCP_CURSOR` if set, else `pbcp-caldav.store.json` | one file: the sync cursor and the producer state |

## Several calendars

```sh
export CALDAV_CALENDARS='[{"name":"Work","url":"/dav/calendars/me/work/"},{"name":"Home","url":"/dav/calendars/me/home/"}]'
```

`url` is the calendar's URL, absolute or relative to `CALDAV_URL`; a trailing `/` does not matter. Every calendar must be on that server, behind the same login. `name` is what the person sees. It also gives the calendar's namespace, made the same way as below, so two names that give the same namespace are refused at startup. An unknown URL is refused at startup with the list of calendars the server reports.

With one entry, the producer behaves exactly as with `CALDAV_CALENDAR`: the same cards and ids, with the namespace taken from `name`. With two or more:

- **One agenda a day for all of them**, `cal:agenda:<YYYY-MM-DD>`. The table gains a Calendar column and lists every calendar's events in one chronological order: all-day events first, and ties in the order of `CALDAV_CALENDARS`. With `CALDAV_CHART`, the gantt chart has one `section` per calendar that has timed events that day, in that order.
- **Overlaps.** Two timed events in different calendars whose times intersect are both marked:
  - `⚠` after the time in the table;
  - `crit` in the chart, when there is one;
  - a list under the table of each pair and the time they share;
  - the overlap count in the title.

  These are not overlaps:
  - events in the same calendar, since that calendar's own app already shows them;
  - all-day events;
  - events that only touch end to start;
  - the same occurrence (UID and RECURRENCE-ID) appearing in two calendars, which is one meeting, not a clash.
- **Signals** keep their calendar's namespace (`cal:<namespace>:<hash>:new`, and so on) and carry the calendar's name in the title (`Moved: Standup now at 09:20 (Work)`) and a `Calendar:` line in the body.
- **State.** The last-seen starts are kept per calendar, so an event that sits in two calendars is tracked in each.

Switching between one calendar and several keeps the stored date of the last agenda. The new kind of agenda therefore starts the next day. Every occurrence is seen afresh under its new key, so the first pass after the switch reports nothing as new, moved or cancelled.

## Signals

The store file keeps every occurrence in the fetch window (yesterday to 7 days ahead) as it was last seen: its start, title, all-day date, and the id of the last move reported for it. Each pass compares the window with that.

- **New**, `New: Dentist, today 14:00`: an occurrence that was not there last pass although its start lies inside last pass's window, and that has not yet begun (an all-day event: whose day is not over). An event that only comes into view as the window moves on is not new, nor is anything on the first pass. A new recurring series is told once, at its first occurrence in the window.
- **Moved**, `Moved: Standup now at Fri 30 Oct 13:00`: a timed occurrence whose start differs from the last-seen one and still lies ahead. The urgency is by the sooner of the old and new start that is still ahead, so a meeting moved away from the next hour is still `immediate`. A later move of the same occurrence `supersedes` (§8) the earlier move's card, so the head shows only the latest. All-day events are not signalled as moved.
- **Cancelled**, `Cancelled: Dentist, Tue 27 Oct 14:00`: an occurrence seen last pass, not yet begun, and no longer there. That is a deleted event, one with `STATUS:CANCELLED`, and also an event moved out of the window (more than 7 days ahead), which the connector cannot tell apart from a deletion. A cancelled series is told once, like a new one.

Times read as on a phone: the time alone on the day in question, the day and time otherwise (`Fri 30 Oct 13:00`), never an ISO timestamp.

## Ids and threads

The producer root is `cal`. The namespace is the calendar's display name (or, without one, the last segment of its URL) lowercased, with each run of characters outside `[a-z0-9]` replaced by `-` and leading and trailing `-` removed; `calendar` if nothing is left. Renaming the calendar changes every id.

- **Agenda:** `cal:<namespace>:<YYYY-MM-DD>`, the local date in `CALDAV_TZ`; with several calendars, `cal:agenda:<YYYY-MM-DD>`.
- **New:** `cal:<namespace>:<hash>:new`. `<hash>` is the first 16 lowercase hex characters of the SHA-256 of `<UID>/<RECURRENCE-ID>` (UTF-8; the RECURRENCE-ID as ical.js prints it, e.g. `2026-10-26T09:15:00`, and empty for a non-recurring event).
- **Moved:** `cal:<namespace>:<hash>-<start>:moved`, with `<start>` the new start in UTC as `YYYYMMDDTHHMMZ`. Each move of an occurrence gets its own id; the same move seen twice gets the same one.
- **Cancelled:** `cal:<namespace>:<hash>:cancelled`.

Every card's `thread` is `day-<YYYY-MM-DD>`, the local date of the agenda or of the event (its new start, on a move), so a day's signals sit with its agenda.

## Choices

- **Once a day.** The agenda is produced on the first pass on or after `CALDAV_AGENDA_AT` each local day, and the store file records the date (under `state.calendar`). It is not re-submitted when the calendar changes later that day: a re-PUT would replace the open card in place and mark it unseen (§5), and the new, moved and cancelled signals cover the changes that matter. Deleting the store file produces it again, with that moment's content.
- **Empty day.** A card is still produced, titled `<day>: nothing scheduled`, so the brief shows the day was checked.
- **Signals.** Occurrences are keyed by UID and RECURRENCE-ID. A meeting pulled in from more than 7 days ahead is reported as new, since it was not in the window before. Events with `STATUS:CANCELLED` are left out of the agenda.
- **State and failures.** State is saved only when the head has answered every card of a pass (`201`, `200` or `409`). If a submit fails, the next pass recomputes the same cards with the same ids and re-submits them; those already stored come back `200` unchanged. A card the head keeps refusing (a 4xx such as `403 wrong_person` or `413`) is parked after five attempts and logged; it then counts as answered, so the state moves on instead of the same cards being recomputed all day.
- **Time zone.** Times are shown in `CALDAV_TZ`. Events with a `TZID` use the calendar's `VTIMEZONE`; floating times and all-day dates are read in the process time zone, which `CALDAV_TZ` sets. A timed event that crosses midnight is clipped to `00:00` and `23:59` in the table and the chart.
- **Recurrence.** ical.js expands `RRULE`/`RDATE`/`EXDATE` and applies overrides (`RECURRENCE-ID`) delivered in the same calendar object. Expansion stops at 10 000 steps per series, so a high-frequency series with an old `DTSTART` may be cut short. An override without its master is treated as a single event. The time-range query is left to the server; a server that does not filter recurring events correctly may return extra objects, which are filtered locally.
- **Gantt.** Off unless `CALDAV_CHART` is set: the table already says what the day holds, and a chart repeats it. Only timed events are drawn. Task names drop `:` `#` `;` and `%` (task-data separator, comment, statement separator, mermaid comment), are cut to 40 characters, and a name starting with a gantt keyword (`section`, `title`, `click`, …) is prefixed with `· `. In the table, `|` is escaped instead.

## Upgrading an older store

The store now keeps more per occurrence (title, all-day date, last move) and the end of the last window. A store from before keeps working: the first pass reads the old starts for moves, and reports nothing as new or cancelled, since it has no window to compare with. The agenda loses its chart unless `CALDAV_CHART` is set.

## Upgrading from 0.3

0.3 kept the cursor in `pbcp-caldav.cursor.json` and the state in a separate `.state.json`. 0.4 keeps both in one store file and no longer reads `PBCP_STATE` or the old state file.

- If you set `PBCP_CURSOR`, it is used as the store path and the 0.3 cursor file is read as is. Otherwise rename `pbcp-caldav.cursor.json` to `pbcp-caldav.store.json`, or set `PBCP_STORE`; without either, the cursor starts at 0, which costs one replay of the changes and nothing else, since decisions are ignored.
- The state is not carried over, so the connector starts as if new. If the upgrade happens after `CALDAV_AGENDA_AT`, today's agenda is submitted again on the first pass; it has the same id, so the head answers `200` and, if the day's events changed since, replaces the open card in place and marks it unseen (§5); a card that is no longer open is left as it is (`409`). Moves are not signalled until each occurrence has been seen once more, so a meeting moved during the first pass after the upgrade is not reported. Delete the old `.state.json` afterwards.
