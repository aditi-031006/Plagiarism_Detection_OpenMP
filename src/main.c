/* docsim - document similarity (word 3-gram shingles + Jaccard)
 *
 * Modes:
 *   seq    sequential baseline (no OpenMP directives)
 *   omp    OpenMP version
 *   check  runs BOTH and verifies they give the same results
 */
#include <math.h>
#include <omp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#include "document.h"
#include "similarity.h"

typedef struct {
    const char *dir;
    const char *mode;       /* seq | omp | check */
    int         n_docs;     /* 0 = all */
    int         threads;
    double      threshold;
    const char *sched;      /* static | dynamic | guided */
    int         chunk;      /* -1 = default for the chosen schedule */
    size_t      max_bytes;  /* 0 = whole file */
    int         reps;
    int         warmup;
    int         k;
    const char *csv;
    int         print_pairs;
} Config;

static void usage(const char *prog)
{
    printf("Usage: %s <input_dir> [options]\n\n"
           "  -m <seq|omp|check>   mode (default: seq)\n"
           "  -n <N>               use the first N files (sorted by path); default: all\n"
           "  -t <threads>         OpenMP threads (default: omp_get_max_threads())\n"
           "  -th <0..1>           similarity threshold (default: 0.80)\n"
           "  -s <static|dynamic|guided>  OpenMP schedule (default: dynamic)\n"
           "  -c <chunk>           schedule chunk size (default: 1 dynamic/guided, auto for static)\n"
           "  -b <bytes>           read only the first <bytes> bytes of every file (default: all)\n"
           "  -k <1..%d>            shingle size in words (default: 3)\n"
           "  -r <reps>            timed repetitions of the compare phase (default: 1)\n"
           "  -w <warmups>         untimed warm-up runs before timing (default: 0)\n"
           "  --csv <file>         append one CSV row per repetition\n"
           "  -p                   print the similar pairs found (first 200)\n",
           prog, MAX_SHINGLE_K);
}

static int parse_long(const char *s, long min, long *out)
{
    char *end;
    long v = strtol(s, &end, 10);
    if (*s == '\0' || *end != '\0' || v < min) return -1;
    *out = v;
    return 0;
}

static int parse_args(int argc, char **argv, Config *c)
{
    c->dir = NULL; c->mode = "seq"; c->n_docs = 0;
    c->threads = omp_get_max_threads(); c->threshold = 0.80;
    c->sched = "dynamic"; c->chunk = -1; c->max_bytes = 0;
    c->reps = 1; c->warmup = 0; c->k = 3; c->csv = NULL; c->print_pairs = 0;

    for (int a = 1; a < argc; a++) {
        const char *opt = argv[a];
        long v;
        if (strcmp(opt, "-p") == 0) { c->print_pairs = 1; continue; }
        if (opt[0] != '-') {
            if (c->dir) { fprintf(stderr, "Unexpected argument: %s\n", opt); return -1; }
            c->dir = opt;
            continue;
        }
        if (a + 1 >= argc) { fprintf(stderr, "Option %s needs a value\n", opt); return -1; }
        const char *val = argv[++a];

        if      (strcmp(opt, "-m") == 0)  c->mode = val;
        else if (strcmp(opt, "-s") == 0)  c->sched = val;
        else if (strcmp(opt, "--csv") == 0) c->csv = val;
        else if (strcmp(opt, "-th") == 0) {
            char *end;
            c->threshold = strtod(val, &end);
            if (*val == '\0' || *end != '\0' || c->threshold < 0.0 || c->threshold > 1.0) {
                fprintf(stderr, "Threshold must be a number in [0,1]\n"); return -1;
            }
        }
        else if (strcmp(opt, "-n") == 0) { if (parse_long(val, 0, &v)) goto bad; c->n_docs = (int)v; }
        else if (strcmp(opt, "-t") == 0) { if (parse_long(val, 1, &v)) goto bad; c->threads = (int)v; }
        else if (strcmp(opt, "-c") == 0) { if (parse_long(val, 1, &v)) goto bad; c->chunk = (int)v; }
        else if (strcmp(opt, "-b") == 0) { if (parse_long(val, 0, &v)) goto bad; c->max_bytes = (size_t)v; }
        else if (strcmp(opt, "-k") == 0) { if (parse_long(val, 1, &v)) goto bad; c->k = (int)v; }
        else if (strcmp(opt, "-r") == 0) { if (parse_long(val, 1, &v)) goto bad; c->reps = (int)v; }
        else if (strcmp(opt, "-w") == 0) { if (parse_long(val, 0, &v)) goto bad; c->warmup = (int)v; }
        else { fprintf(stderr, "Unknown option: %s\n", opt); return -1; }
        continue;
    bad:
        fprintf(stderr, "Invalid value '%s' for %s\n", val, opt);
        return -1;
    }

    if (!c->dir) { fprintf(stderr, "Missing input directory\n"); return -1; }
    if (strcmp(c->mode, "seq") && strcmp(c->mode, "omp") && strcmp(c->mode, "check")) {
        fprintf(stderr, "Mode must be seq, omp or check\n"); return -1;
    }
    if (strcmp(c->sched, "static") && strcmp(c->sched, "dynamic") && strcmp(c->sched, "guided")) {
        fprintf(stderr, "Schedule must be static, dynamic or guided\n"); return -1;
    }
    return 0;
}

static void apply_schedule(const Config *c)
{
    omp_sched_t kind = omp_sched_dynamic;
    int chunk = (c->chunk > 0) ? c->chunk : 1;
    if (strcmp(c->sched, "static") == 0) {
        kind = omp_sched_static;
        chunk = (c->chunk > 0) ? c->chunk : 0;   /* 0 = one big block per thread */
    } else if (strcmp(c->sched, "guided") == 0) {
        kind = omp_sched_guided;
    }
    omp_set_schedule(kind, chunk);
}

static const char *base_name(const char *path)
{
    const char *s = path, *p;
    for (p = path; *p; p++)
        if (*p == '/' || *p == '\\') s = p + 1;
    return s;
}

static void print_pairs(const Document *docs, const PairList *l)
{
    size_t limit = l->count < 200 ? l->count : 200;
    printf("\nSimilar pairs (showing %llu of %llu):\n",
           (unsigned long long)limit, (unsigned long long)l->count);
    for (size_t p = 0; p < limit; p++)
        printf("  %.6f  %s  <->  %s\n", l->items[p].sim,
               base_name(docs[l->items[p].i].path), base_name(docs[l->items[p].j].path));
}

static int file_exists(const char *path)
{
    struct stat st;
    return stat(path, &st) == 0;
}

/* ---------------- correctness check ---------------- */

/* Compare two SORTED pair lists. Returns number of problems found. */
static int compare_lists(const char *label, const PairList *a, const PairList *b, double tol)
{
    int problems = 0;
    double max_diff = 0.0;
    if (a->count != b->count) {
        printf("  [FAIL] %s: pair counts differ (%llu vs %llu)\n", label,
               (unsigned long long)a->count, (unsigned long long)b->count);
        return 1;
    }
    for (size_t p = 0; p < a->count; p++) {
        if (a->items[p].i != b->items[p].i || a->items[p].j != b->items[p].j) {
            if (problems < 5)
                printf("  [FAIL] %s: entry %llu is (%d,%d) vs (%d,%d)\n", label,
                       (unsigned long long)p, a->items[p].i, a->items[p].j,
                       b->items[p].i, b->items[p].j);
            problems++;
            continue;
        }
        double d = fabs(a->items[p].sim - b->items[p].sim);
        if (d > max_diff) max_diff = d;
        if (d > tol) problems++;
    }
    printf("  [%s] %s: %llu pairs, max |difference| = %.3e (tolerance %.0e)\n",
           problems ? "FAIL" : "PASS", label, (unsigned long long)a->count, max_diff, tol);
    return problems;
}

/* The list must be exactly (0,1),(0,2),...,(n-2,n-1): no missing, no duplicates. */
static int check_enumeration(const char *label, const PairList *l, int n)
{
    size_t k = 0;
    for (int i = 0; i < n - 1; i++)
        for (int j = i + 1; j < n; j++, k++)
            if (k >= l->count || l->items[k].i != i || l->items[k].j != j) {
                printf("  [FAIL] %s: pair list is not the exact set of all pairs (first problem at (%d,%d))\n",
                       label, i, j);
                return 1;
            }
    if (k != l->count) {
        printf("  [FAIL] %s: extra entries in pair list\n", label);
        return 1;
    }
    printf("  [PASS] %s: contains each of the %llu pairs exactly once\n", label, (unsigned long long)k);
    return 0;
}

static int run_check(const Config *c, const Document *docs, int n)
{
    const double TOL = 1e-12;
    long long expected = (long long)n * (n - 1) / 2;
    int problems = 0;
    CompareResult s_all, p_all, s_thr, p_thr;

    printf("\n=== Correctness check: sequential vs OpenMP (%d threads, schedule %s) ===\n",
           c->threads, c->sched);
    apply_schedule(c);

    /* Threshold 0 keeps EVERY pair, so we can compare all similarity values. */
    compare_sequential(docs, n, 0.0, &s_all);
    compare_parallel(docs, n, 0.0, c->threads, &p_all);
    sort_pairs(&s_all.pairs);
    sort_pairs(&p_all.pairs);

    if (s_all.compared != expected || p_all.compared != expected) {
        printf("  [FAIL] comparison counters: seq=%lld omp=%lld expected=%lld\n",
               s_all.compared, p_all.compared, expected);
        problems++;
    } else {
        printf("  [PASS] both versions compared exactly N(N-1)/2 = %lld pairs\n", expected);
    }
    problems += check_enumeration("sequential", &s_all.pairs, n);
    problems += check_enumeration("openmp", &p_all.pairs, n);
    problems += compare_lists("all similarity values", &s_all.pairs, &p_all.pairs, TOL);

    /* Same again at the user's threshold (this exercises the filtering/merging path). */
    compare_sequential(docs, n, c->threshold, &s_thr);
    compare_parallel(docs, n, c->threshold, c->threads, &p_thr);
    sort_pairs(&s_thr.pairs);
    sort_pairs(&p_thr.pairs);
    char label[64];
    snprintf(label, sizeof label, "pairs with similarity >= %.2f", c->threshold);
    problems += compare_lists(label, &s_thr.pairs, &p_thr.pairs, TOL);

    if (c->print_pairs) print_pairs(docs, &p_all.pairs);

    result_free(&s_all); result_free(&p_all);
    result_free(&s_thr); result_free(&p_thr);

    printf("\nRESULT: %s\n", problems ? "CHECK FAILED" : "CHECK PASSED");
    return problems ? 1 : 0;
}

/* ---------------- main ---------------- */

int main(int argc, char **argv)
{
    Config c;
    if (argc < 2 || strcmp(argv[1], "-h") == 0 || strcmp(argv[1], "--help") == 0) {
        usage(argv[0]);
        return argc < 2 ? 1 : 0;
    }
    if (parse_args(argc, argv, &c) != 0) { usage(argv[0]); return 1; }

    Document *docs = NULL;
    int n = 0;
    LoadStats ls;
    double t_start = omp_get_wtime();
    if (load_documents(c.dir, c.n_docs, c.max_bytes, c.k, &docs, &n, &ls) != 0) return 1;

    if (c.n_docs > 0 && n < c.n_docs)
        printf("Note: only %d documents available (requested %d)\n", n, c.n_docs);
    if (n < 2) {
        fprintf(stderr, "Need at least 2 documents, found %d\n", n);
        free_documents(docs, n);
        return 1;
    }

    unsigned long long total_sh = 0, total_bytes = 0;
    for (int i = 0; i < n; i++) { total_sh += docs[i].n_shingles; total_bytes += docs[i].n_bytes; }
    double avg_sh = (double)total_sh / n;
    long long pairs_total = (long long)n * (n - 1) / 2;

    printf("Input directory     : %s\n", c.dir);
    printf("Documents           : %d\n", n);
    printf("Pairs to compare    : %lld\n", pairs_total);
    printf("Bytes read (total)  : %llu%s\n", total_bytes,
           c.max_bytes ? " (truncated per file)" : "");
    printf("Shingle size (k)    : %d words\n", c.k);
    printf("Avg shingles / doc  : %.1f\n", avg_sh);
    printf("File read time      : %.4f s\n", ls.read_seconds);
    printf("Preprocessing time  : %.4f s\n", ls.preprocess_seconds);
    printf("Threshold           : %.2f\n", c.threshold);

    int rc = 0;
    if (strcmp(c.mode, "check") == 0) {
        rc = run_check(&c, docs, n);
        free_documents(docs, n);
        return rc;
    }

    int is_omp = (strcmp(c.mode, "omp") == 0);
    /* effective chunk size actually used (what we record in the CSV) */
    int eff_chunk = (c.chunk > 0) ? c.chunk : (strcmp(c.sched, "static") == 0 ? 0 : 1);
    if (is_omp) {
        apply_schedule(&c);
        printf("Mode                : OpenMP, %d threads, schedule(%s%s)\n", c.threads, c.sched,
               c.chunk > 0 ? ", chunk given" : "");
        printf("Logical CPUs seen   : %d\n", omp_get_num_procs());
    } else {
        printf("Mode                : sequential\n");
    }

    FILE *csv = NULL;
    if (c.csv) {
        int existed = file_exists(c.csv);
        csv = fopen(c.csv, "a");
        if (!csv) { fprintf(stderr, "Cannot open CSV file %s\n", c.csv); free_documents(docs, n); return 1; }
        if (!existed)
            fprintf(csv, "mode,docs,pairs,max_bytes,k,avg_shingles,threads,schedule,chunk,"
                         "threshold,rep,read_s,preprocess_s,compare_s,similar_pairs\n");
    }

    CompareResult res = {{NULL, 0, 0}, 0};
    for (int w = 0; w < c.warmup; w++) {
        if (is_omp) compare_parallel(docs, n, c.threshold, c.threads, &res);
        else        compare_sequential(docs, n, c.threshold, &res);
        result_free(&res);
    }

    for (int r = 1; r <= c.reps; r++) {
        result_free(&res);
        double t0 = omp_get_wtime();
        if (is_omp) compare_parallel(docs, n, c.threshold, c.threads, &res);
        else        compare_sequential(docs, n, c.threshold, &res);
        double t1 = omp_get_wtime();

        if (res.compared != pairs_total)
            fprintf(stderr, "WARNING: compared %lld pairs, expected %lld\n", res.compared, pairs_total);

        printf("Rep %d: compare time = %.6f s, similar pairs = %llu\n", r, t1 - t0,
               (unsigned long long)res.pairs.count);

        if (csv)
            fprintf(csv, "%s,%d,%lld,%llu,%d,%.1f,%d,%s,%d,%.2f,%d,%.6f,%.6f,%.6f,%llu\n",
                    c.mode, n, pairs_total, (unsigned long long)c.max_bytes, c.k, avg_sh,
                    is_omp ? c.threads : 1, is_omp ? c.sched : "none",
                    is_omp ? eff_chunk : 0, c.threshold, r, ls.read_seconds,
                    ls.preprocess_seconds, t1 - t0, (unsigned long long)res.pairs.count);
    }

    printf("Total program time  : %.4f s (load + compare, all reps)\n", omp_get_wtime() - t_start);

    if (c.print_pairs) {
        sort_pairs(&res.pairs);
        print_pairs(docs, &res.pairs);
    }

    if (csv) fclose(csv);
    result_free(&res);
    free_documents(docs, n);
    return rc;
}
