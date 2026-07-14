#!/usr/bin/env python3
"""
Equipment Received — automated email → Firestore importer.

Runs in GitHub Actions on a schedule. Logs into a Gmail relay inbox over IMAP,
finds the most recent email from the expected sender that has an .xlsx/.xlsm
attachment, parses it with the SAME logic as the website's manual upload, and
writes the arrivals into Firestore. If anything looks wrong, it aborts WITHOUT
writing and exits non-zero so the workflow can flag it (no bad data goes live).

Env vars (provided by the workflow from repo secrets):
  GMAIL_USER            the relay Gmail address (e.g. [email protected])
  GMAIL_APP_PASSWORD    a Gmail App Password (NOT your normal password)
  EXPECTED_SENDER       substring that must appear in the From header. NOTE: because
                        Power Automate re-sends the message, this is the address the
                        FLOW sends from (jareneells@arctic.biz), not Bobby's.
  EXPECTED_SUBJECT      substring that must appear in the Subject (default "Arrivals
                        sheet") — this is the subject set in the Power Automate flow.
  FILENAME_MUST_CONTAIN substring the attachment's filename must contain (default
                        "Equipment Received"). This is what stops OTHER spreadsheets
                        Bobby emails from ever being imported as arrivals.
  FIREBASE_SA_JSON      full service-account JSON (as a string)
  MAX_AGE_HOURS         optional; only accept an email newer than this (default 26)
  DRY_RUN               optional; "1" parses + validates but does not write
"""

import os, sys, ssl, json, re, imaplib, email, hashlib, datetime
from email.header import decode_header

# ---- third-party (installed in the workflow): openpyxl, google-cloud-firestore ----
import openpyxl
from google.cloud import firestore
from google.oauth2 import service_account


# ---------------------------------------------------------------------------
# 1. Helpers that MUST match the website exactly (normJob, makeId, fmtDateKey)
# ---------------------------------------------------------------------------

def norm_job(j):
    """Mirror of normJob(): trim + uppercase."""
    if j is None:
        return ""
    return str(j).strip().upper()


def make_id(parts):
    """
    Mirror of makeId(): djb2-xor hash over the lowercased "|"-joined parts.
    JS: h=5381; h=((h<<5)+h)^charCode; return "a"+(h>>>0).toString(36)+len.toString(36)
    We reproduce 32-bit unsigned overflow and base36 exactly.
    """
    key = "|".join("" if p is None else str(p) for p in parts).lower()
    h = 5381
    for ch in key:
        # ((h<<5)+h) ^ charCode, kept in 32-bit space like JS bitwise ops
        h = (((h << 5) + h) & 0xFFFFFFFF) ^ (ord(ch) & 0xFFFFFFFF)
        h &= 0xFFFFFFFF
    return "a" + _base36(h) + _base36(len(key))


def _base36(n):
    """Match JS Number.prototype.toString(36) for non-negative integers."""
    if n == 0:
        return "0"
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = ""
    while n > 0:
        out = digits[n % 36] + out
        n //= 36
    return out


def fmt_date_key(d):
    """
    Mirror of fmtDateKey(): return YYYY-MM-DD (zero-padded) from a date or string.
    Handles real dates, ISO-ish, and M/D/Y. Returns "" if unparseable.
    """
    if d is None or d == "":
        return ""
    if isinstance(d, (datetime.datetime, datetime.date)):
        return f"{d.year:04d}-{d.month:02d}-{d.day:02d}"
    s = str(d).strip()
    m = re.match(r"^(\d{4})-(\d{1,2})-(\d{1,2})", s)
    if m:
        return f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
    m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{2,4})", s)
    if m:
        y = m.group(3)
        if len(y) == 2:
            y = "20" + y
        return f"{y}-{int(m.group(1)):02d}-{int(m.group(2)):02d}"
    return ""


# ---------------------------------------------------------------------------
# 2. Parse the workbook exactly like parseArrivalSheet()
# ---------------------------------------------------------------------------

def parse_arrival_sheet(ws, sheet_name):
    """Mirror of parseArrivalSheet(): skip rental tabs, find header row, map columns."""
    if re.search(r"rental", sheet_name, re.I):
        return []
    rows = [[c for c in r] for r in ws.iter_rows(values_only=True)]
    if not rows:
        return []

    # find the header row within the first 6 rows
    h_idx = -1
    for i in range(min(len(rows), 6)):
        joined = "|".join(str(c).lower() if c is not None else "" for c in rows[i])
        if "date received" in joined or ("job" in joined and "description" in joined):
            h_idx = i
            break
    if h_idx < 0:
        h_idx = 1
    if h_idx >= len(rows):
        return []

    H = [str(c).lower() if c is not None else "" for c in rows[h_idx]]

    def col(*keys):
        for k in keys:
            for i, h in enumerate(H):
                if k in h:
                    return i
        return -1

    cD = col("date received", "received")
    cP = col("p.o", "po", "p o")
    cJ = col("job#", "job #", "job num")
    cN = col("job name")
    cDe = col("description")
    cS = col("supplier")
    cDl = col("delivery")
    cR = col("requested")

    out = []
    for i in range(h_idx + 1, len(rows)):
        row = rows[i]

        def g(x):
            return row[x] if (x >= 0 and x < len(row)) else ""

        desc = str(g(cDe) or "").strip()
        dk = fmt_date_key(g(cD))
        if not desc and not dk:
            continue
        if not desc and not str(g(cJ) or "").strip():
            continue
        out.append({
            "dateReceived": dk,
            "po": str(g(cP) or "").strip(),
            "jobNumber": str(g(cJ) or "").strip(),
            "jobName": str(g(cN) or "").strip(),
            "description": desc,
            "supplier": str(g(cS) or "").strip(),
            "deliveryDate": fmt_date_key(g(cDl)),
            "requestedBy": str(g(cR) or "").strip(),
        })
    return out


def _looks_like_master(wb):
    """
    Sanity check that this workbook is really the Equipment Received master sheet.
    We require at least one non-rental tab whose first few rows contain the
    arrival header words. Cheap, but it stops an unrelated spreadsheet cold.
    """
    for name in wb.sheetnames:
        if re.search(r"rental", name, re.I):
            continue
        ws = wb[name]
        for i, row in enumerate(ws.iter_rows(values_only=True)):
            if i >= 6:
                break
            joined = "|".join(str(c).lower() if c is not None else "" for c in row)
            if "date received" in joined or ("job" in joined and "description" in joined):
                return True
    return False


# ---------------------------------------------------------------------------
# 3. Pull the newest matching attachment from the Gmail relay inbox (IMAP)
# ---------------------------------------------------------------------------

def _clean_filename(raw):
    """Decode an attachment filename and strip encoding artifacts/quotes."""
    if not raw:
        return ""
    try:
        dec = decode_header(raw)[0]
        name = dec[0].decode(dec[1] or "utf-8", errors="replace") if isinstance(dec[0], bytes) else str(dec[0])
    except Exception:
        name = str(raw)
    # RFC2231 can leave things like "utf-8''Name.xlsm" or stray quotes.
    name = re.sub(r"^[A-Za-z0-9\-]+''", "", name)
    name = name.strip().strip("'\"").strip()
    # ...and sometimes percent-encoding survives ("Equipment%20Received.xlsm").
    if "%" in name:
        try:
            from urllib.parse import unquote
            name = unquote(name)
        except Exception:
            pass
    return name.strip()


def fetch_latest_attachment(user, app_password, expected_sender, max_age_hours,
                            expected_subject="", filename_must_contain=""):
    imap = imaplib.IMAP4_SSL("imap.gmail.com", ssl_context=ssl.create_default_context())
    imap.login(user, app_password)
    imap.select("INBOX")

    # Search only recent messages to keep it fast.
    since = (datetime.date.today() - datetime.timedelta(days=3)).strftime("%d-%b-%Y")
    status, data = imap.search(None, f'(SINCE {since})')
    if status != "OK":
        raise RuntimeError("IMAP search failed")

    ids = data[0].split()
    if not ids:
        raise RuntimeError("No recent emails found in the relay inbox")

    cutoff = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=max_age_hours)
    candidates = []   # every matching (date, filename, bytes) — we pick the newest at the end
    skipped_names = []

    for msg_id in reversed(ids):
        status, msg_data = imap.fetch(msg_id, "(RFC822)")
        if status != "OK":
            continue
        msg = email.message_from_bytes(msg_data[0][1])

        frm = str(msg.get("From", "")).lower()
        if expected_sender and expected_sender.lower() not in frm:
            continue

        # Also match the subject the Power Automate flow sets. This keeps us from
        # grabbing some unrelated spreadsheet that happens to come from the same address.
        if expected_subject:
            subj = msg.get("Subject", "")
            dec = decode_header(subj)[0] if subj else ("", None)
            subj = dec[0].decode(dec[1] or "utf-8", errors="replace") if isinstance(dec[0], bytes) else str(dec[0] or "")
            if expected_subject.lower() not in subj.lower():
                continue

        try:
            msg_date = email.utils.parsedate_to_datetime(msg.get("Date"))
            if msg_date.tzinfo is None:
                msg_date = msg_date.replace(tzinfo=datetime.timezone.utc)
        except Exception:
            msg_date = datetime.datetime.now(datetime.timezone.utc)
        if msg_date < cutoff:
            continue

        for part in msg.walk():
            fname = _clean_filename(part.get_filename())
            if not fname:
                continue
            if not re.search(r"\.(xlsx|xlsm)$", fname, re.I):
                continue
            # Guard: Bobby sends other spreadsheets too. Only accept the master sheet.
            if filename_must_contain and filename_must_contain.lower() not in fname.lower():
                skipped_names.append(fname)
                continue
            payload = part.get_payload(decode=True)
            if payload:
                candidates.append((msg_date, fname, payload))

    imap.logout()

    if not candidates:
        extra = ""
        if skipped_names:
            uniq = ", ".join(sorted(set(skipped_names))[:5])
            extra = (f" Spreadsheets were found but their filenames didn't contain "
                     f"'{filename_must_contain}': {uniq}")
        raise RuntimeError(
            f"No email from '{expected_sender}' with a matching .xlsx/.xlsm attachment "
            f"in the last {max_age_hours}h.{extra}"
        )

    # Always use the MOST RECENT one.
    candidates.sort(key=lambda c: c[0])
    return candidates[-1]  # (date, filename, bytes)


# ---------------------------------------------------------------------------
# 4. Main
# ---------------------------------------------------------------------------

def main():
    user = os.environ["GMAIL_USER"]
    pw = os.environ["GMAIL_APP_PASSWORD"]
    sender = os.environ.get("EXPECTED_SENDER", "").strip()
    subject = os.environ.get("EXPECTED_SUBJECT", "Arrivals sheet").strip()
    fname_match = os.environ.get("FILENAME_MUST_CONTAIN", "Equipment Received").strip()
    max_age = int(os.environ.get("MAX_AGE_HOURS", "26"))
    dry_run = os.environ.get("DRY_RUN", "") == "1"
    force = os.environ.get("FORCE", "") == "1"
    # When the job runs on a schedule we poll several times a morning; "no email yet"
    # is normal and must NOT be treated as a failure.
    soft_missing = os.environ.get("SOFT_IF_MISSING", "1") == "1"

    print(f"[1/5] Looking for newest attachment from '{sender or '(any sender)'}' "
          f"with subject containing '{subject or '(any)'}' "
          f"and filename containing '{fname_match or '(any)'}' …")
    try:
        msg_date, fname, blob = fetch_latest_attachment(user, pw, sender, max_age, subject, fname_match)
    except RuntimeError as e:
        if soft_missing and "No email from" in str(e):
            print(f"      Nothing to import yet — {e}")
            print("      Exiting cleanly (this is normal for an early poll).")
            return
        raise
    print(f"      Found: {fname}  (sent {msg_date.isoformat()}, {len(blob)} bytes)")

    # ---- connect early so we can see whether this exact email is already imported ----
    db = None
    if not dry_run:
        print("[2/5] Connecting to Firestore …")
        sa_info = json.loads(os.environ["FIREBASE_SA_JSON"])
        creds = service_account.Credentials.from_service_account_info(sa_info)
        db = firestore.Client(project=sa_info["project_id"], credentials=creds)

        this_email_ms = int(msg_date.timestamp() * 1000)
        try:
            prev = db.collection("config").document("lastImport").get()
            if prev.exists and not force:
                prev_ms = prev.to_dict().get("emailDateMs")
                if prev_ms and int(prev_ms) == this_email_ms:
                    print("      This exact email was already imported — nothing to do.")
                    print("      (Run manually with force=true to re-import anyway.)")
                    return
        except Exception as e:
            print(f"      (couldn't read previous import marker: {e} — continuing)")

    print("[3/5] Parsing workbook …")
    import io
    wb = openpyxl.load_workbook(io.BytesIO(blob), data_only=True, read_only=True)

    # Structure check: the real master sheet has arrival-style headers. If this workbook
    # doesn't look like it, bail out rather than import junk.
    if not _looks_like_master(wb):
        raise RuntimeError(
            "That workbook doesn't look like the Equipment Received master sheet "
            "(couldn't find the expected 'date received' / 'description' headers). "
            "Aborting so no bad data is written."
        )

    arrivals = []
    for name in wb.sheetnames:
        if re.search(r"rental", name, re.I):
            continue
        arrivals.extend(parse_arrival_sheet(wb[name], name))

    # ---- validation gate: never write nonsense ----
    if not arrivals:
        raise RuntimeError("Parsed 0 arrivals — aborting so no bad data is written.")
    dated = [a for a in arrivals if a["dateReceived"]]
    if len(dated) < max(1, int(len(arrivals) * 0.5)):
        raise RuntimeError(
            f"Only {len(dated)}/{len(arrivals)} rows had a valid date — "
            f"the sheet format may have changed. Aborting."
        )
    print(f"      Parsed {len(arrivals)} arrivals ({len(dated)} with dates).")
    # ---- build docs with the SAME id scheme as the website ----
    docs = {}
    for r in arrivals:
        doc_id = make_id([
            r["dateReceived"], r["po"], norm_job(r["jobNumber"]),
            r["description"][:80],
        ])
        docs[doc_id] = r
    print(f"      {len(docs)} unique arrival documents after de-dupe.")

    if dry_run:
        print("[4/5] DRY_RUN=1 — not writing. Sample IDs:")
        for i, (k, v) in enumerate(list(docs.items())[:5]):
            print(f"        {k}  ->  {v['dateReceived']} | {v['jobNumber']} | {v['description'][:40]}")
        print("[5/5] Dry run complete.")
        return

    print("[4/5] Writing arrivals (merge, batched) …")
    base = int(datetime.datetime.now().timestamp() * 1000) - len(docs)
    batch = db.batch()
    n = 0
    written = 0
    for i, (doc_id, r) in enumerate(docs.items()):
        ref = db.collection("arrivals").document(doc_id)
        payload = dict(r)
        payload["seq"] = base + i
        payload["source"] = "email-auto"
        batch.set(ref, payload, merge=True)
        n += 1
        written += 1
        if n >= 400:
            batch.commit()
            batch = db.batch()
            n = 0
    if n:
        batch.commit()
    print(f"      Done. {written} arrivals written/updated in Firestore.")

    # Record what we imported so the website can show it (mirrors config/lastSync).
    try:
        db.collection("config").document("lastImport").set({
            "at": int(datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000),
            "emailDate": msg_date.isoformat(),
            "emailDateMs": int(msg_date.timestamp() * 1000),
            "sourceFile": fname,
            "count": written,
            "by": "auto (email)",
        }, merge=True)
        print("      Import metadata recorded (config/lastImport).")
    except Exception as e:
        print(f"      WARNING: couldn't record import metadata: {e}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
