# Parallel Document Similarity Detection using OpenMP

C + OpenMP project: finds similar English documents using word 3-gram
shingles and Jaccard similarity. Sequential and OpenMP versions.

## Dataset
Zenodo: https://zenodo.org/records/3616683
English documents used from the PAN corpus (folder dataset/pan11/en).
The dataset is not included in this repository. Download it and place
the English files in dataset/pan11/en.

## Build
gcc -O2 -Wall -Wextra -fopenmp src/main.c src/document.c src/similarity.c -lm -o docsim

## Run (Windows Command Prompt)
docsim.exe tests -m check -th 0.5 -p
docsim.exe dataset\pan11\en -m seq -n 200 -r 3
docsim.exe dataset\pan11\en -m omp -n 200 -t 4 -r 3

Options: -m seq|omp|check, -n documents, -t threads, -th threshold,
-s static|dynamic|guided, -c chunk, -b bytes, -r reps, -w warmups, --csv file

## Folders
src/ source code | tests/ small test documents | results/ CSV files and graphs