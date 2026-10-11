#!/usr/bin/env python3
"""
DocSim web frontend - server.

Serves the dashboard in ./static and exposes a small JSON API that drives the
`docsim` command-line program from the Plagiarism_Project.

* Uses ONLY the Python standard library (Python 3.8+).
* NEVER modifies the Plagiarism_Project folder. The C program is compiled into
  ./bin/ (inside this frontend folder) and uploaded files go to a temp folder.
* The C program prints at most 200 similar pairs, so charts that need more data
  (similarity distribution, scaling studies, ...) are built by running the
  program several times and combining the results here.

Usage:
    python server.py                          # auto-detects ../Plagiarism_Project
    python server.py --project /path/to/Plagiarism_Project --port 8000
"""
import argparse
import json
import os
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, "static")
BIN_DIR = os.path.join(HERE, "bin")
EXE = "docsim.exe" if os.name == "nt" else "docsim"
BIN = os.path.join(BIN_DIR, EXE)
RUNS_DIR = os.path.join(tempfile.gettempdir(), "docsim_frontend_runs")
MAX_BODY = 200 * 1024 * 1024
MAX_VIEW_CHARS = 120_000
MAX_LOG_CHARS = 30_000

STATE = {"project": None, "dataset": None, "tests": None, "origin": None}
RUNS = {}   # run_id -> {"dir", "kind", "src", "total"}
JOBS = {}   # job_id -> Job

# thresholds used to learn the similarity distribution (the C program only
# prints 200 pairs, so we count how many pairs reach each threshold instead)
FULL_GRID = [0.02, 0.05, 0.1, 0.2, 0.3, 0.4, 0.6, 0.8, 1.0]
COARSE_GRID = [0.05, 0.2, 0.4, 0.8]
BIG_CORPUS_PAIRS = 300_000      # above this: fewer sweep passes, no warm-up
PAIR_PRINT_CAP = 200            # docsim -p prints at most this many pairs


# --------------------------------------------------------------------------
# project discovery / build
# --------------------------------------------------------------------------
def find_project(explicit):
    cands = [explicit] if explicit else []
    cands += [os.path.join(HERE, "..", "Plagiarism_Project"),
              os.path.join(HERE, "Plagiarism_Project"),
              os.path.join(os.getcwd(), "Plagiarism_Project")]
    for c in cands:
        if c and os.path.isfile(os.path.join(c, "src", "main.c")):
            return os.path.abspath(c)
    return None


def count_files(d):
    """Mirror the C program: skip names starting with '.', recurse into folders."""
    n = 0
    for _, dirs, fs in os.walk(d):
        dirs[:] = [x for x in dirs if not x.startswith(".")]
        n += sum(1 for f in fs if not f.startswith("."))
    return n


def project_sources():
    proj = STATE["project"]
    return [os.path.join(proj, "src", f) for f in ("main.c", "document.c", "similarity.c")]


def needs_rebuild():
    """True if the compiled program is missing or older than the project's C sources."""
    if not os.path.isfile(BIN):
        return True
    try:
        newest = max(os.path.getmtime(s) for s in project_sources())
        return newest > os.path.getmtime(BIN)
    except OSError:
        return False


def build_binary():
    """Compile the project's sources into ./bin (the project folder is only read)."""
    proj = STATE["project"]
    if not proj:
        return False, "Plagiarism_Project folder not found. Start with --project <path>."
    os.makedirs(BIN_DIR, exist_ok=True)
    cc = os.environ.get("CC") or shutil.which("gcc") or shutil.which("cc") or shutil.which("clang")
    if not cc:
        return False, "No C compiler (gcc) found on PATH. Install gcc/MinGW or set DOCSIM_BIN."
    cmd = [cc, "-O2", "-fopenmp", "-I", os.path.join(proj, "src"), *project_sources(),
           "-o", BIN, "-lm"]
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    except Exception as e:  # noqa
        return False, str(e)
    if p.returncode != 0:
        return False, "Compile failed:\n" + (p.stderr or p.stdout)
    return True, "Built " + BIN


def prebuilt_in_project():
    """Last resort on Windows: use the docsim.exe that ships inside the project."""
    proj = STATE["project"]
    if proj and os.name == "nt":
        p = os.path.join(proj, "docsim.exe")
        if os.path.isfile(p):
            return p
    return None


def ensure_binary():
    override = os.environ.get("DOCSIM_BIN")
    if override and os.path.isfile(override):
        STATE["origin"] = "DOCSIM_BIN"
        return override
    if os.path.isfile(BIN) and not needs_rebuild():
        STATE["origin"] = "compiled from project source"
        return BIN
    ok, msg = build_binary()
    if ok:
        STATE["origin"] = "compiled from project source"
        return BIN
    fb = prebuilt_in_project()
    if fb:
        STATE["origin"] = "project's docsim.exe"
        return fb
    if os.path.isfile(BIN):          # stale but usable
        STATE["origin"] = "compiled from project source (older build)"
        return BIN
    raise RuntimeError(msg)


def refresh_info():
    proj = STATE["project"]
    STATE["dataset"] = STATE["tests"] = None
    if not proj:
        return
    for sub in ("dataset/pan11/en", "dataset/pan11", "dataset"):
        p = os.path.join(proj, *sub.split("/"))
        if os.path.isdir(p):
            STATE["dataset"] = p
            break
    t = os.path.join(proj, "tests")
    if os.path.isdir(t):
        STATE["tests"] = t


# --------------------------------------------------------------------------
# parsing docsim output
# --------------------------------------------------------------------------
KV = re.compile(r"^([A-Za-z][A-Za-z /()%.-]*?)\s*:\s+(.*)$")
REP = re.compile(r"^Rep (\d+): compare time = ([0-9.eE+-]+) s, similar pairs = (\d+)")
PAIR_HDR = re.compile(r"Similar pairs \(showing (\d+) of (\d+)\)")
CHECK = re.compile(r"^\s*\[(PASS|FAIL)\]\s+(.*)$")


def num(s):
    m = re.match(r"\s*(-?[0-9.]+(?:[eE][+-]?\d+)?)", s or "")
    return float(m.group(1)) if m else None


def parse_output(out):
    info, reps, pairs, checks = {}, [], [], []
    shown = total = None
    for raw in out.splitlines():
        line = raw.rstrip("\r")
        m = REP.match(line)
        if m:
            reps.append({"rep": int(m.group(1)), "seconds": float(m.group(2)),
                         "similar": int(m.group(3))})
            continue
        m = PAIR_HDR.search(line)
        if m:
            shown, total = int(m.group(1)), int(m.group(2))
            continue
        m = CHECK.match(line)
        if m:
            checks.append({"ok": m.group(1) == "PASS", "text": m.group(2)})
            continue
        if "  <->  " in line:
            left, right = line.split("  <->  ", 1)
            parts = left.strip().split(None, 1)
            try:
                sim = float(parts[0])
                a = parts[1].strip()
            except (ValueError, IndexError):
                continue
            pairs.append({"sim": sim, "a": a, "b": right.strip()})
            continue
        m = KV.match(line)
        if m:
            info[m.group(1).strip()] = m.group(2).strip()
    res = {"info": info, "reps": reps, "pairs": pairs, "checks": checks,
           "pairs_shown": shown, "pairs_total": total}
    if "RESULT: CHECK PASSED" in out:
        res["check_result"] = "passed"
    elif "RESULT: CHECK FAILED" in out:
        res["check_result"] = "failed"
    return res


def stats_of(times):
    if not times:
        return {"times": [], "mean": None, "stdev": 0.0, "min": None}
    return {"times": times, "mean": statistics.fmean(times),
            "stdev": statistics.stdev(times) if len(times) > 1 else 0.0,
            "min": min(times)}


# --------------------------------------------------------------------------
# jobs (one docsim job at a time so that timings stay honest)
# --------------------------------------------------------------------------
class Cancelled(Exception):
    pass


class Busy(Exception):
    pass


class Job:
    def __init__(self, kind):
        self.id = uuid.uuid4().hex[:12]
        self.kind = kind
        self.status = "queued"
        self.done = 0
        self.total = 1
        self.label = "Starting…"
        self.result = None
        self.error = None
        self.cancel = threading.Event()
        self.proc = None
        self.log = []
        self.created = time.time()

    def begin(self, label):
        self.label = label

    def tick(self):
        self.done += 1

    def public(self):
        d = {"id": self.id, "kind": self.kind, "status": self.status,
             "progress": {"done": min(self.done, self.total), "total": self.total,
                          "label": self.label},
             "elapsed": time.time() - self.created}
        if self.status == "done":
            d["result"] = self.result
        if self.status == "error":
            d["error"] = self.error
        return d


CURRENT = {"job": None}
START_MUTEX = threading.Lock()


def start_job(kind, body):
    runner = {"analyze": job_analyze, "scaling": job_scaling,
              "schedules": job_schedules}.get(kind)
    if not runner:
        raise ValueError("Unknown job type")
    with START_MUTEX:
        cur = CURRENT["job"]
        if cur and cur.status in ("queued", "running"):
            raise Busy("Another job is still running. Wait for it to finish or cancel it.")
        job = Job(kind)
        CURRENT["job"] = job
        JOBS[job.id] = job
        for jid in sorted(JOBS, key=lambda k: JOBS[k].created)[:-20]:
            JOBS.pop(jid, None)

    def work():
        job.status = "running"
        try:
            job.result = runner(job, body)
            job.status = "done"
        except Cancelled:
            job.status = "cancelled"
            job.label = "Cancelled"
        except Exception as e:  # noqa
            traceback.print_exc()
            job.status = "error"
            job.error = str(e)
        finally:
            job.proc = None

    threading.Thread(target=work, daemon=True).start()
    return job


def cancel_job(job_id):
    job = JOBS.get(job_id)
    if not job:
        raise ValueError("unknown job")
    job.cancel.set()
    p = job.proc
    if p is not None:
        try:
            p.terminate()
        except Exception:  # noqa
            pass
    return job


# --------------------------------------------------------------------------
# running docsim
# --------------------------------------------------------------------------
def clean_opts(o):
    cpu = os.cpu_count() or 1

    def geti(key, default, lo, hi):
        try:
            v = int(float(o.get(key, default)))
        except (TypeError, ValueError):
            v = default
        return min(hi, max(lo, v))

    try:
        th = float(o.get("threshold", 0.8))
    except (TypeError, ValueError):
        th = 0.8
    sched = o.get("schedule", "dynamic")
    if sched not in ("static", "dynamic", "guided"):
        raise ValueError("bad schedule")
    counts = o.get("thread_counts") or [1, 2, 4, 8]
    try:
        counts = sorted({min(256, max(1, int(c))) for c in counts})[:8]
    except (TypeError, ValueError):
        counts = [1, 2, 4, 8]
    if not counts:
        counts = [1]
    return {
        "threshold": min(1.0, max(0.0, th)),
        "k": geti("k", 3, 1, 8),
        "reps": geti("reps", 3, 1, 20),
        "schedule": sched,
        "chunk": geti("chunk", 0, 0, 1_000_000),
        "max_bytes": geti("max_bytes", 0, 0, 1 << 40),
        "n_docs": geti("n_docs", 0, 0, 10_000_000),
        "thread_counts": counts,
        "verify": bool(o.get("verify", True)),
        "distribution": bool(o.get("distribution", True)),
        "cpu": cpu,
    }


def docsim_args(exe, folder, o, mode, threads=1, th=None, reps=1, warmup=0,
                pairs=False, n_docs=None, sched=None):
    th = o["threshold"] if th is None else th
    n_docs = o["n_docs"] if n_docs is None else n_docs
    args = [exe, folder, "-m", mode, "-th", repr(float(th)),
            "-s", sched or o["schedule"], "-t", str(max(1, int(threads))),
            "-k", str(o["k"]), "-r", str(max(1, int(reps))), "-w", str(max(0, int(warmup)))]
    if n_docs and n_docs > 0:
        args += ["-n", str(int(n_docs))]
    if o["chunk"] > 0:
        args += ["-c", str(o["chunk"])]
    if o["max_bytes"] > 0:
        args += ["-b", str(o["max_bytes"])]
    if pairs:
        args.append("-p")
    return args


def run_docsim(job, folder, o, label, **kw):
    """Run one docsim process, parse it, keep a log entry for the Console panel."""
    if job.cancel.is_set():
        raise Cancelled()
    exe = ensure_binary()
    args = docsim_args(exe, folder, o, **kw)
    t0 = time.perf_counter()
    p = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                         text=True, encoding="utf-8", errors="replace")
    job.proc = p
    try:
        out, err = p.communicate(timeout=3600)
    except subprocess.TimeoutExpired:
        p.kill()
        p.communicate()
        raise RuntimeError("docsim took longer than 1 hour and was stopped.")
    finally:
        job.proc = None
    if job.cancel.is_set():
        raise Cancelled()
    wall = time.perf_counter() - t0
    if p.returncode != 0 and not out.strip():
        raise RuntimeError((err or "docsim failed").strip())
    r = parse_output(out)
    cmd = " ".join(os.path.basename(a) if i == 0 else a for i, a in enumerate(args))
    raw = out + (("\n[stderr]\n" + err) if err.strip() else "")
    if len(raw) > MAX_LOG_CHARS:
        raw = raw[:MAX_LOG_CHARS] + "\n… (output shortened)"
    job.log.append({"label": label, "command": cmd, "output": raw, "seconds": wall})
    r["returncode"] = p.returncode
    r["wall_seconds"] = wall
    r["times"] = [x["seconds"] for x in r["reps"]]
    r["similar"] = r["reps"][-1]["similar"] if r["reps"] else None
    return r


def info_numbers(info):
    return {
        "documents": int(num(info.get("Documents")) or 0),
        "pairs": int(num(info.get("Pairs to compare")) or 0),
        "bytes": int(num(info.get("Bytes read (total)")) or 0),
        "avg_shingles": num(info.get("Avg shingles / doc")) or 0.0,
        "read_s": num(info.get("File read time")) or 0.0,
        "preprocess_s": num(info.get("Preprocessing time")) or 0.0,
    }


def safe_name(name, used):
    name = os.path.basename(str(name).replace("\\", "/"))
    name = re.sub(r"[^\w.\- ]", "_", name).strip() or "document.txt"
    if name.startswith("."):
        name = "_" + name
    base, ext = os.path.splitext(name)
    cand, i = name, 2
    while cand.lower() in used:
        cand = f"{base}_{i}{ext}"
        i += 1
    used.add(cand.lower())
    return cand


def cleanup_old_runs(keep=30):
    try:
        uploads = [(rid, m) for rid, m in RUNS.items() if m["kind"] == "upload"]
        uploads.sort(key=lambda kv: os.path.getmtime(kv[1]["dir"]))
        for rid, meta in uploads[:-keep]:
            shutil.rmtree(meta["dir"], ignore_errors=True)
            RUNS.pop(rid, None)
    except Exception:  # noqa
        pass


def prepare_source(body):
    """Return (run_id, folder, total_docs_available)."""
    src = body.get("source")
    run_id = uuid.uuid4().hex[:12]
    if src == "upload":
        files = body.get("files") or []
        if len(files) < 2:
            raise ValueError("Add at least 2 documents.")
        d = os.path.join(RUNS_DIR, run_id)
        os.makedirs(d, exist_ok=True)
        used = set()
        for f in files:
            nm = safe_name(f.get("name", "doc.txt"), used)
            with open(os.path.join(d, nm), "w", encoding="utf-8", newline="") as fh:
                fh.write(f.get("text", ""))
        RUNS[run_id] = {"dir": d, "kind": "upload", "src": src, "total": len(files)}
        cleanup_old_runs()
        return run_id, d, len(files)
    if src in ("dataset", "tests"):
        folder = STATE["dataset"] if src == "dataset" else STATE["tests"]
        if not folder:
            raise ValueError(f"The '{src}' folder was not found in the project.")
        total = count_files(folder)
        RUNS[run_id] = {"dir": folder, "kind": "folder", "src": src, "total": total}
        return run_id, folder, total
    raise ValueError("Unknown source")


def existing_source(body):
    """Reuse the documents of an earlier analysis (run_id) or load the source again."""
    rid = body.get("run_id")
    meta = RUNS.get(rid)
    if meta and os.path.isdir(meta["dir"]):
        return rid, meta["dir"], meta["total"]
    if body.get("source"):
        return prepare_source(body)
    raise ValueError("Choose some documents first.")


def effective_docs(src, opts, total):
    n = opts["n_docs"] if src == "dataset" else 0
    return total if n <= 0 else min(n, total)


# --------------------------------------------------------------------------
# job: full analysis
# --------------------------------------------------------------------------
def job_analyze(job, body):
    t_start = time.perf_counter()
    opts = clean_opts(body.get("options", {}))
    src = body.get("source")
    run_id, folder, total = prepare_source(body)
    n = effective_docs(src, opts, total)
    if n < 2:
        raise ValueError("Need at least 2 documents.")
    pairs_total = n * (n - 1) // 2
    th, reps, tlist = opts["threshold"], opts["reps"], opts["thread_counts"]
    tmax = max(tlist)
    warm = 1 if pairs_total <= BIG_CORPUS_PAIRS else 0
    small = n <= 20                     # <=190 pairs: fits inside docsim's 200-pair print cap
    grid = None
    if opts["distribution"] and not small:
        grid = FULL_GRID if pairs_total <= BIG_CORPUS_PAIRS else COARSE_GRID
    do_verify = opts["verify"] and pairs_total <= 3_000_000

    job.total = 1 + len(tlist) + (1 if do_verify else 0) + (1 if small else 0) \
        + (len(grid) + 1 if grid else 0)

    # 1) sequential baseline --------------------------------------------------
    job.begin("Sequential baseline")
    base = run_docsim(job, folder, opts, "Sequential baseline", mode="seq", reps=reps,
                      warmup=warm, pairs=True)
    job.tick()
    meta = info_numbers(base["info"])
    n = meta["documents"] or n
    pairs_total = meta["pairs"] or pairs_total
    seq = stats_of(base["times"])
    seq["similar"] = base["similar"]

    # 2) OpenMP at every requested thread count -----------------------------------
    omp_rows = []
    cpus_seen = None
    base_key = [(p["sim"], p["a"], p["b"]) for p in base["pairs"]]
    for t in tlist:
        job.begin(f"OpenMP with {t} thread{'s' if t != 1 else ''}")
        r = run_docsim(job, folder, opts, f"OpenMP, {t} thread(s)", mode="omp", threads=t,
                       reps=reps, warmup=warm, pairs=True)
        job.tick()
        cpus_seen = r["info"].get("Logical CPUs seen", cpus_seen)
        st = stats_of(r["times"])
        same = (r["similar"] == base["similar"] and
                [(p["sim"], p["a"], p["b"]) for p in r["pairs"]] == base_key)
        st.update({"threads": t, "similar": r["similar"], "correct": bool(same),
                   "speedup": (seq["mean"] / st["mean"]) if (seq["mean"] and st["mean"]) else None})
        st["efficiency"] = (st["speedup"] / t) if st["speedup"] else None
        omp_rows.append(st)

    # 3) full correctness check (the C program's own `check` mode) ---------------
    correctness = {"ran": False, "passed": None, "checks": [], "threads": tmax}
    if do_verify:
        job.begin(f"Verifying sequential = OpenMP ({tmax} threads)")
        c = run_docsim(job, folder, opts, f"Correctness check, {tmax} thread(s)",
                       mode="check", threads=tmax)
        job.tick()
        correctness.update({"ran": True, "passed": c.get("check_result") == "passed",
                            "checks": c["checks"]})
    elif opts["verify"]:
        correctness["note"] = "Skipped: too many pairs for the full check on this machine."

    # 4) similarity distribution + ranked pair list ----------------------------
    distribution = {"mode": "none"}
    pair_list, list_th, list_complete, list_total = base["pairs"], th, True, base["similar"]
    list_complete = (base["similar"] or 0) <= PAIR_PRINT_CAP

    if small:
        job.begin("Reading every pair similarity")
        r = run_docsim(job, folder, opts, "All pair similarities", mode="seq", th=0.0,
                       pairs=True)
        job.tick()
        pair_list, list_th, list_complete, list_total = r["pairs"], 0.0, True, len(r["pairs"])
        edges = [g for g in FULL_GRID]
        ge = {g: sum(1 for p in pair_list if p["sim"] >= g - 5e-7) for g in edges}
        distribution = build_distribution("exact", edges, ge, len(pair_list))
    elif grid:
        ge = {}
        for g in grid:
            job.begin(f"Counting pairs with similarity ≥ {g:g}")
            r = run_docsim(job, folder, opts, f"Distribution sweep, threshold {g:g}",
                           mode="omp", threads=tmax, th=g, reps=1, warmup=0)
            job.tick()
            ge[g] = r["similar"] or 0
        distribution = build_distribution("sweep", grid, ge, pairs_total)
        if (base["similar"] or 0) > PAIR_PRINT_CAP:
            job.begin("Collecting the most similar pairs")
            cand = [g for g in grid if g > th]
            pick = next((g for g in cand if ge[g] <= PAIR_PRINT_CAP), cand[-1] if cand else None)
            if pick is not None:
                r = run_docsim(job, folder, opts, f"Most similar pairs (≥ {pick:g})",
                               mode="omp", threads=tmax, th=pick, reps=1, pairs=True)
                pair_list, list_th, list_total = r["pairs"], pick, ge[pick]
                list_complete = ge[pick] <= PAIR_PRINT_CAP
            else:
                list_th, list_total = th, base["similar"]
                list_complete = False
        job.tick()

    return {
        "run_id": run_id, "source": src, "elapsed": time.perf_counter() - t_start,
        "options": {k: opts[k] for k in ("threshold", "k", "reps", "schedule", "chunk",
                                         "max_bytes", "n_docs", "thread_counts")},
        "meta": dict(meta, mode_line=base["info"].get("Mode", ""),
                     cpu_count=opts["cpu"],
                     logical_cpus_seen=cpus_seen),
        "sequential": seq, "openmp": omp_rows, "correctness": correctness,
        "pairs": pair_list, "pairs_threshold": list_th, "pairs_complete": list_complete,
        "pairs_total_at_threshold": list_total,
        "complete_matrix": small, "distribution": distribution,
        "console": job.log,
    }


def build_distribution(mode, grid, ge, total):
    """Turn 'how many pairs reach each threshold' into histogram buckets."""
    edges = [0.0] + [g for g in grid if g < 1.0] + [1.0]
    ge_at = dict(ge)
    ge_at[0.0] = total
    buckets = []
    for i in range(len(edges) - 1):
        lo, hi = edges[i], edges[i + 1]
        last = i == len(edges) - 2
        cnt = ge_at[lo] - (0 if last else ge_at[hi])
        buckets.append({"lo": lo, "hi": hi, "count": max(0, cnt)})
    return {"mode": mode, "buckets": buckets, "total": total,
            "ge": {str(k): v for k, v in sorted(ge.items())},
            "identical": ge.get(1.0)}


# --------------------------------------------------------------------------
# job: scaling with corpus size
# --------------------------------------------------------------------------
def make_ladder(m):
    if m <= 8:
        return list(range(2, m + 1))
    vals, n = set(), m
    for _ in range(8):
        vals.add(n)
        n //= 2
    return sorted(v for v in vals if v >= 4)


def job_scaling(job, body):
    t_start = time.perf_counter()
    opts = clean_opts(body.get("options", {}))
    run_id, folder, total = existing_source(body)
    try:
        max_docs = int(body.get("max_docs") or total)
    except (TypeError, ValueError):
        max_docs = total
    max_docs = min(total, max(2, max_docs))
    threads = max(1, int(body.get("threads") or max(opts["thread_counts"])))
    ladder = make_ladder(max_docs)
    job.total = len(ladder) * 2
    rows = []
    for n in ladder:
        pairs = n * (n - 1) // 2
        reps = opts["reps"] if pairs <= 100_000 else 1
        warm = 1 if pairs <= 30_000 else 0
        job.begin(f"{n:,} documents · sequential")
        s = run_docsim(job, folder, opts, f"Scaling, {n} docs, sequential", mode="seq",
                       n_docs=n, reps=reps, warmup=warm)
        job.tick()
        job.begin(f"{n:,} documents · OpenMP, {threads} threads")
        p = run_docsim(job, folder, opts, f"Scaling, {n} docs, OpenMP {threads}", mode="omp",
                       threads=threads, n_docs=n, reps=reps, warmup=warm)
        job.tick()
        ss, ps = stats_of(s["times"]), stats_of(p["times"])
        rows.append({"docs": n, "pairs": pairs, "seq": ss["mean"], "omp": ps["mean"],
                     "speedup": (ss["mean"] / ps["mean"]) if (ss["mean"] and ps["mean"]) else None,
                     "similar": s["similar"], "same_count": s["similar"] == p["similar"]})
    return {"run_id": run_id, "rows": rows, "threads": threads, "threshold": opts["threshold"],
            "elapsed": time.perf_counter() - t_start, "console": job.log}


# --------------------------------------------------------------------------
# job: schedule comparison
# --------------------------------------------------------------------------
def job_schedules(job, body):
    t_start = time.perf_counter()
    opts = clean_opts(body.get("options", {}))
    src = body.get("source")
    run_id, folder, total = existing_source(body)
    n = effective_docs(src or RUNS[run_id]["src"], opts, total)
    pairs_total = n * (n - 1) // 2
    reps = opts["reps"]
    warm = 1 if pairs_total <= BIG_CORPUS_PAIRS else 0
    threads = max(1, int(body.get("threads") or max(opts["thread_counts"])))
    job.total = 4
    job.begin("Sequential baseline")
    s = run_docsim(job, folder, opts, "Sequential baseline", mode="seq", reps=reps, warmup=warm)
    job.tick()
    seq = stats_of(s["times"])
    rows = []
    for sched in ("static", "dynamic", "guided"):
        job.begin(f"schedule({sched}) · {threads} threads")
        r = run_docsim(job, folder, opts, f"schedule({sched}), {threads} thread(s)", mode="omp",
                       threads=threads, reps=reps, warmup=warm, sched=sched)
        job.tick()
        st = stats_of(r["times"])
        st.update({"schedule": sched, "similar": r["similar"],
                   "speedup": (seq["mean"] / st["mean"]) if (seq["mean"] and st["mean"]) else None})
        rows.append(st)
    return {"run_id": run_id, "sequential": seq, "rows": rows, "threads": threads, "docs": n,
            "elapsed": time.perf_counter() - t_start, "console": job.log}


# --------------------------------------------------------------------------
# small read-only API
# --------------------------------------------------------------------------
def api_info():
    proj = STATE["project"]
    ds, tests = STATE["dataset"], STATE["tests"]
    built = os.path.isfile(BIN) or bool(os.environ.get("DOCSIM_BIN"))
    return {
        "project": proj, "built": built, "origin": STATE["origin"],
        "cpu_count": os.cpu_count() or 1,
        "dataset": {"path": ds, "files": count_files(ds)} if ds else None,
        "tests": {"path": tests,
                  "files": sorted(f for f in os.listdir(tests) if not f.startswith("."))} if tests else None,
        "max_k": 8,
    }


def find_in_dir(root, name):
    for dp, dirs, fs in os.walk(root):
        dirs[:] = [x for x in dirs if not x.startswith(".")]
        if name in fs:
            return os.path.join(dp, name)
    return None


def api_doc(q):
    rid = q.get("run", [""])[0]
    name = os.path.basename(q.get("name", [""])[0])
    try:
        limit = int(q.get("bytes", ["0"])[0])
    except ValueError:
        limit = 0
    meta = RUNS.get(rid)
    if not meta or not name:
        raise ValueError("unknown run / file")
    path = find_in_dir(meta["dir"], name)
    if not path:
        raise ValueError("file not found")
    cap = limit if limit > 0 else MAX_VIEW_CHARS * 2
    with open(path, "rb") as fh:
        data = fh.read(cap)
    text = data.decode("utf-8", errors="replace")
    truncated = os.path.getsize(path) > len(data) or len(text) > MAX_VIEW_CHARS
    return {"name": name, "text": text[:MAX_VIEW_CHARS], "truncated": truncated,
            "size": os.path.getsize(path)}


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------
MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json"}


class Handler(BaseHTTPRequestHandler):
    server_version = "DocSimUI/2.0"

    def log_message(self, fmt, *a):
        try:
            if a and "/api/job?" in str(a[0]):      # don't flood the console with polling
                return
            sys.stderr.write("  " + (fmt % a) + "\n")
        except Exception:  # noqa  (logging must never break a request)
            pass

    def send_json(self, obj, code=200):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        u = urlparse(self.path)
        try:
            if u.path == "/api/info":
                return self.send_json(api_info())
            if u.path == "/api/doc":
                return self.send_json(api_doc(parse_qs(u.query)))
            if u.path == "/api/job":
                job = JOBS.get(parse_qs(u.query).get("id", [""])[0])
                if not job:
                    return self.send_json({"error": "unknown job"}, 404)
                return self.send_json(job.public())
            rel = "index.html" if u.path in ("/", "") else u.path.lstrip("/")
            full = os.path.abspath(os.path.join(STATIC, rel))
            if not full.startswith(STATIC + os.sep) or not os.path.isfile(full):
                self.send_response(404)
                self.end_headers()
                return
            with open(full, "rb") as fh:
                data = fh.read()
            self.send_response(200)
            self.send_header("Content-Type", MIME.get(os.path.splitext(full)[1], "application/octet-stream"))
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:  # noqa
            self.send_json({"error": str(e)}, 400)

    def do_POST(self):
        u = urlparse(self.path)
        try:
            n = int(self.headers.get("Content-Length", 0))
            if n > MAX_BODY:
                return self.send_json({"error": "Upload too large"}, 413)
            body = json.loads(self.rfile.read(n) or b"{}")
            if u.path == "/api/jobs":
                job = start_job(body.get("type", "analyze"), body)
                return self.send_json({"job_id": job.id})
            if u.path == "/api/jobs/cancel":
                job = cancel_job(body.get("job_id", ""))
                return self.send_json({"ok": True, "status": job.status})
            if u.path == "/api/build":
                cur = CURRENT["job"]
                if cur and cur.status in ("queued", "running"):
                    raise Busy("A job is running; try again when it has finished.")
                if os.path.isfile(BIN):
                    os.remove(BIN)
                ok, msg = build_binary()
                if ok:
                    STATE["origin"] = "compiled from project source"
                return self.send_json({"ok": ok, "message": msg}, 200 if ok else 500)
            self.send_json({"error": "not found"}, 404)
        except Busy as e:
            self.send_json({"error": str(e)}, 409)
        except Exception as e:  # noqa
            self.send_json({"error": str(e)}, 400)


def main():
    ap = argparse.ArgumentParser(description="DocSim web frontend")
    ap.add_argument("--project", help="path to the Plagiarism_Project folder")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="127.0.0.1")
    a = ap.parse_args()
    STATE["project"] = find_project(a.project)
    refresh_info()
    print("DocSim frontend")
    print("  project :", STATE["project"] or "NOT FOUND (use --project)")
    if STATE["project"]:
        try:
            exe = ensure_binary()
            print(f"  program : {exe}  ({STATE['origin']})")
        except Exception as e:  # noqa
            print("  program : NOT AVAILABLE\n  " + str(e).replace("\n", "\n  "))
    os.makedirs(RUNS_DIR, exist_ok=True)
    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    print(f"  open    : http://{a.host}:{a.port}\n  (Ctrl+C to stop)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
