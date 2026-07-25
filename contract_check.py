#!/usr/bin/env python3
"""
Differential test for the JS <-> Python contract.

normJob, makeId and fmtDateKey in format.js are re-implemented in email_import.py as
norm_job, make_id and fmt_date_key. Both sides compute Firestore document IDs from the SAME
master spreadsheet -- the website's Excel import at app.js:1798 and the nightly importer at
email_import.py:616 -- so if the two implementations disagree about a single value, the same
row lands under two different IDs and shows up as a duplicate arrival.

That contract used to be a comment and nothing else, and it had already drifted: new Date()
in JS accepted "2026/07/09", "7-9-26" and bare numbers that fmt_date_key() rejected, and
make_id() hashed Python code points where makeId() hashes UTF-16 code units.

This script runs BOTH real implementations over a shared corpus and fails on any difference.
It reads the actual source files, so it cannot pass by testing a stale copy.

    python3 contract_check.py            # quiet unless something diverges
    python3 contract_check.py -v         # print every case

Requires node and python3. No third-party packages.
"""

import json
import re
import subprocess
import sys
import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent
FORMAT_JS = ROOT / "format.js"
IMPORTER = ROOT / "email_import.py"

# Inputs are strings or None, matching what both call sites actually pass: spreadsheet cells
# and already-normalised strings. Deliberately covers the formats that caused real drift.
DATE_CASES = [
    "", "   ", None,
    # ISO, the date-picker format
    "2026-07-09", "2026-7-9", "2026-07-9", "  2026-07-09  ", "2026-07-09T00:00:00Z",
    "2026-07-09T17:30:00", "2026-07-09 08:00",
    # M/D/Y, how people type dates
    "7/9/26", "07/09/2026", "7/9/2026", "12/31/25", "1/1/00", "9/31/26",
    # written out by hand in the master sheet
    "July 16, 2026", "Thursday, July 16, 2026", "Jul 16, 2026", "Jul 16 2026",
    "16 July 2026", "16th July 2026", "September 5, 2026", "Sept 5, 2026",
    "Sep. 5, 2026", "1st Mar 2027", "Mon, 05 Sep 2026",
    # formats new Date() used to accept and fmt_date_key never did -- the actual drift
    "2026/07/09", "7-9-26", "7.9.26", "0", "12345", "  12345 ", "45123",
    # junk and near-misses
    "N/A", "-", "TBD", "not a date", "2026-13-45", "2026-02-30", "Smurfday 3, 2026",
    "July 2026", "16 July", "abc 12 3456",
]

JOB_CASES = [
    "", "   ", None, "12345", "  12345 ", "12-3456", " 12-3456 ", "na", "n/a", "N/A",
    "NA", "N/a", "-", "--", "Job 12-3456", "abc", "ABC", "aBc", "\ttab\t", "shop stock",
    "26-0080", "  26-0080  ", "Ø12", "12°", "café",
]

# Real ID shapes from app.js:1798/1799/1818 and email_import.py:616/618/672, plus the
# encoding edge cases. Every element is a string or None, as at the call sites.
MAKEID_CASES = [
    ["2026-07-09", "PO-88231", "12-3456", "(4) Trane RTU curb adapters, 2 pallets"],
    ["", "", "", ""],
    [None, None, "x", "y"],
    ["AK-44192", "24-118", "40' Telehandler - Genie GTH-844", "2026-07-19"],
    ["24-118", "Threading machine", "TM-0442", "2026-07-11"],
    ['6" spiral duct', "12° elbow", "café", "Ø150"],          # BMP non-ASCII
    ["emoji 😀 here", "tab\there", "a|b", "pipe|in|part"],     # non-BMP + the join delimiter
    ["A" * 200, "B" * 200, "", ""],
    ["  leading and trailing  ", "MiXeD CaSe", "", ""],
]

JS_DRIVER = r"""
import { normJob, fmtDateKey, makeId } from "%s";
const [dates, jobs, ids] = JSON.parse(process.argv[1]);
console.log(JSON.stringify({
  fmtDateKey: dates.map(d => fmtDateKey(d === null ? "" : d)),
  normJob:    jobs.map(j => normJob(j)),
  makeId:     ids.map(p => makeId(p.map(x => x === null ? "" : x))),
}));
"""


def js_results():
    """Run the real format.js under node."""
    driver = JS_DRIVER % FORMAT_JS.as_uri()
    payload = json.dumps([DATE_CASES, JOB_CASES, MAKEID_CASES])
    proc = subprocess.run(
        ["node", "--input-type=module", "-e", driver, "--", payload],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        sys.exit("node failed running format.js:\n" + proc.stderr)
    return json.loads(proc.stdout)


def py_helpers():
    """Exec the mirrored helpers straight out of email_import.py, without importing the
    module (which would pull in openpyxl and google-cloud-firestore)."""
    src = IMPORTER.read_text()
    start = src.find("def norm_job")
    end = src.find("# ---------------------------------------------------------------------------\n# 2.")
    if start < 0 or end < 0 or end <= start:
        sys.exit("contract_check: could not locate the helper block in email_import.py. "
                 "If it moved, update the markers in this script.")
    ns = {"re": re, "datetime": datetime}
    exec(compile(src[start:end], str(IMPORTER), "exec"), ns)
    for name in ("norm_job", "make_id", "fmt_date_key"):
        if name not in ns:
            sys.exit(f"contract_check: {name} not found in the extracted helper block.")
    return ns


def main():
    verbose = "-v" in sys.argv or "--verbose" in sys.argv
    js = js_results()
    py = py_helpers()

    diffs = []
    checks = 0

    for i, case in enumerate(DATE_CASES):
        a, b = js["fmtDateKey"][i], py["fmt_date_key"]("" if case is None else case)
        checks += 1
        if a != b:
            diffs.append(("fmtDateKey", case, a, b))
        elif verbose:
            print(f"  ok  fmtDateKey({case!r}) = {a!r}")

    for i, case in enumerate(JOB_CASES):
        a, b = js["normJob"][i], py["norm_job"]("" if case is None else case)
        checks += 1
        if a != b:
            diffs.append(("normJob", case, a, b))
        elif verbose:
            print(f"  ok  normJob({case!r}) = {a!r}")

    for i, parts in enumerate(MAKEID_CASES):
        clean = ["" if p is None else p for p in parts]
        a, b = js["makeId"][i], py["make_id"](clean)
        checks += 1
        if a != b:
            diffs.append(("makeId", parts, a, b))
        elif verbose:
            print(f"  ok  makeId({parts!r:.60}) = {a!r}")

    if not diffs:
        print(f"contract OK — {checks} cases, format.js and email_import.py agree exactly")
        return 0

    print(f"\nCONTRACT BROKEN — {len(diffs)} of {checks} cases differ.\n")
    print("The website and the importer would write DIFFERENT document IDs for the same")
    print("spreadsheet row, which imports as a duplicate arrival.\n")
    print(f"{'function':11s} {'input':38s} {'format.js':24s} {'email_import.py'}")
    print("-" * 104)
    for fn, case, a, b in diffs:
        print(f"{fn:11s} {repr(case)[:38]:38s} {repr(a)[:24]:24s} {repr(b)}")
    print("\nFix whichever side is wrong and re-run. Do not just update this test.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
