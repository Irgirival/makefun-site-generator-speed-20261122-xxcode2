# Fast makefun-site

[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/Irgirival/makefun-site-generator-speed-20261122-xxcode2/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/Irgirival/makefun-site-generator-speed-20261122-xxcode2/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

A faster drop-in for make.fun's own makefun-site 1.0.0, written for the
[site-generator-speed-01-run-20261122](https://make.fun/bounty/site-generator-speed-01-run-20261122)
bounty. `solve.js` exports `run(input)`, which returns exactly the output
tree makefun-site 1.0.0's `build` returns for one site — every page's
`index.html`, the index and tag pages, `build-report.txt` and each static
file, byte for byte — and `main.ts` is the driver that answers every case
in `/input/cases.json` with it and writes `/output/answers.json`.

How it gets faster, without changing an answer:

- the Markdown inline renderer scans for its special characters instead of
  escaping one character at a time, so runs of plain text are pushed whole;
- blocks render straight into string chunks instead of through token
  objects, and the front matter is scanned by hand;
- slugs and long dates are memoised within a case (nothing is carried from
  one case to the next);
- templates render into one output array, with a for loop's scope mutated
  in place instead of rebuilt for every element.

Pure JavaScript, no dependencies, no I/O: the answer is a function of the
input alone, as the reference's is.
