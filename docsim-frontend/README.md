# DocSim website

Web dashboard for **Plagiarism_Project** (word-phrase shingles + Jaccard similarity, sequential vs OpenMP).
It does not modify the project: the C sources are compiled into `docsim-frontend/bin/`.

## Run
Keep both folders side by side:

    DocSim/
      Plagiarism_Project/
      docsim-frontend/

From `docsim-frontend/`:

    python server.py          (Windows: double-click run.bat | Linux/macOS: ./run.sh)

Open http://127.0.0.1:8000. Needs Python 3.8+ (no pip installs) and gcc with OpenMP
(MinGW-w64 on Windows). If no compiler is found on Windows, the project's own docsim.exe is used.
Custom location: python server.py --project "C:\path\to\Plagiarism_Project" --port 8000

## What you get
- Upload / paste documents, the project's tests/ samples, or the PAN11 dataset (first N docs)
- Correctness banner: OpenMP vs sequential for every thread count, plus the program's own check mode
- Closest-match highlight strips, similarity-band bar, similarity histogram (linear/log)
- Ranked similar pairs, most-flagged documents, pair matrix, CSV / JSON export
- Timing table and charts: time vs threads, speed-up vs ideal, efficiency
- Scaling study (time and speed-up vs corpus size) and static/dynamic/guided schedule comparison
- Side-by-side compare drawer with shared phrases highlighted
- Raw program output for every run

## Notes
- docsim prints at most 200 pairs, so the distribution and scaling charts are built from several runs.
- One job runs at a time so timings stay honest. Real speed-ups need a multi-core CPU.
