# connectors/caldav

An example producer on `@pbcp/client`: it reads one or more CalDAV calendars and turns them into cards (RFC §11.1). It is a reader only. It does not create, change or answer events, and it takes no decisions (`onDecision` does nothing).

- Once a day, an `artifact` card with the day's agenda at `urgency: brief`: a table of time, title and location, then a `mermaid` `gantt` fence of the timed events (core tier, §3.1).
- When an event's start moves to within the next 30 minutes, a `signal` card at `urgency: immediate` (§9).
- `summary` (§4.1): on a moved signal, the event's new and old time and its location (and calendar, with several); on an agenda, the first timed event's time and location, `First: Standup, 09:15–09:30.` An empty day, or one with only all-day events, has no `summary`, since the title already says everything.
- `about` (§4.1): the agenda's day on an agenda, and the event's new local day on a moved signal, so a head files both under the day they concern.
- `labels` (§4.1): the calendar's namespace (its slug, cut to 32 characters) as a label: `work`. A merged agenda (several calendars) carries every configured calendar's label, at most 8.
- `source` (§4.1): a moved signal links to the event when the event has a web `URL` property (`http` or `https`), labelled `Calendar event`. An agenda covers a whole day and has no `source`; nor does an event without a URL, since a CalDAV resource URL needs the server login and does not open in a calendar app.

It polls every 5 minutes by default, so a move is reported at most one interval after the server has it.

## Setup

<!-- setup: generated from src/connect.ts by scripts/readme-setup.ts; edit the template there, not this section -->

The token is bound to the root `cal` (RFC §12): every card id this connector mints starts with `cal:`.

```sh
pnpm install && pnpm --filter @pbcp/connector-caldav build
export PBCP_HEAD_URL='<head url>' PBCP_TO_PERSON='<owner>' PBCP_TOKEN='<token>'
export CALDAV_URL=https://cal.example.com/dav/ CALDAV_USER=me CALDAV_PASSWORD=… CALDAV_TZ=Europe/Copenhagen
node connectors/caldav/dist/src/index.js
```

Several calendars, the agenda time and the rest are under [Configuration](#configuration).

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

- **One agenda a day for all of them**, `cal:agenda:<YYYY-MM-DD>`. The table gains a Calendar column and lists every calendar's events in one chronological order: all-day events first, and ties in the order of `CALDAV_CALENDARS`. The gantt chart has one `section` per calendar that has timed events that day, in that order.
- **Overlaps.** Two timed events in different calendars whose times intersect are both marked:
  - `⚠` after the time in the table;
  - `crit` in the chart;
  - a list under the table of each pair and the time they share;
  - the overlap count in the title.

  These are not overlaps:
  - events in the same calendar, since that calendar's own app already shows them;
  - all-day events;
  - events that only touch end to start;
  - the same occurrence (UID and RECURRENCE-ID) appearing in two calendars, which is one meeting, not a clash.
- **Moved signals** keep their calendar's namespace, `cal:<namespace>:<hash>-<start>:moved`, and carry the calendar's name in the title (`Moved: Standup now at 09:20 (Work)`) and a `Calendar:` line in the body.
- **State.** The last-seen starts are kept per calendar, so an event that sits in two calendars is tracked in each.

Switching between one calendar and several keeps the stored date of the last agenda. The new kind of agenda therefore starts the next day, and moves are not signalled until each occurrence has been seen once more.

## Ids and threads

The producer root is `cal`. The namespace is the calendar's display name (or, without one, the last segment of its URL) lowercased, with each run of characters outside `[a-z0-9]` replaced by `-` and leading and trailing `-` removed; `calendar` if nothing is left. Renaming the calendar changes every id.

- **Agenda:** `cal:<namespace>:<YYYY-MM-DD>`, the local date in `CALDAV_TZ`; with several calendars, `cal:agenda:<YYYY-MM-DD>`.
- **Moved:** `cal:<namespace>:<hash>-<start>:moved`. `<hash>` is the first 16 lowercase hex characters of the SHA-256 of `<UID>/<RECURRENCE-ID>` (UTF-8; the RECURRENCE-ID as ical.js prints it, e.g. `2026-10-26T09:15:00`, and empty for a non-recurring event). `<start>` is the new start in UTC as `YYYYMMDDTHHMMZ`. Each move of an occurrence gets its own id; the same move seen twice gets the same one.

Every card's `thread` is `day-<YYYY-MM-DD>`, the local date of the agenda or of the moved event's new start, so a day's signals sit with its agenda.

## Choices

- **Once a day.** The agenda is produced on the first pass on or after `CALDAV_AGENDA_AT` each local day, and the store file records the date (under `state.calendar`). It is not re-submitted when the calendar changes later that day: a re-PUT would replace the open card in place and mark it unseen (§5), and the moved signal covers the change that matters. Deleting the store file produces it again, with that moment's content.
- **Empty day.** A card is still produced, titled `<day>: nothing scheduled`, so the brief shows the day was checked.
- **Moved.** The store file keeps the last-seen start of every occurrence in the fetch window (yesterday to two days ahead), keyed by UID and RECURRENCE-ID. A signal is produced when an occurrence's start differs from the last-seen one and now lies in the next 30 minutes. An occurrence seen for the first time is not "moved", nor is one first seen outside the window, so a meeting pulled in from next week to today produces no signal. A move to more than 30 minutes ahead updates the state silently; it is not signalled later as the time approaches. All-day events are never signalled. Events with `STATUS:CANCELLED` are left out of the agenda, and a cancellation is not signalled.
- **State and failures.** State is saved only when the head has answered every card of a pass (`201`, `200` or `409`). If a submit fails, the next pass recomputes the same cards with the same ids and re-submits them; those already stored come back `200` unchanged. A card the head keeps refusing (a 4xx such as `403 wrong_person` or `413`) is parked after five attempts and logged; it then counts as answered, so the state moves on instead of the same cards being recomputed all day.
- **Time zone.** Times are shown in `CALDAV_TZ`. Events with a `TZID` use the calendar's `VTIMEZONE`; floating times and all-day dates are read in the process time zone, which `CALDAV_TZ` sets. A timed event that crosses midnight is clipped to `00:00` and `23:59` in the table and the chart.
- **Recurrence.** ical.js expands `RRULE`/`RDATE`/`EXDATE` and applies overrides (`RECURRENCE-ID`) delivered in the same calendar object. Expansion stops at 10 000 steps per series, so a high-frequency series with an old `DTSTART` may be cut short. An override without its master is treated as a single event. The time-range query is left to the server; a server that does not filter recurring events correctly may return extra objects, which are filtered locally.
- **Gantt.** Only timed events are drawn. Task names drop `:` `#` `;` and `%` (task-data separator, comment, statement separator, mermaid comment), are cut to 40 characters, and a name starting with a gantt keyword (`section`, `title`, `click`, …) is prefixed with `· `. In the table, `|` is escaped instead.

## Upgrading from 0.3

0.3 kept the cursor in `pbcp-caldav.cursor.json` and the state in a separate `.state.json`. 0.4 keeps both in one store file and no longer reads `PBCP_STATE` or the old state file.

- If you set `PBCP_CURSOR`, it is used as the store path and the 0.3 cursor file is read as is. Otherwise rename `pbcp-caldav.cursor.json` to `pbcp-caldav.store.json`, or set `PBCP_STORE`; without either, the cursor starts at 0, which costs one replay of the changes and nothing else, since decisions are ignored.
- The state is not carried over, so the connector starts as if new. If the upgrade happens after `CALDAV_AGENDA_AT`, today's agenda is submitted again on the first pass; it has the same id, so the head answers `200` and, if the day's events changed since, replaces the open card in place and marks it unseen (§5); a card that is no longer open is left as it is (`409`). Moves are not signalled until each occurrence has been seen once more, so a meeting moved during the first pass after the upgrade is not reported. Delete the old `.state.json` afterwards.
