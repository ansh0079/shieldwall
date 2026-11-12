// A page must show direct buying activity before its domain receives a shop score.
export function isRetailPage(scan) {
  return !!(scan && (scan.isShop || scan.isCheckout || scan.purchaseObserved));
}
