# Tests

Browser suites for the app. They serve **this repo directly** — never a copy. An earlier
harness kept its own copies of `app.js`/`index.html`, and more than once a suite passed green
against a stale copy while the real file was broken.

```bash
./tests/setup.sh     # once: installs Playwright, caches the CDN libraries into tests/vendor
./tests/run.sh       # all suites
./tests/run.sh ptp   # just one
```

`run.sh` exits non-zero if anything fails, so it can gate a deploy.

| suite | what it protects |
| --- | --- |
| `ui` | the three-tab layout and the whole Safety tab |
| `badge_tut` | the Live/Saved badge, and that the tutorial only opens when asked |
| `myjobs` | merged-list ordering across jobs, filters, delete confirms |
| `mobile_myjobs` | the phone bar and both sheets, incl. states that used to be dead ends |
| `lastseen` | Admin → Manage People last-visit line, and the write throttle |
| `ptp` | both templates against their Word source; the PDF is re-read with pdf.js |
| `baddata` | every tab against deliberately malformed Firestore documents |
| `growth` | five years of data, with budgets on boot, tab switches and DOM size |
| `monkey` | seeded random clicking; replay a failure with `MONKEY_SEED=<n>` |

`contract_check.py` (run first by `run.sh`) pins `normJob`/`fmtDateKey`/`makeId` in `format.js`
byte-for-byte against `email_import.py`. Both compute Firestore document IDs; if they drift, the
nightly import silently duplicates every row.

## Writing a new suite

Import the shared plumbing and follow the shape of an existing file:

```js
import { startServer, routeCdn, CHROMIUM, TESTS_DIR } from "./serve.mjs";
const { server, port: PORT } = await startServer();
```

Two rules worth keeping:
- assert on **counts and positions**, not just "the string is present" — a duplicated PDF header
  band passed every substring check we had.
- filter `net::ERR_` out of console errors (the offline harness), but never filter real ones.
