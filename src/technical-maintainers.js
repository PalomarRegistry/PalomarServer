/**
 * Checked-in authority for Technical Maintainer privileges.
 *
 * GitHub's numeric ids survive login renames. The comments record who each id
 * denoted when it was added, but are deliberately not another authority to
 * synchronize. A deleted account simply cannot complete GitHub sign-in.
 */
const ids = new Set([
  477956, // kim-em
  6530144, // arajasek
  6957313, // birdsnfrogs
  12532110, // jaumededios
  100034030, // mattrobball
]);


/** GitHub's immutable numeric id is authority; the checked-in login is documentation. */
export function isTechnicalMaintainer(principal) {
  return Number.isSafeInteger(principal?.id) && ids.has(principal.id);
}
