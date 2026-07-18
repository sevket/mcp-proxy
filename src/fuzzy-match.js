export function levenshteinDistance(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

// Cap how different a suggestion is allowed to be, relative to the length of
// what was typed, so a completely unrelated tool name never gets suggested
// just because it happens to be the "least wrong" option in the list.
export function closestMatches(target, candidates, limit = 3) {
  const maxDistance = Math.max(3, Math.ceil(target.length / 2));
  return candidates
    .map((name) => ({ name, distance: levenshteinDistance(target, name) }))
    .filter((c) => c.distance <= maxDistance)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit)
    .map((c) => c.name);
}
