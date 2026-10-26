# connectors/caldav

```sh
pnpm --filter @pbcp/connector-caldav build
export CALDAV_URL=https://cal.example.com/dav/ CALDAV_USER=me CALDAV_PASSWORD=… PBCP_HEAD_URL=https://head.example PBCP_TOKEN=…
node connectors/caldav/dist/src/index.js
```

An example producer on `@pbcp/client`: it reads one CalDAV calendar and turns it into cards (RFC §11.1). It is a reader only. It does not create, change or answer events, and it takes no decisions (`onDecision` does nothing).

- Once a day, an `artifact` card with the day's agenda at `urgency: brief`: a table of time, title and location, then a `mermaid` `gantt` fence of the timed events (core tier, §3.1).
- When an event's start moves to within the next 30 minutes, a `signal` card at `urgency: immediate` (§9).

It polls every 5 minutes by default, so a move is reported at most one interval after the server has it.

## Configuration

| Variable | Default | |
|---|---|---|
| `CALDAV_URL` | – | server or principal URL; Basic auth |
| `CALDAV_USER`, `CALDAV_PASSWORD` | – | |
| `CALDAV_CALENDAR` | the first calendar found | display name, or the calendar's full URL as the server reports it |
| `CALDAV_TZ` | the process time zone | IANA name; sets `TZ` for the process |
| `CALDAV_AGENDA_AT` | `06:00` | local time from which the day's agenda is produced |
| `CALDAV_INTERVAL_S` | `300` | seconds between passes |
| `PBCP_HEAD_URL`, `PBCP_TOKEN` | – | the head and this producer's token |
| `PBCP_TO_PERSON` | the head's `owner` | read once from `GET /` at startup when unset |
| `PBCP_CURSOR` | `pbcp-caldav.cursor.json` | sync cursor |
| `PBCP_STATE` | the cursor path with `.cursor.json` replaced by `.state.json`, else `<cursor>.state.json` | producer state |

## Ids and threads

The producer root is `cal`. The namespace is the calendar's display name (or, without one, the last segment of its URL) lowercased, with each run of characters outside `[a-z0-9]` replaced by `-` and leading and trailing `-` removed; `calendar` if nothing is left. Renaming the calendar changes every id.

- **Agenda:** `cal:<namespace>:<YYYY-MM-DD>`, the local date in `CALDAV_TZ`.
- **Moved:** `cal:<namespace>:<hash>-<start>:moved`. `<hash>` is the first 16 lowercase hex characters of the SHA-256 of `<UID>/<RECURRENCE-ID>` (UTF-8; the RECURRENCE-ID as ical.js prints it, e.g. `2026-10-26T09:15:00`, and empty for a non-recurring event). `<start>` is the new start in UTC as `YYYYMMDDTHHMMZ`. Each move of an occurrence gets its own id; the same move seen twice gets the same one.

Every card's `thread` is `day-<YYYY-MM-DD>`, the local date of the agenda or of the moved event's new start, so a day's signals sit with its agenda.

## Choices

- **Once a day.** The agenda is produced on the first pass on or after `CALDAV_AGENDA_AT` each local day, and the state file records the date. It is not re-submitted when the calendar changes later that day: a re-PUT would replace the open card in place and mark it unseen (§5), and the moved signal covers the change that matters. Deleting the state file produces it again, with that moment's content.
- **Empty day.** A card is still produced, titled `<day>: nothing scheduled`, so the brief shows the day was checked.
- **Moved.** The state file keeps the last-seen start of every occurrence in the fetch window (yesterday to two days ahead), keyed by UID and RECURRENCE-ID. A signal is produced when an occurrence's start differs from the last-seen one and now lies in the next 30 minutes. An occurrence seen for the first time is not "moved", nor is one first seen outside the window, so a meeting pulled in from next week to today produces no signal. A move to more than 30 minutes ahead updates the state silently; it is not signalled later as the time approaches. All-day events are never signalled. Events with `STATUS:CANCELLED` are left out of the agenda, and a cancellation is not signalled.
- **State and failures.** State is saved only when every card of a pass was accepted. If a submit fails, the next pass recomputes the same cards with the same ids and re-submits them; those already stored come back `200` unchanged.
- **Time zone.** Times are shown in `CALDAV_TZ`. Events with a `TZID` use the calendar's `VTIMEZONE`; floating times and all-day dates are read in the process time zone, which `CALDAV_TZ` sets. A timed event that crosses midnight is clipped to `00:00` and `23:59` in the table and the chart.
- **Recurrence.** ical.js expands `RRULE`/`RDATE`/`EXDATE` and applies overrides (`RECURRENCE-ID`) delivered in the same calendar object. Expansion stops at 10 000 steps per series, so a high-frequency series with an old `DTSTART` may be cut short. An override without its master is treated as a single event. The time-range query is left to the server; a server that does not filter recurring events correctly may return extra objects, which are filtered locally.
- **Gantt.** Only timed events are drawn. Task names drop `:` `#` `;` and `%` (task-data separator, comment, statement separator, mermaid comment), are cut to 40 characters, and a name starting with a gantt keyword (`section`, `title`, `click`, …) is prefixed with `· `. In the table, `|` is escaped instead.
