export function americanToDecimal(american) {
    if (!american) return null;
    const odd = parseFloat(american);
    if (isNaN(odd)) return null;

    if (odd > 0) {
        return (odd / 100) + 1;
    } else {
        return (100 / Math.abs(odd)) + 1;
    }
}
