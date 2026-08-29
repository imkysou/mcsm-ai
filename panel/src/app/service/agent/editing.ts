/**
 * opencode-style file editing helpers.
 *
 * The edit corrector follows opencode's tool/edit.ts approach (itself derived
 * from cline + gemini-cli): a chain of replacers tries progressively looser
 * matching (exact -> trimmed lines -> anchored block with similarity ->
 * whitespace/indentation normalized), but every candidate must be UNIQUE in
 * the file, and disproportionate matches are refused - so the model's tiny
 * edit never swallows a huge block. apply_patch mirrors opencode's
 * apply_patch.ts (unified diff, atomic across all files).
 */

/** Small levenshtein distance for block similarity (opencode uses the same). */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[n];
}

function normalizeWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function commonIndent(lines: string[]): number {
  let min = Infinity;
  for (const l of lines) {
    if (!l.trim()) continue;
    const indent = l.length - l.trimStart().length;
    if (indent < min) min = indent;
  }
  return min === Infinity ? 0 : min;
}

/**
 * Locate oldString in content using the replacer chain. Returns exact
 * [start, end) span and line span, or throws a descriptive error.
 */
export function locateEdit(
  content: string,
  oldString: string,
  replaceAll = false
): { start: number; end: number; startLine: number; endLine: number } {
  if (!oldString) throw new Error('old_string cannot be empty when editing an existing file - provide the exact text to replace');
  const candidates: Array<{ start: number; end: number; startLine: number; endLine: number }> = [];

  const pushSpan = (start: number, end: number) => {
    const before = content.slice(0, start);
    const startLine = before.split("\n").length;
    const endLine = startLine + content.slice(start, end).split("\n").length - 1;
    candidates.push({ start, end, startLine, endLine });
  };

  // 1) Simple exact search
  {
    let idx = content.indexOf(oldString);
    while (idx !== -1) {
      pushSpan(idx, idx + oldString.length);
      idx = content.indexOf(oldString, idx + 1);
    }
  }

  if (!candidates.length) {
    // 2) LineTrimmedReplacer: each line matches by trim() only; the exact span
    //    is taken from the ORIGINAL file.
    const originalLines = content.split("\n");
    let searchLines = oldString.split("\n");
    if (searchLines[searchLines.length - 1] === "") searchLines = searchLines.slice(0, -1);
    if (searchLines.length > 0 && searchLines[searchLines.length - 1] === "")
      searchLines = searchLines.slice(0, -1);
    if (searchLines.length) {
      for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
        let ok = true;
        for (let j = 0; j < searchLines.length; j++) {
          if (originalLines[i + j].trim() !== searchLines[j].trim()) {
            ok = false;
            break;
          }
        }
        if (ok) {
          let start = 0;
          for (let k = 0; k < i; k++) start += originalLines[k].length + 1;
          let end = start;
          for (let k = 0; k < searchLines.length; k++) {
            end += originalLines[i + k].length;
            if (k < searchLines.length - 1) end += 1;
          }
          // preserve trailing newline like the search block
          if (oldString.endsWith("\n") && end < content.length && content[end] === "\n") end += 1;
          pushSpan(start, end);
        }
      }
    }
  }

  if (!candidates.length) {
    // 3) WhitespaceNormalizedReplacer: collapse whitespace runs to single spaces.
    const normalized = normalizeWs(content);
    const target = normalizeWs(oldString);
    let idx = normalized.indexOf(target);
    while (idx !== -1) {
      // map normalized index back to original: walk tokens is complex; use a
      // best-effort: find a content span whose normalized text equals target
      // around this offset by scanning windows.
      const win = content.slice(0, Math.min(content.length, idx * 2 + 200));
      const start = Math.max(0, win.lastIndexOf(" "));
      pushSpan(start, Math.min(content.length, start + target.length * 3 + 8));
      idx = normalized.indexOf(target, idx + 1);
    }
  }

  if (!candidates.length) {
    // 4) IndentationFlexible + trimmed boundary: attempt per-line trim with
    //    similarity on the first/last line.
    const originalLines = content.split("\n");
    let searchLines = oldString.split("\n").filter((l, i2, arr) => !(i2 === arr.length - 1 && l === ""));
    if (searchLines.length) {
      const ind = commonIndent(searchLines);
      searchLines = searchLines.map((l) => l.slice(ind));
      for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
        let ok = true;
        for (let j = 0; j < searchLines.length; j++) {
          const ol = originalLines[i + j].trim();
          const sl = searchLines[j].trim();
          if (j === 0 || j === searchLines.length - 1) {
            const dist = levenshtein(ol, sl);
            if (dist > Math.max(1, Math.floor(Math.max(ol.length, sl.length) * 0.2))) {
              ok = false;
              break;
            }
          } else if (ol !== sl) {
            ok = false;
            break;
          }
        }
        if (ok) {
          let start = 0;
          for (let k = 0; k < i; k++) start += originalLines[k].length + 1;
          let end = start;
          for (let k = 0; k < searchLines.length; k++) {
            end += originalLines[i + k].length;
            if (k < searchLines.length - 1) end += 1;
          }
          if (oldString.endsWith("\n") && end < content.length && content[end] === "\n") end += 1;
          pushSpan(start, end);
        }
      }
    }
  }

  if (!candidates.length) {
    throw new Error(
      'Could not find old_string in the file. It must match exactly including whitespace and indentation. Re-read the file (read_file) and copy the exact block.'
    );
  }

  const unique = candidates.filter(
    (c) => c.start === candidates[0].start && c.end === candidates[0].end
  );
  const best = unique.length === candidates.length ? candidates[0] : null;

  if (!best) {
    try {
      // ambiguous: pick the unique one if exactly one span is unique
      const counts = new Map<string, number>();
      for (const c of candidates) {
        const key = c.start + ":" + c.end;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      const singles: typeof candidates = [];
      for (const c of candidates) {
        if (counts.get(c.start + ":" + c.end) === 1) singles.push(c);
      }
      if (singles.length === 1) {
        return replaceAllCandidate(singles[0], candidates, replaceAll, oldString);
      }
    } catch (e) {
      throw e;
    }
    throw new Error(
      'Found multiple matches for old_string. Provide more surrounding context to make the match unique.'
    );
  }

  // disproportionate guard: never replace a much larger span than old_string
  if (best.end - best.start > Math.max(oldString.length * 4, oldString.length + 80)) {
    throw new Error(
      'Refusing replacement because the matched span is much larger than old_string. Re-read the file and provide the full exact old_string for the intended replacement.'
    );
  }
  if (replaceAll && candidates.length > 1) {
    // multiple occurrences: report instead of silently replacing everything
    throw new Error(
      'Found multiple occurrences of old_string. Provide more surrounding context to make the match unique (or set replace_all=true explicitly).'
    );
  }
  return best;
}

function replaceAllCandidate(
  target: { start: number; end: number; startLine: number; endLine: number },
  candidates: Array<{ start: number; end: number; startLine: number; endLine: number }>,
  replaceAll: boolean,
  oldString: string
): { start: number; end: number; startLine: number; endLine: number } {
  if (!replaceAll && candidates.length > 1) {
    throw new Error(
      'Found multiple matches for old_string. Provide more surrounding context to make the match unique.'
    );
  }
  return target;
}


// ---------------------------------------------------------------------------
// Unified diff (apply_patch) - mirrors opencode's apply_patch.ts
// ---------------------------------------------------------------------------

export interface PatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: Array<{ op: " " | "-" | "+"; text: string }>;
}

export interface PatchFile {
  path: string;
  hunks: PatchHunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parse an opencode/SWE-agent style unified diff. */
export function parsePatch(patchText: string): PatchFile[] {
  const text = String(patchText || "").replace(/\r\n/g, "\n");
  const files: PatchFile[] = [];
  let current: PatchFile | null = null;
  let currentHunk: PatchHunk | null = null;

  for (const rawLine of text.split("\n")) {
    if (rawLine.startsWith("*** Update File:") || rawLine.startsWith("*** Begin Patch")) {
      const m = rawLine.match(/^\*\*\* (?:Update File|Begin Patch):?\s*(.*)$/);
      if (rawLine.startsWith("*** Update File:")) {
        if (current) returnInvalid(files, current);
        current = { path: String(m && m[1] ? m[1] : "").trim(), hunks: [] };
        currentHunk = null;
      }
      continue;
    }
    if (rawLine.startsWith("--- ") || rawLine.startsWith("+++ ")) continue;
    if (!current) {
      // legacy unified diff without *** Update File headers: use ---/+++ names
      continue;
    }
    const h = rawLine.match(HUNK_RE);
    if (h) {
      currentHunk = {
        oldStart: Number(h[1]),
        oldLines: h[2] ? Number(h[2]) : 1,
        newStart: Number(h[3]),
        newLines: h[4] ? Number(h[4]) : 1,
        lines: []
      };
      current.hunks.push(currentHunk);
      continue;
    }
    if (currentHunk) {
      const op = rawLine[0] === "+" ? "+" : rawLine[0] === "-" ? "-" : " ";
      if (rawLine.startsWith("\\ No newline")) continue;
      currentHunk.lines.push({ op, text: rawLine.slice(1) });
    }
  }
  if (current) files.push(current);
  if (!files.length) throw new Error("apply_patch: no patch hunks found in the patch text");
  return files;
}

function returnInvalid(files: PatchFile[], current: PatchFile): void {
  if (current.path) files.push(current);
}

/**
 * Apply a parsed patch to file contents. Strict & atomic: every hunk of every
 * file must apply cleanly or nothing is written; errors pin the first bad
 * file/hunk/line.
 */
export function applyPatchToContents(
  contents: Map<string, string>,
  files: PatchFile[]
): { paths: string[]; changed: string[] } {
  const touched: string[] = [];
  const changed: string[] = [];
  for (const file of files) {
    if (!file.hunks.length) continue;
    const key = file.path;
    const source = contents.get(key);
    if (source === undefined) {
      throw new Error(`apply_patch: file "${key}" does not exist`);
    }
    const sourceLines = source.split("\n");
    const outLines: string[] = [];
    let src = 0;
    for (let hi = 0; hi < file.hunks.length; hi++) {
      const hunk = file.hunks[hi];
      const target = (hunk.oldStart || 1) - 1;
      // copy untouched lines up to the hunk
      while (src < target) {
        outLines.push(sourceLines[src]);
        src++;
      }
      // verify hunk context against the file
      let li = hunk.oldLines > 0 ? 0 : 0;
      let cursor = src;
      for (const line of hunk.lines) {
        if (line.op === " ") {
          const actual = sourceLines[cursor];
          if (actual !== line.text) {
            throw new Error(
              `apply_patch: context mismatch in "${key}" hunk ${hi + 1} at line ${cursor + 1}. Expected "${line.text}" got "${actual}". Re-read the file and regenerate the patch.`
            );
          }
          outLines.push(line.text);
          cursor++;
        } else if (line.op === "-") {
          const actual = sourceLines[cursor];
          if (actual !== line.text) {
            throw new Error(
              `apply_patch: removed line mismatch in "${key}" hunk ${hi + 1} at line ${cursor + 1}: expected "${line.text}" got "${actual}".`
            );
          }
          cursor++;
        } else {
          outLines.push(line.text);
        }
      }
      src = cursor;
    }
    while (src < sourceLines.length) {
      outLines.push(sourceLines[src]);
      src++;
    }
    // trailing empty line handling: source always ends with \n split artifact
    let out = outLines.join("\n");
    if (source.endsWith("\n") && !out.endsWith("\n")) out += "\n";
    contents.set(key, out);
    touched.push(key);
    if (out !== source) changed.push(key);
  }
  return { paths: touched, changed };
}
