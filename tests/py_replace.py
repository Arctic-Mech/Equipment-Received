#!/usr/bin/env python3
"""Unit test for the importer's replace/delete behavior (email_import.py).

An import must DELETE rows that fell out of the newer file, but only rows the importer itself wrote
(source in IMPORT_SOURCES). Hand-logged rows (source="manual") and anything untagged must survive.
Runs headless with a fake Firestore — no network, no credentials."""
import sys, types, importlib.util, os

# Stub the third-party imports so the module loads without them installed.
for name in ["openpyxl", "pdfplumber"]:
    sys.modules[name] = types.ModuleType(name)
g = types.ModuleType("google"); gc = types.ModuleType("google.cloud"); go = types.ModuleType("google.oauth2")
gc.firestore = types.SimpleNamespace(Client=object, SERVER_TIMESTAMP=object())
go.service_account = types.SimpleNamespace(
    Credentials=types.SimpleNamespace(from_service_account_info=staticmethod(lambda x: None)))
sys.modules["google"] = g; sys.modules["google.cloud"] = gc; sys.modules["google.oauth2"] = go
sys.modules["google.cloud.firestore"] = gc.firestore; sys.modules["google.oauth2.service_account"] = go.service_account

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("ei", os.path.join(HERE, "..", "email_import.py"))
ei = importlib.util.module_from_spec(spec); spec.loader.exec_module(ei)

fails = []
def chk(c, m):
    if not c: fails.append(m)

# ---- 1. the pure predicate ----
existing = [
    ("a1", "email-auto"),   # written by the email importer, not in the new file -> delete
    ("a2", "email-auto"),   # still in the new file -> keep
    ("a3", "import"),       # written by the in-app import, not in the new file -> delete
    ("m1", "manual"),       # hand-logged -> ALWAYS keep
    ("x1", None),           # untagged legacy -> keep (we don't delete what we can't attribute)
    ("x2", "something-else"),# unknown source -> keep
]
keep = {"a2"}
stale = set(ei._stale_import_ids(existing, keep))
print("stale ids:", sorted(stale))
chk(stale == {"a1", "a3"}, f"expected to drop only a1,a3; got {sorted(stale)}")
chk("m1" not in stale, "a hand-logged (manual) row was marked for deletion")
chk("x1" not in stale and "x2" not in stale, "an untagged/unknown row was marked for deletion")
chk("a2" not in stale, "a row still present in the file was marked for deletion")

# ---- 2. _delete_missing drives a batched delete against a fake Firestore ----
class Ref:
    def __init__(self, coll, i): self.coll, self.id = coll, i
class Snap:
    def __init__(self, i, data): self.id, self._d = i, data
    def to_dict(self): return self._d
class Coll:
    def __init__(self, docs): self._docs = docs
    def stream(self): return [Snap(i, d) for i, d in self._docs.items()]
    def document(self, i): return Ref("c", i)
class Batch:
    def __init__(self, sink): self.sink = sink
    def delete(self, ref): self.sink.append(ref.id)
    def commit(self): pass
class FakeDB:
    def __init__(self, docs): self._docs = docs; self.deleted = []
    def collection(self, name): return Coll(self._docs)
    def batch(self): return Batch(self.deleted)

db = FakeDB({
    "a1": {"source": "email-auto", "description": "gone from sheet"},
    "a2": {"source": "email-auto", "description": "still here"},
    "a3": {"source": "import",     "description": "gone, in-app origin"},
    "m1": {"source": "manual",     "description": "logged by hand"},
    "x1": {"description": "legacy, no source"},
})
removed = ei._delete_missing(db, "arrivals", {"a2"})
print("deleted:", sorted(db.deleted), "count:", removed)
chk(removed == 2, f"_delete_missing should report 2, got {removed}")
chk(set(db.deleted) == {"a1", "a3"}, f"_delete_missing deleted the wrong set: {sorted(db.deleted)}")

# ---- 3. batching past the 400 limit ----
big = {f"e{i}": {"source": "email-auto"} for i in range(950)}
big["keep"] = {"source": "email-auto"}
db2 = FakeDB(big)
removed2 = ei._delete_missing(db2, "arrivals", {"keep"})
chk(removed2 == 950, f"expected 950 deleted across batches, got {removed2}")
chk(len(db2.deleted) == 950, f"batched delete lost rows: {len(db2.deleted)}")

# ---- 4. an empty import never wipes a category (wrong/partial file guard) ----
db3 = FakeDB({"a1": {"source": "email-auto"}, "a2": {"source": "import"}})
removed3 = ei._delete_missing(db3, "rentals", set())    # the file carried no rows for this category
chk(removed3 == 0, f"an empty import deleted rows: {removed3}")
chk(db3.deleted == [], "an empty import must not delete anything")
print("empty-import guard: nothing deleted")

print("=" * 50)
if fails:
    print("FAILURES:"); [print("  - " + f) for f in fails]; print("FAIL  py_replace")
    sys.exit(1)
print("PASS  py_replace")
