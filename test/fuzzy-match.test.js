import { test } from "node:test";
import assert from "node:assert/strict";
import { levenshteinDistance, closestMatches } from "../src/fuzzy-match.js";

test("levenshteinDistance is 0 for identical strings", () => {
  assert.equal(levenshteinDistance("browser_click", "browser_click"), 0);
});

test("levenshteinDistance counts a single substitution", () => {
  assert.equal(levenshteinDistance("cat", "bat"), 1);
});

test("levenshteinDistance counts insertions/deletions", () => {
  assert.equal(levenshteinDistance("cat", "cats"), 1);
  assert.equal(levenshteinDistance("cats", "cat"), 1);
});

test("closestMatches suggests the nearest typo'd name first", () => {
  const candidates = ["browser_click", "browser_navigate", "browser_snapshot"];
  const result = closestMatches("browser_clik", candidates);
  assert.equal(result[0], "browser_click");
});

test("closestMatches returns nothing for a completely unrelated name", () => {
  const candidates = ["browser_click", "browser_navigate"];
  const result = closestMatches("completely_different_tool_name", candidates);
  assert.deepEqual(result, []);
});

test("closestMatches caps the number of suggestions", () => {
  const candidates = ["ab", "ac", "ad", "ae"];
  const result = closestMatches("aa", candidates, 2);
  assert.equal(result.length, 2);
});
